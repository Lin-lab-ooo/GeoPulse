import {GeoRenderer} from './renderer.js';
import {AdaptiveScheduler, percentile, summarize, SCHEDULER_TUNING_PRESETS} from './scheduler.js';
import {parseNdjson, packBatch, createDetector, REGION_DEFINITIONS, parseStreamCountHeader, verifyStreamRecordCount} from './data.js';
import {initNeuralPanel} from './neural-panel.js';
import {initLodExperiment} from './lod-experiment.js';
import {initMapFrameExperiment} from './map-frame-experiment.js';
import {fetchBaiduPois, packBaiduPois} from './baidu-poi.js';
import {readPoiSnapshot} from './baidu-poi-cache.js';
import {loadingTrialPlan, LoadingTrialCollector, waitLoadingCamera} from './loading-experiment.js';
import {initDemandRenderExperiment} from './demand-experiment.js';
import {stagingPolicy, stageGeometryBatch} from './loading-staging.js';
import {streamURL, transportReceipt} from './transport.js';
import {IMPLEMENTATION_VERSION} from './version.js';
import {initWorkspaceUI} from './workspace-ui.js';
import {markRunOutcome,runOutcome,runGeometryProgress} from './run-outcome.js';
import {planReportExport,createReportExportSession} from './report-export.js';

const $ = id => document.getElementById(id);
const workspaceUI = initWorkspaceUI();
const nf = new Intl.NumberFormat('zh-CN');
const fmt = n => Number.isFinite(n) ? nf.format(Math.round(n)) : '—';
const mb = n => ((n || 0)/1048576).toFixed(1);
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
const kinds = {point:'points',line:'lines',polygon:'polygons',points:'points',lines:'lines',polygons:'polygons'};
const modeNames = {adaptive:'自适应流式',fixed:'固定批次流式',baseline:'全量加载基线'};
let selectedMode = 'fixed', run = null, lastRun = null, runSerial = 0;
let benchmarking = false, benchmarkCancelled = false, renderer = null;
let frameIntervals = [], chartSamples = [], lastRAF = null, lastSample = performance.now();
let shownAtLastSample = 0, lastInteraction = -Infinity, environment = null;
const results = [];
let rafId = 0, samplerTimer = 0, samplerExecuting = false, renderError = null;
let neuralPanel = null;
let lodExperiment = null, ablationRunning = false;
let mapFrameExperiment = null, demandExperiment = null, poiLoading = false, realPoiEvidence = null;
let loadingBenchmarkActive = false;
const loadingProtocols = [];
const mapRect = () => {const r=$('map-container').getBoundingClientRect();return {width:r.width,height:r.height,dpr:devicePixelRatio};};
function text(id, value) { const el = $(id); if (el && el.textContent !== String(value)) el.textContent = value; }
function show(id, visible) { const el=$(id);if(el.hidden!==!visible)el.hidden=!visible;el.classList.toggle('hidden',!visible); }
function toast(message) { text('toast',message); show('toast',true); clearTimeout(toast.timer); toast.timer=setTimeout(()=>show('toast',false),4500); }
function setState(message, active = false, state = 'idle') { text('run-state',message); $('run-dot').classList.toggle('running',active); $('run-dot').parentElement.dataset.state=active?'running':state; }
function uiError(message) { text('map-error',message); show('map-error',true); }
function clearError() { show('map-error',false); clearTimeout(toast.timer); show('toast',false); renderError=null; }
function switchView(view) {
  workspaceUI.setView(view);
  if(view==='bench')neuralPanel?.stop();
  show('live-view',view==='live'); show('bench-view',view==='bench');
  if($('neural-panel'))show('neural-panel',view==='neural');
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  $('neural-jump').classList.toggle('active',view==='neural');
  text('workspace-title',view==='bench'?'性能对照与实验记录':view==='neural'?'真实传感器验证':'地图工作台');
}
function readConfig(mode = selectedMode) {
  const integer = (id,min,max) => { const v=Number($(id).value); if (!Number.isInteger(v)||v<min||v>max) throw new Error(`${id} 参数须为 ${min}–${max} 范围内的整数`); return v; };
  return {count:integer('count',1,1000000),seed:integer('seed',0,4294967295),delay:integer('delay',0,1000),chunk:integer('chunk',32,8192),compression:$('compression').value,mode};
}
function addSummary(target, source) { for (const [k,v] of Object.entries(source||{})) if (typeof v==='number'&&!['precision','recall'].includes(k)) target[k]=(target[k]||0)+v; }
function finishSummary(s) { const pos=(s.truePositive||0)+(s.falsePositive||0),truth=(s.truePositive||0)+(s.falseNegative||0); return {...s,precision:pos?s.truePositive/pos:null,recall:truth?s.truePositive/truth:null}; }
function batchBytes(batch) { return batch.groups.reduce((n,g)=>n+g.positions.byteLength+g.colors.byteLength+g.ids.byteLength,0); }

function initRenderer() {
  try {
    renderer = new GeoRenderer($('map-container'), {
      onInteraction(info) { lastInteraction=performance.now();lodExperiment?.interaction(info);mapFrameExperiment?.interaction(info); if(run&&!run.finished)run.interactions.push({atMs:lastInteraction-run.started,type:info.type,heading:info.heading}); if (info.type==='pick'&&info.id) {const poi=lastRun?.config.dataSource==='baidu-poi'?realPoiEvidence?.source?.records?.find(item=>item.id===info.id):null;toast(poi?`${poi.title||'百度地点'} · 真实 POI #${info.id}`:`空间要素 #${info.id} · ${info.kind||'设备'}`);} },
      onFrame(info) {
        resumeSampler();
        if(run&&!run.finished) {
          if(run.firstVisibleMs===null&&run.uploadedVertices>0&&info.vertices>0){run.firstVisibleMs=performance.now()-run.started;text('metric-first',fmt(run.firstVisibleMs));}
          run.loadingCollector?.onBusinessFrame(info);
        }
      },
      onError(error) { renderError=error?.message||String(error); uiError(renderError); if(run&&!run.finished) failRun(run,new Error(renderError)); }
    });
    renderer.setAdaptive(true);
  } catch (error) { uiError('WebGL 初始化失败：'+error.message); $('start-button').disabled=true; $('map-start-button').disabled=true; }
}

/** ACK follows actual GL geometry submission; GPU completion is not measured. */
async function commitBatch(current, batch, metrics = {}) {
  if (run!==current||current.cancelled) return;
  current.queuedBytes=batchBytes(batch);
  current.workerMetrics=metrics;
  show('map-empty',false);
  const getPolicy=()=>stagingPolicy({mode:current.config.mode,
    interacting:performance.now()-lastInteraction<250,adaptiveBudgetMs:current.scheduler.budgetMs});
  const confirmedBeforeBatch=current.confirmedVertices||0;
  const staged=await stageGeometryBatch({batch,getPolicy,
    append:(piece,options)=>renderer.append(piece,options),
    awaitCommit:revision=>renderer.awaitCommit(revision),getCommitStats:()=>renderer.getCommitStats(),
    isCancelled:()=>run!==current||current.cancelled,
    onSlice:info=>{current.uploadedVertices+=info.vertices;current.queuedBytes-=info.vertices*16;current.stagingMs+=info.stagingMs;current.stagingBudgetMs=info.budgetMs;},
    onCommit:info=>{
      current.confirmedVertices=confirmedBeforeBatch+info.confirmedVertices;
      current.scheduler.recordUpload(info.stagingMs+info.uploadSubmissionMs);
      current.scheduler.update({p95:percentile(frameIntervals.slice(-60),.95)||current.scheduler.referenceMs,
        interacting:performance.now()-lastInteraction<250});
    }});
  current.stagingYields=(current.stagingYields||0)+staged.yields;
  if(staged.cancelled||run!==current||current.cancelled)return;
  current.queuedBytes=0; current.shown+=batch.featureCount; current.batches++; current.acknowledgedVertices=current.confirmedVertices;
  addSummary(current.summary,batch.summary);
  current.anomalies=[...batch.anomalies.slice().sort((a,b)=>b.score-a.score),...current.anomalies].slice(0,40);
  current.countSamples.push({atMs:performance.now()-current.started,shown:current.shown,bytes:metrics.bytes||current.bytes,batchSize:batch.featureCount});
  current.anomaliesDirty=true;
  show('map-empty',false);
  if(run===current&&!current.cancelled&&current.worker) current.worker.postMessage({type:'ack',runId:current.id,batchSize:current.scheduler.batchSize});
}

