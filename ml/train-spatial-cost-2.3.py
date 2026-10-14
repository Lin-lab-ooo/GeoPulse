"""Train CPU-only spatial cost advisors on complete workload splits.
No download, production policy change, or random slice train/test split.
"""
import os
os.environ.setdefault('OPENBLAS_NUM_THREADS','1')
os.environ.setdefault('OMP_NUM_THREADS','1')
import argparse,json,hashlib,time,sys
from pathlib import Path
from datetime import datetime,timezone
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
def write(p,o):p.write_text(json.dumps(o,ensure_ascii=False,indent=2,allow_nan=False)+'\n',encoding='utf-8')
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def milliseconds(z,mean,std):return np.maximum(0,np.expm1(np.clip(z*std+mean,-20,20)))
def scores(actual,pred):
 d=np.abs(actual-pred)
 return {'rows':len(actual),'maeMs':float(d.mean()),'medianAbsoluteErrorMs':float(np.median(d)),'p95AbsoluteErrorMs':float(np.quantile(d,.95)), 'meanActualMs':float(actual.mean()),'relativeMedianError':float(np.median(d/np.maximum(actual,.0001)))}
def net(x,w):
 z1=x@w['w1']+w['b1'];a1=np.maximum(z1,0);z2=a1@w['w2']+w['b2'];a2=np.maximum(z2,0);out=a2@w['w3']+w['b3']
 return out,(z1,a1,z2,a2)
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--report',default='reports/spatial-cost-2.3.json');ap.add_argument('--epochs',type=int,default=70);ap.add_argument('--seed',type=int,default=20261013);a=ap.parse_args()
 inp=ROOT/a.report;rows_path=inp.with_suffix('.jsonl');outp=ROOT/'ml/spatial-cost-advisor-2.3.json';reportp=ROOT/'reports/spatial-cost-training-2.3.json'
 if outp.exists() or reportp.exists():raise RuntimeError('Refusing to overwrite training evidence')
 report=json.loads(inp.read_text(encoding='utf-8'));items=[];metadata=None
 with rows_path.open(encoding='utf-8') as f:
  for line in f:
   x=json.loads(line)
   if x.get('type')=='metadata':metadata=x
   elif x.get('type')=='slice':items.append(x)
 assert metadata is not None and len(items)>0
 actions=[32,64,128,256];names=['primitiveSize','indexedPrimitives','remainingPrimitives','pagePrimitives','nodes','leaves','emaMsPerPrimitive','lastSliceMs','centroidAnisotropy','occupiedCellRatio','bboxSpan','meanAdjacentDistance']
 X=np.array([x['features']+ [1.0 if x['action']==v else 0.0 for v in actions] for x in items],dtype=np.float64);Y=np.array([x['cpuMs'] for x in items],dtype=np.float64)
 assert X.shape[1]==16 and np.isfinite(X).all() and np.isfinite(Y).all() and np.all(Y>=0)
 splits=np.array([x['split'] for x in items]);train=splits=='train';val=splits=='validation';test=np.char.startswith(splits.astype(str),'test')
 assert train.any() and val.any() and test.any()
 groups={name:sorted(set(items[i]['workloadId'] for i in np.flatnonzero(mask))) for name,mask in [('train',train),('validation',val),('test',test)]}
 assert not(set(groups['train'])&set(groups['validation'])) and not(set(groups['train'])&set(groups['test'])) and not(set(groups['validation'])&set(groups['test']))
 mean=X[train].mean(0);std=np.maximum(X[train].std(0),1e-8);Z=np.clip((X-mean)/std,-16,16).astype(np.float32);logy=np.log1p(Y);ym=float(logy[train].mean());ys=max(float(logy[train].std()),1e-8);target=((logy-ym)/ys).astype(np.float32)
 xt=Z[train];yt=target[train];xv=Z[val];yv=target[val];rng=np.random.default_rng(a.seed);start=time.perf_counter()
 # Ridge regularization is selected on validation only.
 fitX=np.column_stack([np.ones(len(xt)),xt]).astype(np.float64);vx=np.column_stack([np.ones(len(xv)),xv]).astype(np.float64);ridge_grid=[];ridge_best=None
 for lam in [.01,.1,1.,10.,100.]:
  penalty=np.eye(17)*lam;penalty[0,0]=0;coef=np.linalg.solve(fitX.T@fitX+penalty,fitX.T@yt)
  m=scores(Y[val],milliseconds(vx@coef,ym,ys));ridge_grid.append({'lambda':lam,**m})
  if ridge_best is None or m['maeMs']<ridge_best[0]:ridge_best=(m['maeMs'],lam,coef)
 coef=ridge_best[2];ridge_margin=max(0,float(np.quantile(logy[val]-(vx@coef*ys+ym),.9)))
 # Two heads: robust location and P90 quantile of the same slice CPU target.
 w={'w1':(rng.normal(size=(16,16))*np.sqrt(2/16)).astype(np.float32),'b1':np.zeros(16,dtype=np.float32),'w2':(rng.normal(size=(16,8))*np.sqrt(2/16)).astype(np.float32),'b2':np.zeros(8,dtype=np.float32),'w3':(rng.normal(size=(8,2))*.05).astype(np.float32),'b3':np.array([0,.8],dtype=np.float32)}
 moment={k:np.zeros_like(v) for k,v in w.items()};velocity={k:np.zeros_like(v) for k,v in w.items()};step=0;history=[];best=None;patience=0;batch=256
 # Each workload/action/repeat receives equal aggregate weight, irrespective of slice count.
 tritems=[items[i] for i in np.flatnonzero(train)];keys=[(x['workloadId'],x['action'],x['repeat']) for x in tritems];counts={}
 for k in keys:counts[k]=counts.get(k,0)+1
 sampleweight=np.array([len(keys)/(len(counts)*counts[k]) for k in keys],dtype=np.float32)
 for epoch in range(a.epochs):
  permutation=rng.permutation(len(xt))
  for lo in range(0,len(xt),batch):
   ix=permutation[lo:lo+batch];xb=xt[ix];yb=yt[ix];weights=sampleweight[ix];pred,cache=net(xb,w);z1,a1,z2,a2=cache
   grad=np.empty_like(pred);grad[:,0]=np.clip(pred[:,0]-yb,-1,1);res=yb-pred[:,1];grad[:,1]=.25*np.where(res>=0,-.9,.1);grad*=weights[:,None]/len(ix)
   g={'w3':a2.T@grad+1e-5*w['w3'],'b3':grad.sum(0)};h=(grad@w['w3'].T)*(z2>0);g['w2']=a1.T@h+1e-5*w['w2'];g['b2']=h.sum(0);h=(h@w['w2'].T)*(z1>0);g['w1']=xb.T@h+1e-5*w['w1'];g['b1']=h.sum(0)
   norm=np.sqrt(sum(float(np.sum(v*v)) for v in g.values()));clip=min(1,5/max(norm,1e-12));step+=1
   for k in w:
    gg=g[k]*clip;moment[k]=.9*moment[k]+.1*gg;velocity[k]=.999*velocity[k]+.001*gg*gg;w[k]-=.001*(moment[k]/(1-.9**step))/(np.sqrt(velocity[k]/(1-.999**step))+1e-8)
  pv,_=net(xv,w);metrics=scores(Y[val],milliseconds(pv[:,0],ym,ys));qpred=milliseconds(pv[:,1],ym,ys);coverage=float(np.mean(Y[val]<=qpred));history.append({'epoch':epoch+1,**metrics,'p90Coverage':coverage})
  if best is None or metrics['maeMs']<best[0]:best=(metrics['maeMs'],epoch+1,{k:v.copy() for k,v in w.items()});patience=0
  else:patience+=1
  if epoch%10==0:print(json.dumps({'epoch':epoch+1,'validationMAEms':metrics['maeMs'],'coverage':coverage}),flush=True)
  if patience>=12:break
 w=best[2];allp,_=net(Z,w);mlp_margin=max(0,float(np.quantile(logy[val]-(allp[val,0]*ys+ym),.9)))
 allridge=np.column_stack([np.ones(len(Z)),Z])@coef
 evaluations={}
 for name,mask in [('train',train),('validation',val),('test-held-out-distribution',splits=='test-held-out-distribution'),('test-large',splits=='test-large')]:
  if not mask.any():continue
  ema=X[mask,6]*np.array([items[i]['action'] for i in np.flatnonzero(mask)])
  evaluations[name]={'ridge':scores(Y[mask],milliseconds(allridge[mask],ym,ys)),'mlp':scores(Y[mask],milliseconds(allp[mask,0],ym,ys)),'ema':scores(Y[mask],ema),'mlpQuantileCoverage':float(np.mean(Y[mask]<=milliseconds(allp[mask,1],ym,ys)))}
 # Fixed baseline hyperparameter from complete validation runs; no test selection.
 runs=report['runs'];validation_ids=set(groups['validation']);fixed=[]
 for action in actions:
  rr=[r for r in runs if r['workloadId'] in validation_ids and r['action']==action]
  by={}
  for r in rr:by.setdefault(r['workloadId'],[]).append(r.get('totalCpuMs',r.get('appendCpuMs',0)))
  fixed.append({'action':action,'meanPerWorkloadCpuMs':float(np.mean([np.mean(v) for v in by.values()])),'runs':len(rr)})
 chosen=min(fixed,key=lambda x:x['meanPerWorkloadCpuMs'])['action']
 model={'schemaVersion':'1.0','version':'2.3','scope':'CPU-only index-slice research; no renderer/model default changed','seed':a.seed,'featureNames':names,'actions':actions,'inputMean':mean.tolist(),'inputStd':std.tolist(),'targetLogMean':ym,'targetLogStd':ys,'ridge':{'lambda':ridge_best[1],'coefficients':coef.tolist(),'validationLogMarginP90':ridge_margin},'mlp':{'shape':[16,16,8,2],'parameterCount':sum(v.size for v in w.values()),'heads':['huber-location-log1p-cpu','pinball-p90-log1p-cpu'],'bestEpoch':best[1],'validationLogMarginP90':mlp_margin,'weights':{k:{'shape':list(v.shape),'values':v.ravel().tolist()} for k,v in w.items()}},'chosenFixedAction':chosen,'gates':{'minimumPagePrimitives':1024,'maximumAbsoluteFeatureZ':6,'fallbackAction':128},'trainingSource':{'dataset':a.report,'datasetSha256':sha(inp),'rowsPath':str(rows_path.relative_to(ROOT)).replace('\\','/'),'rowsSha256':sha(rows_path),'trainerSha256':sha(Path(__file__))},'splits':groups}
 write(outp,model)
 evidence={'version':'2.3','createdAt':datetime.now(timezone.utc).isoformat(),'numpyVersion':np.__version__,'pythonVersion':sys.version.split()[0],'seed':a.seed,'scope':'Supervised held-out slice-cost prediction; prediction accuracy alone is not net acceleration','inputRows':len(items),'splitRows':{k:int((splits==k).sum()) for k in sorted(set(splits))},'groups':groups,'normalizationFitOn':'train only','testUsedForSelection':False,'trainingWallSeconds':time.perf_counter()-start,'ridgeValidationGrid':ridge_grid,'mlpHistory':history,'evaluations':evaluations,'fixedValidationCandidates':fixed,'chosenFixedAction':chosen,'modelPath':str(outp.relative_to(ROOT)).replace('\\','/'),'modelSha256':sha(outp),'weightsBytesOnly':model['mlp']['parameterCount']*4,'source':model['trainingSource']}
 write(reportp,evidence);print(json.dumps({'model':str(outp),'parameterCount':model['mlp']['parameterCount'],'rows':len(items),'evaluations':evaluations},ensure_ascii=False),flush=True)
if __name__=='__main__':main()
