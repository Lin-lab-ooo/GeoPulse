"""Exploratory second protocol, fixed after seeing cross-mode failure.
No retraining, no test-dependent thresholds. Requires operator-certified normal
first 256 rows. Labels only verify this assumption, never fit the threshold.
"""
import csv, json
import numpy as np
import train
PREFIX=256
START=PREFIX+train.WINDOW
BASE=train.OUT/'base-model.json'
if not BASE.exists(): BASE.write_bytes((train.PUBLIC/'model.json').read_bytes())
model=json.loads(BASE.read_text(encoding='utf8'))
weights=[(np.array(l['weights']).reshape(l['inputSize'],l['outputSize']),np.array(l['bias'])) for l in model['layers']]
normal,times,_=train.read(train.SOURCES[0]); n=int(len(normal)*.6)
mu=np.array(model['normalization']['mean']); sd=np.array(model['normalization']['std'])
x,_=train.windows((normal[:n]-mu)/sd,times[:n]); center=x.mean(0); _,_,vh=np.linalg.svd(x-center,full_matrices=False); pc=vh[:8]
def pca(w): return (((w-center)@pc.T@pc+center)[:,-8:]-w[:,-8:])**2
def energy(w): return w[:,-8:]**2
methods={'mlp_ae_seed_7':lambda w:train.residual(w,weights)[1],'pca8':pca,'standardized_energy':energy}
report={'protocol':{'exploratory':True,'reason':'Protocol added after the first cross-operating-mode failure; not an untouched holdout claim.','prefixRows':PREFIX,'prefixRequirement':'Operator-certified known normal; dataset labels verify assumption only.','normalization':'Each experiment first 256 rows only','threshold':'99th percentile of prefix normal-window scores; fixed, same for AE/PCA/stat','gapRows':train.WINDOW,'evaluationSegmentStartsAt':START,'firstPossibleEvaluationScore':START+train.WINDOW-1,'frozenSeed':7,'weightsRetrained':False,'pointAdjustment':False,'testRetuning':False,'windowGapRule':'same as original protocol'},'byFile':{},'overall':{},'driftDiagnostics':{},'limitations':['This is post-failure exploratory calibration, not new independent validation.','Requires certified normal calibration for each operating regime.','Only one testbed and three predetermined experiments.','All methods share the same prefix and evaluation timestamps.']}
aggregates={k:[] for k in methods}; rows=[]; export=None
for file in train.SOURCES[1:4]:
    raw,timestamps,labels=train.read(file)
    if len(raw)<=START+train.WINDOW or labels[:PREFIX].any():
        report['byFile'][file]={'eligible':False,'reason':'normal-prefix requirement failed'}; continue
    mean=raw[:PREFIX].mean(0); std=np.maximum(raw[:PREFIX].std(0),1e-8); z=(raw-mean)/std
    cal,calidx=train.windows(z[:PREFIX],timestamps[:PREFIX]); test,idx=train.windows(z[START:],timestamps[START:]); idx+=START
    if not len(cal) or not len(test):
        report['byFile'][file]={'eligible':False,'reason':'no gap-safe calibration/evaluation windows'}; continue
    report['driftDiagnostics'][file]={'meanShiftInTrainingStd':((mean-mu)/sd).tolist(),'prefixStdOverTrainStd':(std/sd).tolist()}
    stats={}
    for name,fn in methods.items():
        threshold=float(np.quantile(fn(cal).mean(1),.99)); scores=fn(test).mean(1)
        stats[name]=train.metrics(labels[idx],scores,threshold)
        aggregates[name].append((labels[idx],scores,threshold))
        rows.extend({'method':name,'experiment':file,'index':int(i),'timestamp':timestamps[i],'label':int(labels[i]),'score':float(s),'threshold':threshold,'prediction':int(s>threshold)} for i,s in zip(idx,scores))
    report['byFile'][file]={'eligible':True,'calibrationWindows':len(cal),'evaluationWindows':len(test),'firstAnomalyIndex':int(np.flatnonzero(labels)[0]),'methods':stats}
    if file==train.SOURCES[1]: export=(raw,timestamps,labels,test,idx,mean,std,stats['mlp_ae_seed_7']['threshold'])
for name,parts in aggregates.items():
    y=np.concatenate([p[0] for p in parts]); ratio=np.concatenate([p[1]/p[2] for p in parts]); report['overall'][name]=train.metrics(y,ratio,1)
    report['overall'][name]['scoreForAggregateAP']='score / experiment-specific normal calibration threshold'
train.dump(train.OUT/'exploratory-calibration.json',report)
with (train.OUT/'exploratory-predictions.csv').open('w',newline='',encoding='utf8') as f:
    writer=csv.DictWriter(f,fieldnames=list(rows[0])); writer.writeheader(); writer.writerows(rows)
print(json.dumps(report),flush=True)
# Export the exploratory candidate for this one explicit replay only. The frozen
# base model and first evaluation remain intact; this is not a reliability claim.
raw,timestamps,labels,test,idx,mean,std,threshold=export
model['normalization']={'mean':mean.tolist(),'std':std.tolist()}
model['threshold']=threshold
model['experimental']=True
model['calibration']={'experiment':train.SOURCES[1],'prefixRows':PREFIX,'evaluationSegmentStartsAt':START,'firstPossibleEvaluationScore':START+train.WINDOW-1,'operatorRequirement':'Initial 256 readings must be certified normal.','exploratory':True}
model['evaluation']={'protocol':'Post-failure exploratory per-experiment normal-prefix calibration; not a new untouched holdout','overall':report['overall']['mlp_ae_seed_7'],'experiment':report['byFile'][train.SOURCES[1]]['methods']['mlp_ae_seed_7'],'initialCrossModeFalsePositiveRate':1.0,'reliableAlarm':False,'comparison':'F1 slightly exceeds standardized energy; AP is lower; false positives remain high.'}
model['evaluation']['baselines']={'pca':report['overall']['pca8'],'statistical':report['overall']['standardized_energy']}
initial=json.loads((train.OUT/'evaluation.json').read_text(encoding='utf8'))
model['evaluation']['initialCrossMode']={'seeds':[{'seed':run['seed'],**run['overall']} for run in initial['runs']],'pca':initial['baselines']['pca8']['overall'],'statistical':initial['baselines']['train_standardized_energy']['overall']}
for metric in [model['evaluation']['overall'],model['evaluation']['experiment'],*model['evaluation']['baselines'].values()]:
    metric['ap']=metric['averagePrecision']
train.dump(train.PUBLIC/'model.json',model)
fixtures=[]
for j in [0,len(test)//2,len(test)-1]:
    i=int(idx[j]); score,per=train.residual(test[j:j+1],weights)
    fixtures.append({'readings':raw[i-train.WINDOW+1:i+1].tolist(),'score':float(score[0]),'channelResiduals':per[0].tolist()})
train.dump(train.OUT/'parity-fixtures.json',{'source':'Python float64 NumPy, frozen seed 7 with explicitly exploratory replay-prefix normalization','fixtures':fixtures})