async function startRun(config = null, options = {}) {
  if(!renderer) return Promise.reject(new Error('WebGL 渲染器不可用'));
  if(ablationRunning||poiLoading)return Promise.reject(new Error('请等待当前地图实验或地点检索完成。'));
  neuralPanel?.stop();
  if(run&&!run.finished) stopRun('开始新实验');
  clearError(); renderer.reset(); if(!options.loadingTrial)renderer.resetView?.(); renderer.setAdaptive(!options.loadingTrial);
  let cameraPreparation=null;
  if(options.loadingTrial) {
    renderer.setRiskPreservation(true);
    cameraPreparation=await waitLoadingCamera(renderer,options.baseView,{isCancelled:()=>benchmarkCancelled,getRect:mapRect});
    if(benchmarkCancelled)return null;
  }
  const actual={compression:'identity',...(config||readConfig()),dataSource:'synthetic'};
  text('dataset-source',`当前业务数据：固定种子合成点线面 · ${fmt(actual.count)} 要素`);
  text('map-data-caption','仿真数据 / 局部坐标');
  document.querySelector('.data-composition').textContent='设备点 88% · 管网线 10% · 矩形面 2%';
  const started=performance.now();
  const referenceMs=options.referenceMs||percentile(frameIntervals.slice(-120),.2)||16.7;
  const current={id:'run-'+(++runSerial),config:actual,started,startedISO:new Date().toISOString(),scheduler:new AdaptiveScheduler(actual.mode,{referenceMs,tuning:SCHEDULER_TUNING_PRESETS.tuned}),shown:0,uploadedVertices:0,confirmedVertices:0,acknowledgedVertices:0,batches:0,bytes:0,firstVisibleMs:null,stagingMs:0,queuedBytes:0,workerMetrics:{},summary:{},anomalies:[],frames:[],countSamples:[],longTasks:[],visibilityChanges:[],maxHeap:0,finished:false,cancelled:false,autoInteraction:!!options.autoInteraction,interactionVerified:false,interactionFrames:[],interactions:[],layers:{...renderer.layers}};
  current.stagingBudgetMs=stagingPolicy({mode:actual.mode}).budgetMs;current.stagingYields=0;
  if(options.loadingTrial) {
    current.loadingTrial=options.loadingTrial;
    current.cameraPreparation=cameraPreparation;
    current.loadingCollector=new LoadingTrialCollector({renderer,trial:options.loadingTrial,started,baseView:options.baseView,referenceMs,
      initialRect:mapRect(),getRect:mapRect,longTaskSupported:PerformanceObserver.supportedEntryTypes?.includes('longtask')||false});
  }
  run=current; lastRun=current; resumeSampler(); chartSamples=[]; frameIntervals=[]; shownAtLastSample=0; lastRAF=null;
  show('map-empty',true);
  $('start-button').disabled=true; $('stop-button').disabled=false; $('map-start-button').disabled=true;
  $('benchmark-button').disabled=true;
  setState(actual.mode==='baseline'?'全量下载中':'数据流运行中',true);
  if(options.loadingTrial)text('workspace-title',`加载交互对照 ${options.loadingTrial.index}/${options.loadingTrial.total} · ${fmt(actual.count)} 要素 · ${modeNames[actual.mode]}`);
  document.querySelector('.metric-card:nth-child(3) .metric-title').textContent='rAF 回调频率';
  refreshMetrics(started);
  text('metric-first','—');
  text('anomaly-count','0'); $('anomaly-list').replaceChildren();
  const done=new Promise((resolve,reject)=>{current.resolve=resolve;current.reject=reject;});
  if(actual.mode==='baseline') loadBaseline(current);
  else {
    const worker=new Worker('/js/stream-worker.js',{type:'module'}); current.worker=worker;
    worker.onerror=event=>failRun(current,new Error(event.message||'Worker 执行失败'));
    worker.onmessage=event=>{
      const message=event.data;
      if(run!==current||message.runId!==current.id||current.cancelled) return;
      if(message.type==='batch') {
        if(current.committing) { failRun(current,new Error('收到未确认的重叠批次，违反背压协议')); return; }
        current.bytes=message.metrics.bytes; current.committing=true;
        commitBatch(current,message.batch,message.metrics).then(()=>{current.committing=false;}).catch(error=>failRun(current,error));
      } else if(message.type==='network-timing') {
        current.networkTiming=message.timing;
        // Keep partial/cancelled exports in sync with independent EOF receipts.
        current.workerMetrics.networkTiming=message.timing;
        current.bytes=Math.max(current.bytes,message.bytes||0);
        if(message.phase==='response-body-eof')current.loadingCollector?.setEOF({...message.timing,atMs:message.timing.responseBodyEofAtMs,source:'worker-readable-stream'});
      } else if(message.type==='done') { current.workerMetrics=message.metrics; finishRun(current); }
      else if(message.type==='error') failRun(current,new Error(message.message));
    };
    worker.postMessage({type:'start',runId:current.id,url:streamURL(actual),batchSize:2048,mode:actual.mode,mainStartedEpochMs:performance.timeOrigin+current.started});
  }
  return done;
}

async function loadBaseline(current) {
  current.controller=new AbortController();
  try {
    const fetchStartedAt=performance.now();
    const response=await fetch(streamURL(current.config),{signal:current.controller.signal,cache:'no-store'});
    if(!response.ok) throw new Error('HTTP '+response.status);
    const responseHeadersAtMs=performance.now()-current.started;
    const content=await response.text();
    const responseBodyEofAtMs=performance.now()-current.started;
    if(current.cancelled||run!==current) return;
    current.networkTiming={schemaVersion:'1.0',clockBasis:'main performance.now()-run.started',mainClockAvailable:true,
      responseHeadersAtMs,firstByteAtMs:null,responseBodyEofAtMs,
      scope:'response.text resolution before synchronous parsing; not transport completion or first-byte timing'};
    current.loadingCollector?.setEOF({...current.networkTiming,atMs:responseBodyEofAtMs,source:'main-response-text'});
    current.bytes=new TextEncoder().encode(content).byteLength;
    current.downloadMs=performance.now()-current.started;
    setState('全量主线程解析中',true);
    // Deliberately synchronous: this is the actual full-load comparator, not a mock.
    const begun=performance.now(); const records=parseNdjson(content);
    current.parseMs=performance.now()-begun;
    const expected=parseStreamCountHeader(response.headers.get('x-stream-count'));
    verifyStreamRecordCount(records.length,expected);
    const packedAt=performance.now(); const batch=packBatch(records,{detector:createDetector()});
    current.packMs=performance.now()-packedAt;
    current.workerMetrics={bytes:current.bytes,parsed:records.length,expected,parseMs:current.parseMs,packMs:current.packMs,mode:'baseline',maxPendingBatches:0,networkTiming:current.networkTiming,transport:transportReceipt(response,current.bytes,true,null,fetchStartedAt)};
    await commitBatch(current,batch,current.workerMetrics);
    if(!current.cancelled&&run===current) finishRun(current);
  } catch(error) { if(!current.cancelled) failRun(current,error); }
}

