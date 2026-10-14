"""Reproducible small SKAB experiment: NumPy MLP autoencoder, no GPU required.
Run: python ml/train.py. Downloads only pinned source files when missing.
Test files are fixed before training. No test-set threshold or seed selection.
"""
import os
os.environ.setdefault('OPENBLAS_NUM_THREADS', '1')
os.environ.setdefault('OMP_NUM_THREADS', '1')
import csv, hashlib, json, time, urllib.request
from pathlib import Path
from datetime import datetime, timezone
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'ml'; DATA=OUT/'data'; PUBLIC=ROOT/'public'/'ai'
DATA.mkdir(exist_ok=True); PUBLIC.mkdir(exist_ok=True)
CHANNELS=['Accelerometer1RMS','Accelerometer2RMS','Current','Pressure','Temperature','Thermocouple','Voltage','Volume Flow RateRMS']
WINDOW=16; SEEDS=[7,19,41]; EPOCHS=30; BATCH=128; QUANTILE=.99
SOURCES=['data/anomaly-free/anomaly-free.csv','data/valve1/1.csv','data/valve2/1.csv','data/other/1.csv','LICENSE']
# Source bytes and hashes are retained; subsequent runs consume these exact bytes.
BASE='https://raw.githubusercontent.com/waico/SKAB/master/'
def dump(path,obj): path.write_text(json.dumps(obj,ensure_ascii=False,separators=(',',':'),allow_nan=False),encoding='utf8')
def download():
    manifest=[]
    previous=json.loads((OUT/'sources.json').read_text(encoding='utf8')) if (OUT/'sources.json').exists() else None
    expected={item['upstreamPath']:item['sha256'] for item in previous['files']} if previous else {}
    for name in SOURCES:
        dest=DATA/(name.replace('/','__') if name!='LICENSE' else 'LICENSE-SKAB-GPL-3.0.txt')
        if not dest.exists():
            req=urllib.request.Request(BASE+name,headers={'User-Agent':'GeoPulse-reproducible-experiment'})
            with urllib.request.urlopen(req,timeout=60) as r: dest.write_bytes(r.read())
        digest=hashlib.sha256(dest.read_bytes()).hexdigest()
        if name in expected and digest!=expected[name]: raise ValueError('Source hash changed: '+name)
        manifest.append({'path':str(dest.relative_to(ROOT)).replace('\\','/'),'upstreamPath':name,'url':BASE+name,'sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),'bytes':dest.stat().st_size})
    dump(OUT/'sources.json',{'repository':'https://github.com/waico/SKAB','retrievedAt':previous['retrievedAt'] if previous else datetime.now(timezone.utc).isoformat(),'license':'GPL-3.0, upstream LICENSE preserved separately','files':manifest})
    return manifest

def read(name):
    p=DATA/name.replace('/','__')
    with p.open(encoding='utf-8-sig') as f: rows=list(csv.DictReader(f,delimiter=';'))
    x=np.array([[float(r[k]) for k in CHANNELS] for r in rows],dtype=np.float64)
    times=[r['datetime'] for r in rows]
    labels=np.array([int(float(r.get('anomaly',0))) for r in rows])
    assert np.isfinite(x).all()
    return x,times,labels

def windows(x,times):
    ts=np.array([datetime.fromisoformat(t).timestamp() for t in times]); delta=np.diff(ts)
    positive=delta[delta>0]; step=float(np.median(positive)) if len(positive) else 1
    result=[]; indices=[]
    for i in range(WINDOW-1,len(x)):
        gaps=delta[i-WINDOW+1:i]
        if np.any(gaps<=0) or np.any(gaps>step*1.5): continue
        result.append(x[i-WINDOW+1:i+1].reshape(-1)); indices.append(i)
    return np.array(result),np.array(indices,dtype=int)

def forward(x,weights):
    activations=[x]
    for i,(w,b) in enumerate(weights):
        z=activations[-1]@w+b
        activations.append(np.tanh(z) if i<len(weights)-1 else z)
    return activations

def residual(x,weights):
    output=forward(x,weights)[-1]
    per=(output[:,-8:]-x[:,-8:])**2
    return per.mean(axis=1),per

def train(x,val,seed):
    rng=np.random.default_rng(seed); dims=[WINDOW*8,32,8,32,WINDOW*8]
    weights=[(rng.normal(0,np.sqrt(2/(a+b)),(a,b)),np.zeros(b)) for a,b in zip(dims[:-1],dims[1:])]
    m=[(np.zeros_like(w),np.zeros_like(b)) for w,b in weights]; v=[(np.zeros_like(w),np.zeros_like(b)) for w,b in weights]
    history=[]; best=float('inf'); best_weights=None; patience=0; step=0
    started=time.perf_counter()
    for epoch in range(EPOCHS):
        order=rng.permutation(len(x))
        for start in range(0,len(x),BATCH):
            xb=x[order[start:start+BATCH]]; a=forward(xb,weights); grad=2*(a[-1]-xb)/xb.size; grads=[]
            for j in reversed(range(len(weights))):
                if j<len(weights)-1: grad=grad*(1-a[j+1]**2)
                grads.append((a[j].T@grad,grad.sum(axis=0))); grad=grad@weights[j][0].T
            step+=1
            for j,(gw,gb) in enumerate(reversed(grads)):
                for p,g,mm,vv in zip(weights[j],(gw,gb),m[j],v[j]):
                    mm[:]=.9*mm+.1*g; vv[:]=.999*vv+.001*g*g
                    p[:]-=.001*(mm/(1-.9**step))/(np.sqrt(vv/(1-.999**step))+1e-8)
        tl=float(np.mean((forward(x,weights)[-1]-x)**2)); vl=float(np.mean((forward(val,weights)[-1]-val)**2))
        history.append({'epoch':epoch+1,'trainingMSE':tl,'validationMSE':vl})
        if vl<best-1e-6: best=vl; best_weights=[(w.copy(),b.copy()) for w,b in weights]; patience=0
        else: patience+=1
        if patience>=5: break
    return best_weights,history,time.perf_counter()-started

def metrics(y,scores,threshold):
    pred=scores>threshold; tp=int(np.sum(pred&(y==1))); fp=int(np.sum(pred&(y==0))); fn=int(np.sum(~pred&(y==1))); tn=int(np.sum(~pred&(y==0)))
    p=tp/(tp+fp) if tp+fp else 0; r=tp/(tp+fn) if tp+fn else 0
    # Average precision groups identical score values before integrating recall.
    order=np.argsort(-scores,kind='stable'); ys=y[order]; ss=scores[order]
    end=np.r_[np.flatnonzero(np.diff(ss)),len(ss)-1]; cum=np.cumsum(ys)[end]; rec=cum/max(1,int(y.sum())); prec=cum/(end+1)
    ap=float(np.sum(np.diff(np.r_[0,rec])*prec))
    return {'samples':len(y),'positives':int(y.sum()),'tp':tp,'fp':fp,'fn':fn,'tn':tn,'precision':p,'recall':r,'f1':2*p*r/(p+r) if p+r else 0,'averagePrecision':ap,'threshold':float(threshold),'falsePositiveRate':fp/(fp+tn) if fp+tn else 0}

def main():
    sources=download(); normal,nt,nlabels=read(SOURCES[0]); assert not nlabels.any()
    n=len(normal); cut1=int(n*.6); cut2=int(n*.8)
    sections={'train':(0,cut1),'earlyStop':(cut1+WINDOW,cut2),'calibration':(cut2+WINDOW,n)}
    mean=normal[:cut1].mean(axis=0); std=normal[:cut1].std(axis=0); std=np.maximum(std,1e-8)
    z=(normal-mean)/std
    split={k:windows(z[a:b],nt[a:b])[0] for k,(a,b) in sections.items()}
    assert all(len(v)>50 for v in split.values())
    tests=[]
    for name in SOURCES[1:4]:
        values,timestamps,labels=read(name); w,idx=windows((values-mean)/std,timestamps)
        tests.append((name,values,timestamps,labels,w,idx))
    report={'name':'SKAB window MLP autoencoder pilot','architecture':[128,32,8,32,128],'activation':'tanh hidden / linear output','windowSize':WINDOW,'channels':CHANNELS,'parameterCount':sum(a*b+b for a,b in zip([128,32,8,32],[32,8,32,128])),'protocol':{'normalOnlyTraining':True,'normalization':'training rows only','splitRows':sections,'windowCounts':{k:len(v) for k,v in split.items()},'gapRows':WINDOW,'windowGapRule':'skip non-increasing times or gaps >1.5 * file median positive interval','threshold':'99th percentile of held-out normal calibration scores; same rule for every detector','earlyStop':'different normal validation segment, patience 5, max 30 epochs','testFiles':SOURCES[1:4],'testTuning':False,'pointAdjustment':False,'deployedSeed':7,'seedSelection':'first predetermined seed, not selected using test results','score':'mean squared normalized reconstruction error over final timestamp only','initialWindow':'first 15 samples have no score and are excluded for all methods'},'runs':[],'baselines':{},'limitations':['Small single-testbed pilot; three test experiments, not a production generalization claim.','No fault-cause or failure-prediction claim.','Map coordinates are demonstration mapping, absent from source data.','Normal operating-mode drift may trigger false alarms.','Benchmark label is used only for evaluation, never inference.']}
    # PCA has the same history input and an 8-dimensional bottleneck.
    xc=split['train'].mean(axis=0); _,_,vh=np.linalg.svd(split['train']-xc,full_matrices=False); components=vh[:8]
    def pca(w):
        rec=(w-xc)@components.T@components+xc
        return ((rec[:,-8:]-w[:,-8:])**2).mean(axis=1)
    def stat(w): return (w[:,-8:]**2).mean(axis=1)
    predictions=[]
    for name,fn in [('pca8',pca),('train_standardized_energy',stat)]:
        threshold=float(np.quantile(fn(split['calibration']),QUANTILE)); ys=[]; scores=[]; perfile={}
        for file,values,timestamps,labels,w,idx in tests:
            score=fn(w); perfile[file]=metrics(labels[idx],score,threshold); ys.extend(labels[idx]); scores.extend(score)
            predictions.extend({'method':name,'file':file,'index':int(i),'timestamp':timestamps[i],'label':int(labels[i]),'score':float(s),'threshold':threshold,'prediction':int(s>threshold)} for i,s in zip(idx,score))
        report['baselines'][name]={'overall':metrics(np.array(ys),np.array(scores),threshold),'byFile':perfile}
    for seed in SEEDS:
        weights,history,seconds=train(split['train'],split['earlyStop'],seed)
        threshold=float(np.quantile(residual(split['calibration'],weights)[0],QUANTILE)); ys=[]; scores=[]; perfile={}
        for file,values,timestamps,labels,w,idx in tests:
            score,per=residual(w,weights); perfile[file]=metrics(labels[idx],score,threshold); ys.extend(labels[idx]); scores.extend(score)
            predictions.extend({'method':'mlp_ae_seed_'+str(seed),'file':file,'index':int(i),'timestamp':timestamps[i],'label':int(labels[i]),'score':float(s),'threshold':threshold,'prediction':int(s>threshold)} for i,s in zip(idx,score))
        result={'seed':seed,'trainingSeconds':seconds,'epochs':len(history),'history':history,'overall':metrics(np.array(ys),np.array(scores),threshold),'byFile':perfile}
        report['runs'].append(result)
        if seed==7:
            model={'schemaVersion':1,'name':'SKAB window MLP autoencoder (NumPy)','windowSize':WINDOW,'channels':CHANNELS,'threshold':threshold,'seed':seed,'normalization':{'mean':mean.tolist(),'std':std.tolist()},'layers':[{'inputSize':w.shape[0],'outputSize':w.shape[1],'activation':'tanh' if i<3 else 'linear','weights':w.reshape(-1).tolist(),'bias':b.tolist()} for i,(w,b) in enumerate(weights)],'score':'last-step normalized squared reconstruction error, mean over 8 channels','source':'https://github.com/waico/SKAB','evaluation':'ml/evaluation.json','interpretation':'Reconstruction residual is not a diagnosis of failure cause.'}
            dump(PUBLIC/'model.json',model)
            file,values,timestamps,labels,w,idx=tests[0]
            source=next(s for s in sources if s['upstreamPath']==file)
            dump(PUBLIC/'replay.json',{'schemaVersion':1,'source':{'dataset':'SKAB','experiment':file,'url':source['url'],'sha256':source['sha256'],'license':'GPL-3.0','licenseUrl':'/ai/LICENSE-SKAB-GPL-3.0.txt','coordinates':'Not supplied by dataset; any map location is an explicit demonstration mapping.'},'channels':CHANNELS,'samples':[{'timestamp':ts,'readings':v.tolist(),'groundTruth':int(y)} for ts,v,y in zip(timestamps,values,labels)]})
            fixtures=[]
            for j in [0,len(w)//2,len(w)-1]:
                i=int(idx[j]); score,per=residual(w[j:j+1],weights)
                fixtures.append({'readings':values[i-WINDOW+1:i+1].tolist(),'score':float(score[0]),'channelResiduals':per[0].tolist()})
            dump(OUT/'parity-fixtures.json',{'source':'Python float64 NumPy forward pass of deployed seed 7','fixtures':fixtures})
        print(json.dumps({'seed':seed,'seconds':seconds,'overall':result['overall']}),flush=True)
    dump(OUT/'evaluation.json',report)
    with (OUT/'predictions.csv').open('w',newline='',encoding='utf8') as f:
        writer=csv.DictWriter(f,fieldnames=list(predictions[0])); writer.writeheader(); writer.writerows(predictions)
    (PUBLIC/'LICENSE-SKAB-GPL-3.0.txt').write_bytes((DATA/'LICENSE-SKAB-GPL-3.0.txt').read_bytes())
    (DATA/'NOTICE.txt').write_text('SKAB data by Iurii Katser and Vyacheslav Kozitsin (upstream waico/SKAB). Upstream GPL-3.0 license is preserved in LICENSE-SKAB-GPL-3.0.txt. CSV source bytes are unmodified. See ../sources.json for exact source URLs and SHA-256. public/ai/replay.json reformats the first valve1 experiment to JSON; no values or labels changed. Separate third-party data license; no assertion that project source licensing overrides it.\n',encoding='utf8')
    (PUBLIC/'NOTICE.txt').write_text((DATA/'NOTICE.txt').read_text(encoding='utf8'),encoding='utf8')
    print(json.dumps({'baselines':report['baselines'],'modelBytes':(PUBLIC/'model.json').stat().st_size}),flush=True)
if __name__=='__main__': main()
