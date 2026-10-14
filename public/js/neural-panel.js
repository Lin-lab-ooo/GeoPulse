import {generateRecords} from './data.js';

const channelLabels = {
  Accelerometer1RMS:'振动 1 · g', Accelerometer2RMS:'振动 2 · g', Current:'电流 · A',
  Pressure:'压力 · bar', Temperature:'电机温度 · °C', Thermocouple:'流体温度 · °C',
  Voltage:'电压 · V', RateRMS:'流量 · L/min'
};
const number = value => Number.isFinite(value) ? value.toFixed(3) : '—';

/** The inference worker and subscribed colour updates are independent of geometry streaming. */
export function initNeuralPanel({getRenderer,getLoadedConfig,isBusy,onShowMap}) {
  const $=id=>document.getElementById(id);
  let worker=null, current=null, serial=0, raf=0, updatePending=false;
  const set=(id,value)=>{$(id).textContent=value;};
  function status(label,state='') { set('neural-status',label);$('neural-status').dataset.state=state; }
  function finish(label='回放已停止') {
    if(current) { current.finished=true;current.endedAt=new Date().toISOString(); }
    worker?.terminate();worker=null;cancelAnimationFrame(raf);raf=0;
    $('neural-start').disabled=false;$('neural-stop').disabled=true;status(label);
  }
  function stop() { if(worker)finish(); }
  function sampleFrame(at) {
    if(!worker||!current)return;
    if(current.lastFrame!==null&&current.frames.length<20000)current.frames.push(at-current.lastFrame);
    current.lastFrame=at;raf=requestAnimationFrame(sampleFrame);
  }
  function drawChannels(sample) {
    const fragment=document.createDocumentFragment();
    current.channels.forEach((name,index)=>{
      const item=document.createElement('div');item.className='neural-channel';
      const label=document.createElement('span'),value=document.createElement('strong'),residual=document.createElement('small');
      label.textContent=channelLabels[name]||name;value.textContent=number(sample.readings[index]);
      residual.textContent='重建残差 '+number(sample.channelResiduals?.[index]);
      item.append(label,value,residual);fragment.append(item);
    });$('neural-channels').replaceChildren(fragment);
  }
  function drawEvaluation(evaluation) {
    if(!evaluation)return;
    const percent=value=>Number.isFinite(value)?(value*100).toFixed(1)+'%':'—';
    const overall=evaluation.overall;
    set('neural-evaluation',`实验候选：初始跨工况测试曾全部告警。固定 256 条正常前缀校准后，总体误报率 ${percent(overall.falsePositiveRate)}，仍不能作为可靠故障告警。每次部署需要确认校准期确为正常；本次校准是失败后的探索试验。`);
    const table=document.createElement('table'),caption=document.createElement('caption');
    caption.textContent='三个真实实验的固定校准对照 · 不作整段标签修正';table.append(caption);
    const head=document.createElement('tr');['方法','Precision','Recall','F1','AP','误报率'].forEach(label=>{const th=document.createElement('th');th.textContent=label;head.append(th);});table.append(head);
    for(const [name,metrics] of [['窗口自编码器',overall],['PCA',evaluation.baselines?.pca],['统计能量',evaluation.baselines?.statistical]]) {
      if(!metrics)continue;
      const row=document.createElement('tr');[name,percent(metrics.precision),percent(metrics.recall),number(metrics.f1),number(metrics.ap??metrics.averagePrecision),percent(metrics.falsePositiveRate)].forEach(value=>{const td=document.createElement('td');td.textContent=value;row.append(td);});table.append(row);
    }$('neural-comparison').replaceChildren(table);
  }
  async function applySample(sample,session) {
    if(current!==session||session.finished)return;
    set('neural-score',number(sample.score)+' / '+number(sample.threshold));
    set('neural-latency',number(sample.latencyMs)+' ms');set('neural-time',sample.timestamp);
    set('neural-progress',`实验 ${session.experiment} · 源样本 ${sample.index+1} / ${session.total} · 评价标注：${sample.groundTruth===1?'异常':'正常'}`);
    status(sample.status==='anomaly'?'高于模型阈值':sample.status==='warming'?'时间窗预热':'低于模型阈值',sample.status);
    drawChannels(sample);
    if(session.samples.length<4096)session.samples.push({index:sample.index,timestamp:sample.timestamp,score:sample.score,threshold:sample.threshold,status:sample.status,groundTruth:sample.groundTruth,inferenceMs:sample.latencyMs,channelResiduals:sample.channelResiduals});
    if(sample.status==='warming')return;
    // One colour commit in flight. A slow map skips newer updates instead of building a queue.
    if(updatePending){session.skippedColourUpdates++;return;}
    if(sample.status===session.lastColourStatus)return;
    updatePending=true;
    const began=performance.now();
    try {
      const renderer=getRenderer();
      const colour=sample.status==='anomaly'?[255,98,100,255]:[58,214,174,255];
      const update=renderer.updateFeatureColors([{id:1,color:colour}], {summaryOnly:true});
      if(!update.updated)throw new Error('已加载图层中未找到演示设备 #1。');
      await renderer.awaitCommit(update.revision);
      if(current===session&&!session.finished) {
        session.lastColourStatus=sample.status;session.colourUpdates++;
        session.commitMs.push(performance.now()-began);
      }
    } catch(error) {
      if(current===session&&!session.finished){set('neural-message','状态提交失败：'+error.message);finish('状态更新中断');}
    } finally {updatePending=false;}
  }
  function start() {
    stop();
    const config=getLoadedConfig(),renderer=getRenderer();
    if(!config||isBusy()||!renderer?.getStats().features){set('neural-message','请先完成一次空间数据加载。回放采用单独的真实传感器实验，不使用仿真点训练。');return;}
    onShowMap();
    try { renderer.trackFeatures([1]); }
    catch(error){set('neural-message',error.message);return;}
    const asset=generateRecords({count:1,seed:config.seed}).next().value;
    const snapshot=()=>{const s=renderer.getStats();return {features:s.features,vertices:s.totalVertices,gpuBytes:s.gpuBytes,stagingRevision:s.stagingRevision,committedRevision:s.committedRevision};};
    current={runId:'ai-'+(++serial),startedAt:new Date().toISOString(),finished:false,asset,channels:[],experiment:'',total:0,model:null,source:null,samples:[],frames:[],lastFrame:null,colourUpdates:0,skippedColourUpdates:0,commitMs:[],lastColourStatus:null,rendererBefore:snapshot(),rendererSnapshot:snapshot};
    const session=current;
    worker=new Worker('/js/neural-worker.js',{type:'module'});
    $('neural-start').disabled=true;$('neural-stop').disabled=false;$('neural-focus').disabled=false;
    status('加载模型与真实数据');$('neural-channels').replaceChildren();
    set('neural-message','独立 Worker 进行时序推理；订阅设备 #1，仅更新颜色，不追加地图对象。');
    worker.onerror=event=>{if(current===session){set('neural-message',event.message||'推理 Worker 出错');finish('回放失败');}};
    worker.onmessage=event=>{
      const message=event.data;if(current!==session||message.runId!==session.runId||session.finished)return;
      if(message.type==='ready') {
        session.model=message.model;session.source=message.source;session.total=message.totalSamples;
        session.replayStartIndex=message.startIndex;session.startSelection=message.startSelection;
        session.channels=message.model.channels;session.experiment=message.source?.experiment||'SKAB';
        set('neural-message',`${message.model.name} · ${message.model.windowSize} 步时间窗。真实测试台实验映射设备 #1；地图坐标仅用于演示。`);
        drawEvaluation(message.model.evaluation);
      } else if(message.type==='sample') {applySample(message,session);}
      else if(message.type==='done')finish('回放已完成');
      else if(message.type==='error'){set('neural-message',message.message);finish('回放失败');}
    };
    worker.postMessage({type:'start',runId:session.runId,intervalMs:100,useSuggestedStart:true,loop:false});
    raf=requestAnimationFrame(sampleFrame);
  }
  $('neural-start').addEventListener('click',start);$('neural-stop').addEventListener('click',stop);
  $('neural-focus').addEventListener('click',()=>{if(current?.asset){getRenderer().focus(current.asset.x,current.asset.y);$('map-container').scrollIntoView({block:'center',behavior:'smooth'});}});
  return {
    stop,
    evidence() {
      if(!current)return null;
      return {runId:current.runId,startedAt:current.startedAt,endedAt:current.endedAt||null,finished:current.finished,model:current.model,source:current.source,assetId:1,mapCoordinates:'synthetic demonstration mapping',geometrySeed:getLoadedConfig()?.seed,replayStartIndex:current.replayStartIndex,startSelection:current.startSelection,colourUpdates:current.colourUpdates,skippedColourUpdates:current.skippedColourUpdates,rendererBefore:current.rendererBefore,rendererAfter:current.rendererSnapshot(),samples:current.samples,frameIntervalsMs:current.frames,colourCommitMs:current.commitMs};
    }
  };
}