async function finishRun(current) {
  if(current.finished||current.cancelled||run!==current) return;
  current.dataDoneMs=performance.now()-current.started;
  // Give the browser two frames to deliver final render and Long Tasks entries.
  await nextFrame(); await nextFrame();
  if(current.finished||current.cancelled||run!==current) return;
  markRunOutcome(current,'completed',performance.now());
  current.summary=finishSummary(current.summary);
  const completedIntervals=current.frames.map(frame=>frame.intervalMs);
  current.finishedFrameSummary={fps:completedIntervals.length?1000/(completedIntervals.reduce((a,b)=>a+b,0)/completedIntervals.length):null,
    p95:percentile(completedIntervals,.95)};
  current.worker?.terminate(); current.worker=null;
  refreshMetrics(current.ended);
  const record=makeRecord(current);
  if(current.loadingCollector)record.loadingExperiment={...current.loadingCollector.finish({status:'completed',record,endedAt:current.ended}),cameraPreparation:current.cameraPreparation};
  if(record.loadingExperiment)record.autoInteractionVerified=record.loadingExperiment.camera.observedMatrixChanges>0&&record.loadingExperiment.camera.observedPoseChanges>0;
  results.push(record);
  renderResults(); setState('加载完成',false,'completed');
  document.querySelector('.metric-card:nth-child(3) .metric-title').textContent='平均 rAF 回调频率';
  text('metric-progress',fmt(current.shown)+' / '+fmt(current.config.count)+' · 已完成');
  if(!benchmarking) { $('start-button').disabled=false; $('map-start-button').disabled=false; $('benchmark-button').disabled=false; }
  $('stop-button').disabled=true;
  current.resolve(record);
  diagnose(current);
}
function cleanupRun(current) {
  current.worker?.postMessage({type:'cancel',runId:current.id}); current.worker?.terminate(); current.worker=null;
  current.controller?.abort();
}
function savePartialRun(current,status,error=null) {
  if(current.partialSaved)return;
  current.partialSaved=true;
  if(error)current.loadingCollector?.invalidate(status,error.message||String(error));
  const record=makeRecord(current);
  if(current.loadingCollector)record.loadingExperiment={...current.loadingCollector.finish({status,record,endedAt:current.ended}),cameraPreparation:current.cameraPreparation};
  results.push(record);renderResults();
}
function stopRun(message='实验已停止') {
  if(!run||run.finished) return;
  markRunOutcome(run,'cancelled',performance.now());cleanupRun(run);savePartialRun(run,'cancelled');refreshMetrics(run.ended);run.resolve(null);
  setState(message,false,'cancelled'); $('start-button').disabled=false; $('map-start-button').disabled=false; $('stop-button').disabled=true;
  if(!benchmarking) $('benchmark-button').disabled=false;
}
function failRun(current,error) {
  if(current.finished||current.cancelled) return;
  markRunOutcome(current,'failed',performance.now(),error);cleanupRun(current);savePartialRun(current,'failed',error);refreshMetrics(current.ended);current.reject(error);
  setState('实验失败',false,'failed');uiError(error.message);
  $('start-button').disabled=false;$('map-start-button').disabled=false;$('stop-button').disabled=true;
  if(!benchmarking)$('benchmark-button').disabled=false;
}
function makeRecord(current) {
  const frameMs=current.frames.map(f=>f.intervalMs);
  const elapsed=current.ended-current.started;
  const stats=renderer.getStats();
  return {
    id:current.id,startedAt:current.startedISO,config:{...current.config},mapMode:stats.mode,status:runOutcome(current,current.ended).state,failureReason:current.failureReason||null,
    implementationVersion:IMPLEMENTATION_VERSION,
    stagingPolicy:{kind:'cooperative main-thread staging',budgetScope:'checked after primitive-aligned slices; not a hard deadline or GPU execution timer',
      defaultBudgetMs:current.config.mode==='baseline'?null:4,interactionBudgetMs:current.config.mode==='baseline'?null:2,
      yieldedCommits:current.stagingYields||0,queueScope:'packed CPU data awaiting staging; excludes staged GPU geometry'},
    measurement:{features:'features from fully acknowledged batches; partial-batch features are not counted',vertices:'legacy alias of stagedVertices: CPU-staged vertices, not confirmed GL submission',confirmedVertices:'lower bound from awaitCommit receipts observed while active; cancellation may leave later GL submissions unobserved; not GPU completion',fullyAcknowledgedVertices:'vertices in fully acknowledged batches; remaining confirmed vertices belong to an incomplete batch',firstVisible:'first nonempty business draw submitted to GL; display presentation and GPU completion are not timed',fps:'requestAnimationFrame callback cadence; not GPU hardware utilization',stagingMs:'CPU validation and copying into renderer pages',glUploadSubmissionMs:'CPU time inside position/color bufferData and bufferSubData; excludes LOD index calls and GPU execution',gpuBytes:'allocated buffers owned by this renderer, not total GPU memory',heap:'500 ms samples of performance.memory.usedJSHeapSize; may miss transient peaks and include prior-run allocations',ack:'issued after awaitCommit confirms all geometry upload calls, including culled and hidden layers',cpuPercent:null,gpuPercent:null,networkBytes:'legacy alias of decodedResponseBytes; not compressed transfer bytes',encodedBodyBytes:'Resource Timing content-encoded body bytes, excluding headers/framing; null when unavailable'},
    metrics:{firstVisibleMs:current.firstVisibleMs,totalMs:elapsed,dataDoneMs:current.dataDoneMs,features:current.shown,vertices:current.uploadedVertices,...runGeometryProgress(current),networkBytes:current.bytes,decodedResponseBytes:current.bytes,encodedBodyBytes:current.workerMetrics.transport?.encodedBodyBytes??null,featuresPerSecond:current.shown/(elapsed/1000),fpsMean:frameMs.length?1000/(frameMs.reduce((a,b)=>a+b,0)/frameMs.length):null,frameP95:percentile(frameMs,.95),frameP99:percentile(frameMs,.99),maxFrameMs:frameMs.length?Math.max(...frameMs):null,longTasks:current.longTasks.length,longTaskTotalMs:current.longTasks.reduce((n,t)=>n+t.duration,0),sampledMaxHeapBytes:current.maxHeap||null,gpuBytes:stats.gpuBytes,cpuGeometryBytes:stats.cpuBytes,stagingMs:current.stagingMs,glUploadSubmissionMs:stats.glUploadSubmissionMs,stagingRevision:stats.stagingRevision,committedRevision:stats.committedRevision,parseMs:current.workerMetrics.parseMs||0,packMs:current.workerMetrics.packMs||0,drawCalls:stats.drawCalls,pages:stats.pages,lodStride:stats.lodStride},
    onlineDetection:current.summary,protocol:current.workerMetrics,renderPolicy:stats.renderPolicy,renderScheduling:stats.renderScheduling,rendererDiagnostics:stats.rendererDiagnostics||null,optimization:stats.optimization,spatialBuildMs:stats.spatialBuildMs,spatialLifecycle:{coarseBuildMs:stats.coarseBuildMs,fineBuildCount:stats.fineBuildCount,fineAppendCount:stats.fineAppendCount,fineReuseCount:stats.fineReuseCount,spatialFinePages:stats.spatialFinePages,spatialCoarsePages:stats.spatialCoarsePages,coarseOwnedBytes:stats.coarseOwnedBytes,fineOwnedBytes:stats.fineOwnedBytes,spatialEstimatedBytes:stats.spatialEstimatedBytes},spatialConstruction:Object.fromEntries(['spatialReadyPages','spatialPendingPages','spatialPendingPrimitives','spatialBuildTargetPrimitives','spatialBuildProgress','spatialBuildChunks','spatialBuildCpuMs','spatialBuildSliceMaxMs','spatialBuildMaxSliceMs','spatialBuildMaxFrameMs','spatialBuildCompletedCount','spatialBuildLastReadyWallMs','spatialBuildMaxReadyWallMs','spatialBuildSynchronousCount','spatialSplitLimitedLeaves'].map(key=>[key,stats[key]??null])),interactionSamples:current.interactions,referenceFrameMs:current.scheduler.referenceMs,schedulerTuning:current.scheduler.describe(),autoInteractionRequested:current.autoInteraction,autoInteractionVerified:current.interactionVerified,
    visibilityChanges:current.visibilityChanges,frameSamples:current.frames,interactionFrameSamples:current.interactionFrames,networkTiming:current.workerMetrics.networkTiming||current.networkTiming||null,countSamples:current.countSamples,longTaskSamples:current.longTasks,schedulerDecisions:current.scheduler.changes.map(d=>({...d,atMs:d.at-current.started,at:undefined})),environment,userAgent:navigator.userAgent,layers:current.layers,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},canvas:{width:renderer.canvas.width,height:renderer.canvas.height,cssWidth:renderer.width,cssHeight:renderer.height},graphics:renderer.getGraphicsInfo()
  };
}

function renderAnomalies(current) {
  text('anomaly-count',fmt((current.summary.warning||0)+(current.summary.critical||0)));
  const fragment=document.createDocumentFragment();
  for(const a of current.anomalies.slice(0,12)) {
    const item=document.createElement('button');item.className='anomaly-item';
    const dot=document.createElement('span');dot.className='alert-dot';
    if(a.status==='warning')dot.style.background='var(--amber)';
    const body=document.createElement('div'),title=document.createElement('strong'),detail=document.createElement('small'),score=document.createElement('b');
    title.textContent=(a.status==='critical'?'高偏差':'异常偏差')+' · 设备 #'+a.id;
    const region=REGION_DEFINITIONS.find(r=>r.id===a.region);
    detail.textContent=(region?.name||a.region)+' · 遥测 '+a.value;
    score.textContent=a.score.toFixed(1)+' σ';body.append(title,detail);item.append(dot,body,score);
    item.addEventListener('click',()=>{switchView('live');renderer.focus(a.x,a.y);toast(`定位要素 #${a.id} · 分区基线偏差 ${a.score.toFixed(1)}σ`);});
    fragment.append(item);
  }
  if(!fragment.childNodes.length) { const empty=document.createElement('div');empty.className='empty-insight';empty.textContent='当前批次没有异常事件';fragment.append(empty); }
  $('anomaly-list').replaceChildren(fragment);
}
function renderResults() {
  const fragment=document.createDocumentFragment();
  results.forEach((r,index)=>{
    const tr=document.createElement('tr');tr.className=r.config.mode;
    const loading=r.loadingExperiment;
    const coverage=loading?.windowCoverage?.raf;
    const fps=loading?(coverage?coverage.callbacksPerSecond:loading.raf.fpsMean):r.metrics.fpsMean,p95=loading?loading.raf.p95Ms:r.metrics.frameP95;
    const max=loading?loading.raf.maxMs:r.metrics.maxFrameMs;
    const longest=coverage&&coverage.unclosedTailMs>(max??0)?'≥ '+fmt(coverage.unclosedTailMs)+' ms':fmt(max)+' ms';
    if(coverage)tr.title='正式对照采样速率按完整加载时长计算；≥ 表示结束时仍未闭合的回调间隔下界。结合长任务判断停顿。';
    [modeNames[r.config.mode]+' / '+(index+1),fmt(r.metrics.features),fmt(r.metrics.firstVisibleMs)+' ms',fmt(loading?.loadingEndMs??r.metrics.totalMs)+' ms',fps?.toFixed(1)||'—',fmt(p95)+' ms',longest,loading?loading.longTaskCount:r.metrics.longTasks,loading?(loading.valid?'有效':'无效：'+loading.invalidReasons.map(item=>item.code).join('、')):r.status==='failed'?'失败（部分数据）':r.status==='cancelled'?'已停止（部分数据）':'普通加载'].forEach(value=>{const td=document.createElement('td');td.textContent=value??'—';tr.append(td);});
    fragment.append(tr);
  });
  $('results-body').replaceChildren(fragment);
  document.querySelector('.bench-empty-note').hidden=results.length>0;
}
function diagnose(current) {
  if(!current) return;
  const p95=percentile(current.frames.slice(-120).map(f=>f.intervalMs),.95)||0;
  const outcome=runOutcome(current,performance.now());
  if(outcome.state==='failed'||outcome.state==='cancelled') {
    text('diagnosis-title',outcome.state==='failed'?'加载未完成':'加载已停止');
    text('diagnosis-text',`完整批次已确认 ${fmt(current.shown)} / ${fmt(current.config.count)} 要素；已确认上传至少 ${fmt(outcome.geometry.confirmedVertices)} 顶点，已暂存 ${fmt(outcome.geometry.stagedVertices)} 顶点。${outcome.geometry.unacknowledgedConfirmedVertices?'仍有部分几何未完成整批确认。':''}${outcome.state==='failed'?'请检查错误信息后重试。':'当前画面保留已加载的数据，可重新开始加载。'}`);
    return;
  }
  if(outcome.state==='completed') {text('diagnosis-title','加载已完成');text('diagnosis-text',`已确认提交 ${fmt(current.shown)} 要素。性能结论以本次运行的原始采样和实验条件为准。`);return;}
  if(current.config.mode==='baseline') {text('diagnosis-title','全量加载路径');text('diagnosis-text','首批显示需要等待全部下载及主线程解析，长任务会在报告中如实记录。');}
  else if(p95>25) {text('diagnosis-title','检测到交互压力');text('diagnosis-text',current.config.mode==='adaptive'?'调度器正在减小批次。若压力持续，可降低数据规模或减少显示图层。':'固定批次保持不变，可用自适应策略进行同条件比较。');}
  else {text('diagnosis-title',current.finished?'流式实验已完成':'数据管线保持响应');text('diagnosis-text','当前帧间隔较稳定。吞吐与可支持规模以本次运行的原始样本为准。');}
}

function sampler(now) {
  rafId=0;samplerExecuting=true;
  const interval=lastRAF===null?null:now-lastRAF;lastRAF=now;
  if(run&&!run.finished&&run.loadingCollector) {
    const before=run.loadingCollector.cameraCommands.length;
    run.loadingCollector.sampleRaf(now,{shown:run.shown,uploadedVertices:run.uploadedVertices});
    if(run.loadingCollector.cameraCommands.length>before) {
      lastInteraction=performance.now();
      run.interactions.push({atMs:lastInteraction-run.started,type:'scripted-camera-command',controllerInput:true});
    }
  }
  if(interval!==null&&interval>0) {
    frameIntervals.push(interval);if(frameIntervals.length>180)frameIntervals.shift();
    if(run&&!run.finished) {
      const sample={atMs:now-run.started,intervalMs:interval};if(sample.atMs>=0)run.frames.push(sample);
      if(run.autoInteraction&&!run.loadingCollector) {
        const active=renderer.animateView?.((now-run.started)/1000)===true;
        run.interactionVerified ||= active;
        if(active)run.interactionFrames.push(sample);
      }
    }
  }
  if(now-lastSample>=500) {refreshMetrics(now);lastSample=now;}
  samplerExecuting=false;scheduleSampler();
}
function samplerNeedsFrames() {
  return !!(run&&!run.finished)||benchmarking||ablationRunning||poiLoading||!renderer?.getRenderScheduling().sleeping;
}
function resumeSampler() {
  if(rafId||samplerExecuting)return;
  clearTimeout(samplerTimer);samplerTimer=0;
  lastRAF=null;rafId=requestAnimationFrame(sampler);
}
function scheduleSampler() {
  if(rafId||samplerTimer)return;
  if(samplerNeedsFrames())rafId=requestAnimationFrame(sampler);
  else {
    lastRAF=null;
    samplerTimer=setTimeout(()=>{samplerTimer=0;const now=performance.now();refreshMetrics(now);lastSample=now;scheduleSampler();},500);
  }
}
function refreshProgress(current) {
  const ratio=current?.config.count?Math.max(0,Math.min(1,current.shown/current.config.count)):0;
  const fill=$('stream-progress-fill');
  if(fill){fill.style.width=(ratio*100).toFixed(1)+'%';fill.parentElement.setAttribute('aria-valuenow',String(Math.round(ratio*100)));}
}
function refreshMetrics(now) {
  if(!renderer)return;
  const stats=renderer.getStats(), current=run||lastRun;
  const finishedSummary=current?.finishedFrameSummary;
  const fps=finishedSummary?finishedSummary.fps:frameIntervals.length?1000/(frameIntervals.reduce((a,b)=>a+b,0)/frameIntervals.length):null;
  const p95=finishedSummary?finishedSummary.p95:percentile(frameIntervals,.95);
  const scheduling=renderer.getRenderScheduling(),idleSampling=!samplerNeedsFrames();
  $('metric-fps-unit').hidden=idleSampling;
  text('metric-fps',idleSampling?'休眠':fps?fps.toFixed(1):'—');text('metric-p95',idleSampling?'—':p95?p95.toFixed(1):'—');
  text('render-policy-status',scheduling.sleeping?'静止休眠 · 等待变化':scheduling.pulseActive?'告警动画 · 正在绘制':scheduling.policy==='continuous'?'持续绘制':'按需绘制 · 处理变化');
  text('metric-gpu',mb(stats.gpuBytes)+' MB');
  const heap=performance.memory?.usedJSHeapSize;
  text('metric-heap',heap?mb(heap)+' MB':'浏览器未提供');
  text('draw-stat','Draw '+fmt(stats.drawCalls)+' · 顶点 '+fmt(stats.vertices)+' · 告警 '+fmt(stats.pointAlertsDrawn)+' / '+fmt(stats.pointAlertsTotal));
  text('drawcalls-stat',fmt(stats.drawCalls));
  refreshProgress(current);
  if(current) {
    if(current.anomaliesDirty){renderAnomalies(current);current.anomaliesDirty=false;}
    if(heap)current.maxHeap=Math.max(current.maxHeap,heap);
    text('metric-count',fmt(current.shown));text('metric-first',Number.isFinite(current.firstVisibleMs)?fmt(current.firstVisibleMs):'—');
    const outcome=runOutcome(current,now);
    text('metric-progress',fmt(current.shown)+' / '+fmt(current.config.count)+' · '+(current.finished?outcome.progressLabel:(current.shown/current.config.count*100).toFixed(1)+'%'));
    text('bytes-stat',mb(current.bytes)+' MB');text('parsed-stat',fmt(current.workerMetrics.parsed||0));text('queue-stat',Math.max(0,current.queuedBytes/1024).toFixed(0)+' KB');
    const snapshot=current.finished?current.scheduler.snapshot():current.scheduler.update({p95:p95||16.7,interacting:performance.now()-lastInteraction<250});
    text('pressure-label',snapshot.pressure>.65?'较高':snapshot.pressure>.25?'适中':'平稳');$('pressure-meter').style.width=Math.max(3,snapshot.pressure*100)+'%';
    text('scheduler-reason',snapshot.reason);text('batch-stat',fmt(snapshot.batchSize));text('budget-stat',Number.isFinite(current.stagingBudgetMs)?current.stagingBudgetMs.toFixed(1):'—');
    const sampleSeconds=(now-lastSample)/1000;
    const throughput=!current.finished&&sampleSeconds>0?(current.shown-shownAtLastSample)/sampleSeconds:0;shownAtLastSample=current.shown;
    if(!current.finished){chartSamples.push({fps:fps||0,throughput,atMs:now-current.started});if(chartSamples.length>120)chartSamples.shift();updateChart();}
    text('throughput-label',fmt(current.finished?outcome.throughput:throughput)+' 要素 / 秒');text('chart-time',outcome.timeLabel+' '+(outcome.elapsedMs===null?'耗时未记录':(outcome.elapsedMs/1000).toFixed(1)+' s'));
    diagnose(current);
  }
}
function updateChart() {
  const samples=chartSamples, maxThroughput=Math.max(1,...samples.map(s=>s.throughput));
  const maxFps=Math.max(60,Math.ceil(Math.max(0,...samples.map(s=>s.fps))/60)*60);
  document.querySelectorAll('.chart-grid span').forEach((el,i)=>el.textContent=String(i===0?maxFps:i===1?maxFps/2:0));
  const points=(field,max)=>samples.map((s,i)=>`${samples.length===1?0:i/(samples.length-1)*800},${82-Math.min(1,s[field]/max)*72}`).join(' ');
  $('fps-line').setAttribute('points',points('fps',maxFps));$('throughput-line').setAttribute('points',points('throughput',maxThroughput));
  const pts=points('fps',maxFps).split(' ');$('fps-area').setAttribute('d',pts.length?`M0 92 L${pts.join(' L')} L800 92 Z`:'');
}

async function benchmark() {
  if(benchmarking||ablationRunning)return;
  let config;try{config=readConfig();}catch(error){toast(error.message);return;}
  benchmarking=true;benchmarkCancelled=false;
  const originalRenderPolicy=renderer.renderPolicy;renderer.setRenderPolicy('continuous');resumeSampler();
  const controls=['count','seed','delay','chunk','compression','layer-points','layer-lines','layer-polygons','rotate-view','zoom-in','zoom-out','reset-view','render-policy','demand-start','panel-toggle','panel-close','focus-map'];
  controls.forEach(id=>$(id).disabled=true);
  document.querySelectorAll('[data-mode]').forEach(el=>el.disabled=true);
  ['points','lines','polygons'].forEach(kind=>$('layer-'+kind).checked=true);
  renderer.setLayers({points:true,lines:true,polygons:true});
  $('benchmark-button').disabled=true;text('benchmark-progress','正在准备统一视角与数据配置…');
  const group=[];
  const referenceMs=percentile(frameIntervals.slice(-120),.2)||16.7;
  try {
    // Rotated order reduces systematic warm-cache advantage. Every repetition has all strategies.
    const orders=[['baseline','fixed','adaptive'],['adaptive','baseline','fixed'],['fixed','adaptive','baseline']];
    for(let repeat=0;repeat<orders.length&&!benchmarkCancelled;repeat++) {
      for(const mode of orders[repeat]) {
        if(benchmarkCancelled)break;
        text('benchmark-progress',`重复 ${repeat+1}/3 · ${modeNames[mode]} · 相同 ${fmt(config.count)} 要素 / seed ${config.seed}`);
        // Keep map visible so its ResizeObserver and WebGL drawing are actually exercised.
        switchView('live');
        const result=await startRun({...config,mode},{autoInteraction:true,referenceMs});
        if(result)group.push(result);else benchmarkCancelled=true;
        await nextFrame();
      }
    }
    switchView('bench');
    const summary=Object.fromEntries(['baseline','fixed','adaptive'].map(mode=>[mode,{firstVisibleMs:summarize(group.filter(r=>r.config.mode===mode).map(r=>r.metrics.firstVisibleMs).filter(Number.isFinite)),totalMs:summarize(group.filter(r=>r.config.mode===mode).map(r=>r.metrics.totalMs)),fps:summarize(group.filter(r=>r.config.mode===mode).map(r=>r.metrics.fpsMean).filter(Number.isFinite))}]));
    benchmark.lastSummary=summary;
    text('benchmark-progress',benchmarkCancelled?'对比已停止，完成的记录已保留。':'9 次对比已完成。点击导出实验 JSON 获取配置、均值、标准差与全部原始样本。');
  } catch(error) {text('benchmark-progress','实验中断：'+error.message);}
  finally {benchmarking=false;renderer.setRenderPolicy(originalRenderPolicy);controls.forEach(id=>$(id).disabled=false);document.querySelectorAll('[data-mode]').forEach(el=>el.disabled=false);$('benchmark-button').disabled=false;$('start-button').disabled=false;$('map-start-button').disabled=false;$('stop-button').disabled=true;}
}
async function loadingBenchmark() {
  if(benchmarking||ablationRunning||poiLoading||run&&!run.finished)return;
  const config=readConfig(),protocolId='loading-'+Date.now();
  const sizes=$('loading-benchmark-sizes').value==='smoke'?[10000]:[100000,1000000];
  const plan=loadingTrialPlan({sizes,seed:config.seed,delay:config.delay,chunk:config.chunk});
  const protocol={id:protocolId,kind:'loading-interaction-comparison',implementationVersion:IMPLEMENTATION_VERSION,
    startedAt:new Date().toISOString(),environment,plan,attempts:[],status:'running',formal:sizes.length===2,
    comparison:'Same deterministic seed, transport settings, renderer, LOD 1, all layers, alert preservation, base camera and wall-time camera trace. Three distinct parsing/batching pipelines.',
    controllerInteractionInput:'Every scripted camera command marks interaction pressure for 250 ms using the same existing scheduler update path; this is not a physical input event.',
    scope:'Real Baidu base map when connected; business point/line/rectangle data is synthetic. No LocalSearch. rAF and business callback cadence, not presentation FPS or physical input latency.'};
  loadingProtocols.push(protocol);benchmarking=true;loadingBenchmarkActive=true;benchmarkCancelled=false;
  neuralPanel?.stop();
  const original={renderPolicy:renderer.renderPolicy,adaptive:renderer.adaptive,risk:renderer.riskPreservation,layers:{...renderer.layers},view:renderer.getViewState()};
  renderer.setRenderPolicy('continuous');resumeSampler();
  let baseView={...original.view};
  if(baseView.mode==='baidu') {
    const [lng,lat]=renderer.unprojectLocalPoint([-1200,900]);
    baseView={mode:'baidu',center:{lng,lat},zoom:14,heading:0,tilt:0};
  } else baseView={...baseView,x:-1200,y:900,scale:renderer._defaultScale*4,heading:0};
  protocol.baseView=baseView;protocol.renderQuality={renderPolicy:'continuous',adaptiveLod:false,lodStride:1,riskPreservation:true,layers:{points:true,lines:true,polygons:true},optimization:{...renderer.optimization}};
  const controls=[...document.querySelectorAll('[data-mode],[data-view],[data-workspace-control]'),...['count','seed','delay','chunk','compression','layer-points','layer-lines','layer-polygons',
    'rotate-view','zoom-in','zoom-out','reset-view','start-button','map-start-button','benchmark-button','loading-benchmark-button','loading-benchmark-sizes','export-button',
    'settings-button','connect-button','poi-load','poi-refresh','neural-start','neural-jump','lod-benchmark','map-frame-start','render-policy','demand-start'].map($)].filter(Boolean);
  const disabled=controls.map(el=>el.disabled);controls.forEach(el=>el.disabled=true);
  $('loading-benchmark-stop').disabled=false;
  $('stop-button').disabled=false;
  const invalidate=event=>{if(loadingBenchmarkActive&&event.isTrusted&&run?.loadingCollector&&!run.finished)run.loadingCollector.invalidate('trusted-input',event.type);};
  ['pointerdown','wheel','keydown'].forEach(type=>document.addEventListener(type,invalidate,{capture:true,passive:true}));
  const referenceMs=percentile(frameIntervals.slice(-120),.2)||16.7;protocol.referenceMs=referenceMs;
  const status=message=>text('loading-benchmark-progress',message);
  try {
    // Check server source identity before data requests; reload required after source edits.
    const fresh=await(await fetch('/api/environment',{cache:'no-store'})).json();
    if(!environment||fresh.sourceFingerprint!==environment.sourceFingerprint||fresh.runtimeFingerprint!==environment.runtimeFingerprint||fresh.implementationVersion!==IMPLEMENTATION_VERSION)throw new Error('页面与服务源码版本不一致，请刷新页面后再测');
    protocol.environment=fresh;
    for(const [index,trial] of plan.entries()) {
      if(benchmarkCancelled)break;
      if(document.visibilityState!=='visible')throw new Error('页面进入后台，对照已停止');
      const attempt={...trial,index:index+1,protocolId,status:'preparing'};protocol.attempts.push(attempt);
      status(`第 ${index+1}/${plan.length} 次 · ${fmt(trial.count)} 要素 · ${modeNames[trial.mode]} · 第 ${trial.repeat} 轮`);
      setState(`加载交互对照 ${index+1}/${plan.length}`,true);
      renderer.setLayers({points:true,lines:true,polygons:true});
      switchView('live');$('map-stage').scrollIntoView({block:'center',behavior:'instant'});
      $('stop-button').disabled=false;
      try {
        const record=await startRun({...config,count:trial.count,mode:trial.mode},
          {loadingTrial:attempt,baseView,referenceMs,autoInteraction:true});
        attempt.status=record?.loadingExperiment?.status||'cancelled';attempt.recordId=record?.id||run?.id||null;
        attempt.valid=record?.loadingExperiment?.valid??false;
        if(!record)benchmarkCancelled=true;
      } catch(error) {
        attempt.status=benchmarkCancelled?'cancelled':'failed';attempt.error=error.message;attempt.recordId=run?.loadingTrial===attempt?run.id:null;
        if(error.cameraPreparation)attempt.cameraPreparation=error.cameraPreparation;
        attempt.actualViewAfterFailure=renderer.getViewState();
        // Keep failed attempts and prior results, then stop rather than silently replace a trial.
        throw error;
      }
      await nextFrame();
    }
    protocol.status=benchmarkCancelled?'cancelled':'completed';
  } catch(error) {protocol.status=benchmarkCancelled?'cancelled':'failed';protocol.error=error.message;status('对照中断：'+error.message+'；已完成和中断记录均保留。');}
  finally {
    protocol.endedAt=new Date().toISOString();
    benchmarking=false;loadingBenchmarkActive=false;
    ['pointerdown','wheel','keydown'].forEach(type=>document.removeEventListener(type,invalidate,true));
    controls.forEach((el,i)=>el.disabled=disabled[i]);
    $('stop-button').disabled=true;$('loading-benchmark-stop').disabled=true;
    renderer.setAdaptive(original.adaptive);renderer.setRiskPreservation(original.risk);renderer.setLayers(original.layers);
    renderer.setRenderPolicy(original.renderPolicy);
    // Retain the tested final camera; reset remains available after evidence capture.
    switchView('bench');
    const records=results.filter(r=>r.loadingExperiment?.trial?.protocolId===protocolId);
    const valid=records.filter(r=>r.loadingExperiment.valid).length;
    protocol.recordIds=records.map(r=>r.id);protocol.validTrials=valid;protocol.completedTrials=records.length;
    if(protocol.status!=='failed')status(`${protocol.status==='completed'?'已完成':'已停止'}：${records.length}/${plan.length} 条原始记录，${valid} 条有效。可导出完整报告。`);
    text('loading-benchmark-summary','各规模与策略的逐轮记录、阶段帧间隔、EOF时间及相机响应证据随报告保存；不同规模分开比较。');
  }
}

let pendingReportExport = null;
async function exportReport() {
  if(exportReport.saving)return;
  if(!pendingReportExport&&!results.length&&!loadingProtocols.some(protocol=>protocol.attempts.length)){toast('先开始一次实验，再导出实测或中断记录。');return;}
  exportReport.saving=true;$('export-button').disabled=true;
  try {
    if(!pendingReportExport){
      text('benchmark-progress','正在检查完整证据与报告分片大小…');
      await nextFrame();
      const common={schemaVersion:'1.0',implementationVersion:IMPLEMENTATION_VERSION,project:'GeoPulse',exportedAt:new Date().toISOString(),loadingProtocols,scope:'Each run identifies synthetic or live Baidu POI business data. Real SDK frame cadence is separate from isolated GPU time and physical frame presentation.',benchmarkSummary:benchmark.lastSummary||null,lodAblation:lodExperiment?.evidence()||[],demandRenderExperiments:demandExperiment?.evidence()||[],realPoiEvidence,aiReplayEvidence:neuralPanel?.evidence()||null};
      const plan=planReportExport({common,runs:results,mapRecords:mapFrameExperiment?.evidence()||[],exportId:crypto.randomUUID()});
      pendingReportExport=createReportExportSession(plan);
    }
    const session=pendingReportExport;
    await session.saveRemaining(async ({body})=>{
      const response=await fetch('/api/reports',{method:'POST',headers:{'Content-Type':'application/json'},body});
      const saved=await response.json();
      if(!response.ok)throw new Error(saved.error||'保存报告失败：HTTP '+response.status);
      if(saved.ok!==true||typeof saved.absolutePath!=='string'||!saved.absolutePath)throw new Error('报告保存回执不完整，请重试并按导出批次去重');
      return saved;
    },({index,total,saved})=>text('benchmark-progress',`正在保存快照第 ${index+1}/${total} 份（已保存 ${saved} 份）…`));
    const paths=session.receipts.map(receipt=>receipt.value.absolutePath);
    text('benchmark-progress',`已完整保存本次快照：${session.plan.totalRuns} 条运行记录，${paths.length} 份报告。`+paths.join('；'));
    toast('本次快照的完整原始报告已保存到工程 reports 目录');
    pendingReportExport=null;
  } catch(error) {
    const receipts=pendingReportExport?.receipts||[],paths=receipts.map(receipt=>receipt.value.absolutePath);
    toast('报告尚未完整保存：'+error.message);
    text('benchmark-progress','报告尚未完整保存：'+error.message+(paths.length?'；已成功保存：'+paths.join('；'):'')+(pendingReportExport?'。点击“重试未保存报告”继续同一快照；新实验记录可在完成后再次导出。':''));
  } finally {
    text('export-button',pendingReportExport?'重试未保存报告 ↻':'导出实验报告 ↓');
    $('export-button').disabled=false;exportReport.saving=false;
  }
}

async function connectMap() {
  const ak=$('ak-input').value.trim();if(!ak){text('ak-message','请填写浏览器端 AK。');return;}
  if(benchmarking||ablationRunning||poiLoading||run&&!run.finished){text('ak-message','请先停止当前实验，连接后重新运行，以保持测量一致。');return;}
  $('connect-button').disabled=true;text('ak-message','正在加载官方 SDK，并等待自定义图层真实就绪…');
  try {
    await renderer.connectBaidu(ak);
    if($('remember-ak').checked)localStorage.setItem('geopulse-baidu-ak',ak);else localStorage.removeItem('geopulse-baidu-ak');
    text('connection-badge','百度地图已接入');text('map-mode-label','百度地图 · 业务图层');
    text('ak-message','自定义图层已就绪。请重新运行实验，单独验证真实地图性能。');
    $('settings-dialog').close();toast('真实百度地图图层已就绪');
  } catch(error) {text('ak-message',error.message);text('connection-badge','本地性能沙盒');console.warn('GeoPulse 地图连接失败',String(error.stack||error).replaceAll(ak,'[AK已隐藏]').replace(/([?&]ak=)[^&\s"']+/gi,'$1[已隐藏]'));}
  finally{$('connect-button').disabled=false;}
}

async function loadRealPois({refresh=false}={}) {
  if(!renderer?.getBaiduMap()){text('poi-status','请先通过“地图接入”连接百度地图。');return;}
  if(poiLoading||benchmarking||ablationRunning||run&&!run.finished){text('poi-status','请等待当前实验结束后检索。');return;}
  const keywords=$('poi-keywords').value.split(/[,，、]/).map(v=>v.trim()).filter(Boolean);
  if(refresh && keywords.length!==1){text('poi-status','刷新一次只允许一个关键词，最多读取一页50条。');return;}
  poiLoading=true;neuralPanel?.stop();switchView('live');
  const controls=[$('poi-load'),$('poi-refresh'),$('start-button'),$('map-start-button'),$('benchmark-button')];
  const disabled=controls.map(el=>el.disabled);controls.forEach(el=>el.disabled=true);
  const started=performance.now();
  try {
    text('poi-status',refresh?'正在限速刷新一页真实地点…':'正在读取本地真实地点缓存，不调用百度检索…');
    const evidence=refresh ? await fetchBaiduPois({sdk:window.BMap,map:renderer.getBaiduMap(),keywords,maxPages:1,pageCapacity:50,
      onProgress:progress=>text('poi-status',`正在读取真实地点：${progress.keyword||''} · 第 ${(progress.pageIndex??0)+1} 页`)}) : await readPoiSnapshot();
    if(refresh && evidence.pois.length && evidence.metadata.status==='success') { try { localStorage.setItem('geopulse-poi-snapshot',JSON.stringify({...evidence,cachedAt:new Date().toISOString()})); } catch {} }
    const batch=packBaiduPois(evidence.pois,point=>renderer.projectGeographicPoint(point));
    if(!batch.featureCount){text('poi-status','检索未返回可绘制的真实地点，请调整视野或关键词。');return;}
    realPoiEvidence={...evidence,reuse:{cached:!refresh,loadedAt:new Date().toISOString()},projection:batch.metadata,source:batch.source};
    // Preserve camera movements made while the asynchronous snapshot was read.
    const view=renderer.getViewState();renderer.reset();renderer.setViewState(view);renderer.setAdaptive(false);
    const config={mode:'fixed',count:batch.featureCount,seed:null,delay:0,chunk:batch.featureCount,
      dataSource:'baidu-poi',sourceMetadata:evidence.metadata};
    const current={id:'poi-'+(++runSerial),config,started,startedISO:new Date().toISOString(),
      scheduler:new AdaptiveScheduler('fixed',{referenceMs:percentile(frameIntervals,.2)||16.7}),
      shown:0,uploadedVertices:batch.featureCount,confirmedVertices:0,acknowledgedVertices:0,bytes:0,queuedBytes:0,workerMetrics:{},
      stagingMs:0,summary:{},anomalies:[],frames:[],countSamples:[],longTasks:[],visibilityChanges:[],
      interactions:[],autoInteraction:false,interactionVerified:false,finished:false,cancelled:false,layers:{...renderer.layers}};
    run=current;lastRun=current;clearError();show('map-empty',false);
    const staged=performance.now(),submitted=renderer.append(batch);current.stagingMs=performance.now()-staged;
    await renderer.awaitCommit(submitted.revision);
    current.shown=batch.featureCount;current.confirmedVertices=batch.featureCount;current.acknowledgedVertices=batch.featureCount;current.dataDoneMs=performance.now()-started;
    current.ended=performance.now();current.finished=true;
    const record=makeRecord(current);record.metrics.networkBytes=null;record.sourceMetadata=evidence.metadata;
    results.push(record);renderResults();setState('真实地点已加载');
    document.querySelector('.data-composition').textContent='真实百度 POI · 点要素 100%';
    text('dataset-source',`当前业务数据：百度官方检索 · ${fmt(batch.featureCount)} 个真实地点`);
    text('map-data-caption','百度真实 POI / BD-09 投影');
    text('poi-status',`已加载 ${fmt(batch.featureCount)} 个真实地点；${(evidence.metadata.keywords||keywords).join('、')}。${refresh?'本次仅刷新一页；结果已缓存。':'复用已保存样本，未调用地点检索。'}`);
    refreshMetrics(performance.now());
  } catch(error) {
    if(run?.config.dataSource==='baidu-poi'&&!run.finished){run.finished=true;run.cancelled=true;}
    text('poi-status','真实地点加载失败：'+error.message);setState('地点检索结束');
  } finally {poiLoading=false;controls.forEach((el,i)=>el.disabled=disabled[i]);}
}

function bindUI() {
  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.view)));
  const interact=()=>{lastInteraction=performance.now();};
  $('map-container').addEventListener('pointerdown',interact,{passive:true});
  $('map-container').addEventListener('wheel',interact,{passive:true});
  $('map-container').addEventListener('pointermove',event=>{if(event.buttons)interact();},{passive:true});
  document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>{selectedMode=b.dataset.mode;document.querySelectorAll('[data-mode]').forEach(v=>v.classList.toggle('active',v===b));}));
  const launch=()=>{if(benchmarking)return;try{startRun().catch(error=>toast(error.message));}catch(error){toast(error.message);}};
  $('start-button').addEventListener('click',launch);$('map-start-button').addEventListener('click',launch);
  $('stop-button').addEventListener('click',()=>{benchmarkCancelled=true;stopRun();});
  $('settings-button').addEventListener('click',()=>$('settings-dialog').showModal());
  $('method-button').addEventListener('click',()=>$('method-dialog').showModal());
  document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>$(b.dataset.close).close()));
  $('connect-button').addEventListener('click',connectMap);
  $('poi-load').addEventListener('click',()=>loadRealPois());
  $('poi-refresh').addEventListener('click',()=>loadRealPois({refresh:true}));
  $('loading-benchmark-button').addEventListener('click',loadingBenchmark);
  $('loading-benchmark-stop').addEventListener('click',()=>{benchmarkCancelled=true;stopRun('加载交互对照已停止');});
  $('benchmark-button').addEventListener('click',benchmark);$('export-button').addEventListener('click',exportReport);
  ['points','lines','polygons'].forEach(kind=>$('layer-'+kind).addEventListener('change',()=>renderer?.setLayers(Object.fromEntries(['points','lines','polygons'].map(k=>[k,$('layer-'+k).checked])))));
  $('reset-view').addEventListener('click',()=>renderer?.resetView?.());
  $('zoom-in').addEventListener('click',()=>renderer?.zoomBy?.(1.35));$('zoom-out').addEventListener('click',()=>renderer?.zoomBy?.(1/1.35));
  $('rotate-view').addEventListener('click',()=>renderer?.rotateBy?.(30));
  $('render-policy').addEventListener('change',()=>{if(benchmarking||ablationRunning)return;renderer?.setRenderPolicy($('render-policy').value);resumeSampler();});
  text('current-origin',location.origin);
  try{const ak=localStorage.getItem('geopulse-baidu-ak');if(ak){$('ak-input').value=ak;$('remember-ak').checked=true;}}catch{}
  document.addEventListener('visibilitychange',()=>{if(run&&!run.finished) {run.visibilityChanges.push({atMs:performance.now()-run.started,state:document.visibilityState});if(loadingBenchmarkActive&&document.visibilityState!=='visible'){run.loadingCollector?.invalidate('hidden',document.visibilityState);benchmarkCancelled=true;stopRun('页面进入后台，对照停止');}}});
}
try {
  const observer=new PerformanceObserver(list=>{if(run&&!run.finished)for(const entry of list.getEntries())if(entry.startTime>=run.started){const sample={atMs:entry.startTime-run.started,duration:entry.duration,name:entry.name};run.longTasks.push(sample);run.loadingCollector?.addLongTask(sample);}});
  observer.observe({type:'longtask',buffered:true});
}catch{}
async function loadEnvironment(){
  try{const response=await fetch('/api/environment');environment=await response.json();text('environment-label',`${environment.platform||'OS'} · ${environment.cpu?.model||environment.cpuModel||'本地处理器'} · Node ${environment.node||environment.nodeVersion||''}`);}
  catch{text('environment-label','本地浏览器运行 · 环境接口不可用');}
}
initRenderer();bindUI();loadEnvironment();resumeSampler();workspaceUI.setView('live');
neuralPanel=initNeuralPanel({getRenderer:()=>renderer,getLoadedConfig:()=>lastRun?.finished&&!lastRun.cancelled&&lastRun.config.dataSource!=='baidu-poi'?lastRun.config:null,isBusy:()=>benchmarking||ablationRunning||poiLoading||!!(run&&!run.finished),onShowMap:()=>{if($('neural-panel').hidden)switchView('live');}});
$('neural-focus').addEventListener('click',()=>{switchView('live');$('map-stage').scrollIntoView({block:'center',behavior:'smooth'});});
lodExperiment=initLodExperiment({getRenderer:()=>renderer,getConfig:()=>lastRun?.finished&&!lastRun.cancelled?lastRun.config:null,isBusy:()=>benchmarking||ablationRunning||poiLoading||!!(run&&!run.finished),onActiveChange:value=>{ablationRunning=value;resumeSampler();if(!value)setState('消融完成');},onPhase:message=>setState(message,true),onShowMap:()=>switchView('live'),onShowResults:()=>switchView('bench'),stopNeural:()=>neuralPanel.stop(),getEnvironment:()=>environment});
mapFrameExperiment=initMapFrameExperiment({getRenderer:()=>renderer,getConfig:()=>lastRun?.finished&&!lastRun.cancelled?lastRun.config:null,isBusy:()=>benchmarking||ablationRunning||poiLoading||!!(run&&!run.finished),onActiveChange:value=>{ablationRunning=value;resumeSampler();if(!value)setState('地图帧率对照结束');},onPhase:message=>setState(message,true),onShowMap:()=>{switchView('live');$('map-stage').scrollIntoView({block:'center',behavior:'instant'});},onShowResults:()=>switchView('bench'),stopNeural:()=>neuralPanel.stop(),getEnvironment:()=>environment});
$('neural-jump').addEventListener('click',()=>{switchView('neural');$('neural-panel').scrollIntoView({block:'start',behavior:'smooth'});});
demandExperiment=initDemandRenderExperiment({getRenderer:()=>renderer,getConfig:()=>lastRun?.finished&&!lastRun.cancelled?lastRun.config:null,isBusy:()=>benchmarking||ablationRunning||poiLoading||!!(run&&!run.finished),onActiveChange:value=>{ablationRunning=value;resumeSampler();if(!value)setState('按需绘制对照结束');},onPhase:message=>setState(message,true),onShowMap:()=>{switchView('live');$('map-stage').scrollIntoView({block:'center',behavior:'instant'});},onShowResults:()=>switchView('bench'),stopNeural:()=>neuralPanel.stop(),getEnvironment:()=>environment});
window.addEventListener('beforeunload',()=>{demandExperiment?.destroy();neuralPanel?.stop();if(run&&!run.finished)cleanupRun(run);cancelAnimationFrame(rafId);clearTimeout(samplerTimer);renderer?.destroy();});

// Checking this local snapshot never invokes the Baidu SDK or LocalSearch.
readPoiSnapshot().then(snapshot=>{
  if(poiLoading||realPoiEvidence)return;
  text('poi-status',`本地已有 ${snapshot.pois.length} 个真实地点样本。连接地图后可直接复用；只有“刷新一次”才发起检索。`);
}).catch(()=>{});
