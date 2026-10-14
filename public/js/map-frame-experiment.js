import {percentile} from './scheduler.js';

export const MAP_FRAME_METHODS = Object.freeze([
  {id:'map-only', label:'仅底图（业务图层隐藏）', spatial:false, dirtyMode:'envelope', visible:false},
  {id:'input-pages', label:'输入顺序分页', spatial:false, dirtyMode:'envelope', visible:true},
  {id:'dirty-only', label:'仅稀疏更新优化', spatial:false, dirtyMode:'ranges', visible:true},
  {id:'spatial-only', label:'仅空间筛选优化', spatial:true, dirtyMode:'envelope', visible:true},
  {id:'hybrid', label:'稳定后空间细筛', spatial:true, dirtyMode:'ranges', visible:true}
].map(method=>Object.freeze(method)));
const METHODS=MAP_FRAME_METHODS;
import {IMPLEMENTATION_VERSION} from './version.js';
const SCENARIOS = [
  {id:'static', label:'静止局部视角'},
  {id:'motion', label:'连续移动／缩放／旋转／倾斜'},
  {id:'updates', label:'静止＋每 100 ms 更新两点'}
];
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const finite = value => Number.isFinite(value) ? value : null;
const mean = values => values.length ? values.reduce((sum,value)=>sum+value,0)/values.length : null;
const format = (value, digits=1) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const submissionSnapshot = stats => ({uploadedBytes:finite(stats.uploadedBytes),
  glUploadSubmissionMs:finite(stats.glUploadSubmissionMs),stagingRevision:finite(stats.stagingRevision),
  committedRevision:finite(stats.committedRevision),...buildSnapshot(stats)});
const buildSnapshot = stats => Object.fromEntries(['spatialBuildMs','coarseBuildMs','fineBuildCount','fineAppendCount',
  'fineReuseCount','spatialIndexedPrimitives','spatialFinePages','spatialCoarsePages','coarseOwnedBytes','fineOwnedBytes',
  'spatialEstimatedBytes','coarseDensityGuardCount','spatialPendingPages','spatialPendingPrimitives','spatialBuildProgress',
  'spatialBuildChunks','spatialBuildCpuMs','spatialBuildSliceMaxMs','spatialBuildMaxSliceMs','spatialBuildMaxFrameMs',
  'spatialBuildCompletedCount','spatialBuildLastReadyWallMs','spatialBuildMaxReadyWallMs','spatialBuildSynchronousCount']
  .map(key=>[key,finite(stats[key])]));
const buildDeltas=(before,after)=>Object.fromEntries(['spatialBuildMs','coarseBuildMs','fineBuildCount','fineAppendCount','fineReuseCount',
  'spatialBuildChunks','spatialBuildCompletedCount','spatialBuildSynchronousCount']
  .map(key=>[key+'Delta',Number.isFinite(before[key])&&Number.isFinite(after[key])?after[key]-before[key]:null]));

/** Construction CPU is renderer main-thread work; intervals include browser/SDK work. */
export function summarizeBuildPreparation(samples) {
  const cpu=samples.map(frame=>frame.spatialBuildCpuMs).filter(value=>Number.isFinite(value)&&value>0);
  const slice=samples.map(frame=>frame.spatialBuildSliceMaxMs).filter(Number.isFinite);
  return {buildFrames:cpu.length,buildCpuMs:cpu.reduce((sum,value)=>sum+value,0),
    buildCpuP95Ms:percentile(cpu,.95),buildCpuMaxFrameMs:cpu.length?Math.max(...cpu):null,
    buildMaxSliceMs:slice.length?Math.max(...slice):null,
    pendingFrames:samples.filter(frame=>frame.spatialPendingPages>0).length,
    interpretation:'Current-frame construction CPU and complete-primitive chunk maxima; not GPU execution time or physical presentation. Cumulative renderer maxima are retained separately in snapshots.'};
}

export function spatialPreparationReady(stats,spatial) {
  if(!spatial)return true;
  // A dense coarse guard legitimately has no fine tree; pending zero alone does
  // not imply it must construct one. Require the stable-view selection decision.
  return stats.spatialSettled===true&&stats.spatialPendingPages===0;
}

/** Compare SDK poses, including wrapped heading, instead of trusting requested commands. */
export function mapCameraPoseMatches(requested, actual) {
  if(!requested)return Boolean(actual);
  if(!actual||actual.mode!==requested.mode)return false;
  if(requested.mode==='baidu') {
    if(!actual.center||!requested.center)return false;
    const angleDifference=Math.abs(((actual.heading-requested.heading+540)%360)-180);
    return Math.abs(actual.center.lng-requested.center.lng)<=1e-6&&Math.abs(actual.center.lat-requested.center.lat)<=1e-6&&
      Math.abs(actual.zoom-requested.zoom)<=1e-3&&angleDifference<=.1&&Math.abs(actual.tilt-requested.tilt)<=.1;
  }
  return ['x','y','scale','heading'].every(key=>Number.isFinite(actual[key])&&
    Math.abs(actual[key]-requested[key])<=1e-6*Math.max(1,Math.abs(requested[key])));
}

function sameMatrix(left,right) {
  return Boolean(left?.length===16&&right?.length===16&&left.every((value,index)=>
    Number.isFinite(value)&&Number.isFinite(right[index])&&Math.abs(value-right[index])<=1e-6*Math.max(1,Math.abs(value),Math.abs(right[index]))));
}

/** Submitted GL byte counts are independent of requested updates and GPU completion. */
export function summarizeMapUploads(before, after, samples) {
  const delta=(key)=>Number.isFinite(before?.[key])&&Number.isFinite(after?.[key])?after[key]-before[key]:null;
  const indexBytes=samples.reduce((sum,frame)=>sum+(Number.isFinite(frame.indexUploadedBytes)?frame.indexUploadedBytes:0),0);
  const total=delta('uploadedBytes');
  return {before:copy(before),after:copy(after),uploadedBytesDelta:total,spatialIndexUploadedBytes:indexBytes,
    colorUploadedBytes:total!==null&&total>=indexBytes?total-indexBytes:null,
    geometryAndColorUploadCpuMs:delta('glUploadSubmissionMs'),
    spatialIndexUploadCpuMs:samples.reduce((sum,frame)=>sum+(Number.isFinite(frame.indexUploadSubmissionMs)?frame.indexUploadSubmissionMs:0),0),
    pendingAtSampleStart:Number.isFinite(before?.stagingRevision)&&Number.isFinite(before?.committedRevision)?before.stagingRevision>before.committedRevision:null,
    pendingAtSampleBoundary:Number.isFinite(after?.stagingRevision)&&Number.isFinite(after?.committedRevision)?after.stagingRevision>after.committedRevision:null,
    interpretation:'GL upload calls issued within the sample boundary; no appended geometry and adaptive LOD disabled, so total minus spatial-index bytes is color data. Pending final updates are excluded, not assumed submitted. GPU execution is not timed.'};
}

/** Callback cadence is an observation of the browser/SDK, not physical presentation. */
export function summarizeMapFrames(intervals, referenceMs) {
  const valid = intervals.filter(value=>Number.isFinite(value)&&value>=0);
  const average = mean(valid);
  return {samples:valid.length, meanMs:average, fpsMean:average>0 ? 1000/average : null,
    p95Ms:percentile(valid,.95), p99Ms:percentile(valid,.99), maxMs:valid.length?Math.max(...valid):null,
    slowThresholdMs:Number.isFinite(referenceMs)?referenceMs*1.5:null,
    slowFrames:Number.isFinite(referenceMs)?valid.filter(value=>value>referenceMs*1.5).length:null,
    slowFrameRatio:Number.isFinite(referenceMs)&&valid.length?valid.filter(value=>value>referenceMs*1.5).length/valid.length:null};
}

/** The camera path depends on wall time, so all methods receive the same trajectory. */
export function mapExperimentView(original, scenario, elapsedMs) {
  const angle = elapsedMs/4000*Math.PI*2;
  if(original.mode==='baidu') {
    const local = {...original, center:{...original.center}, zoom:clamp(original.zoom+2,3,21), heading:0, tilt:0};
    if(scenario!=='motion') return local;
    return {...local,
      center:{lng:original.center.lng+.0025*Math.sin(angle),lat:original.center.lat+.0018*Math.sin(angle*2)},
      zoom:clamp(original.zoom+1.2+.6*Math.sin(angle),3,21),
      heading:45*Math.sin(angle), tilt:22.5*(1-Math.cos(angle))};
  }
  const local = {...original, scale:clamp(original.scale*4,.0005,16), heading:0};
  if(scenario!=='motion') return local;
  return {...local, x:original.x+220*Math.sin(angle), y:original.y+160*Math.sin(angle*2),
    scale:clamp(original.scale*Math.pow(2,1.2+.6*Math.sin(angle)),.0005,16),
    heading:Math.PI/4*Math.sin(angle)};
}

function publicMetadata(value) {
  if(Array.isArray(value)) return value.map(publicMetadata);
  if(value&&typeof value==='object') return Object.fromEntries(Object.entries(value)
    .filter(([key])=>! /^(ak|apiKey|accessToken|token|password|secret)$/i.test(key))
    .map(([key,item])=>[key,publicMetadata(item)]));
  return value;
}

// Compatibility fallback: no subscriptions are changed and no geometry is copied.
function ordinaryTargets(renderer) {
  if(typeof renderer.getColorUpdateTargets==='function') return renderer.getColorUpdateTargets(2);
  const byPage = new Map();
  for(const [id,bindings] of renderer._featureBindings||[]) {
    if(!bindings.length||bindings.some(binding=>binding.page.kind!=='points'||binding.end-binding.start!==1)) continue;
    const binding=bindings[0], color=Array.from(binding.page.colors.subarray(binding.start*4,binding.start*4+4));
    if(color[0]>=210&&color[1]<240&&color[2]<120) continue;
    if(bindings.some(item=>color.some((channel,index)=>item.page.colors[item.start*4+index]!==channel))) continue;
    const list=byPage.get(binding.page)||[];list.push({id,color,vertex:binding.start});byPage.set(binding.page,list);
  }
  const candidates=[...byPage.values()].filter(list=>list.length>=2);
  candidates.forEach(list=>list.sort((a,b)=>a.vertex-b.vertex));
  candidates.sort((a,b)=>(b.at(-1).vertex-b[0].vertex)-(a.at(-1).vertex-a[0].vertex));
  return candidates.length ? [candidates[0][0],candidates[0].at(-1)].map(({id,color})=>({id,color})) : [];
}

/** Same loaded data and SDK instance; independent rAF and business onRender samples. */
export function initMapFrameExperiment({getRenderer,getConfig,isBusy,onActiveChange,onPhase,
  onShowMap,onShowResults,stopNeural,getEnvironment}) {
  const $=id=>document.getElementById(id), records=[];
  const section=document.createElement('section');section.className='lod-experiment map-frame-experiment';
  section.innerHTML=`<h3>百度地图整体帧节奏对照</h3>
    <p class="helper-text">同一份数据与同一百度地图实例，比较空业务层、输入分页、仅稀疏更新、仅空间筛选、组合优化；分别识别两个优化因素的收益。三个场景轮换测试：静止局部视角、连续相机路径、每 100 ms 更新两个普通点。进入视野至分段建树完成单独计时，记录期间的回调间隔与长任务；之后预热 1 秒、采样 4 秒，rAF 与业务 onRender 分开记录。</p>
    <div class="bench-actions"><label class="field-label" for="map-frame-repeats" style="margin:0;gap:8px">重复轮数 <select id="map-frame-repeats" style="width:110px"><option value="3">3 轮快测</option><option value="5" selected>5 轮正式</option></select></label>
      <label class="field-label" for="map-frame-camera" style="margin:0;gap:8px">视角 <select id="map-frame-camera" style="width:150px"><option value="local" selected>局部 / 基准 14 级</option><option value="overview">全域 / 基准 12 级</option></select></label>
      <button id="map-frame-start" class="secondary-button" type="button">开始真实地图析因对照</button><button id="map-frame-stop" class="secondary-button" type="button" disabled>停止</button></div>
    <p id="map-frame-progress" class="benchmark-progress" role="status">请先连接百度地图并完成数据加载。五轮共 75 组，约需 7 分钟；保持前台，勿手动操作地图。</p>
    <div class="table-scroll"><table class="results-table"><thead><tr><th>环境／场景／方法／轮</th><th>rAF FPS</th><th>rAF P95 / P99 ms</th><th>业务回调 FPS</th><th>业务 P95 ms</th><th>提交顶点均值</th><th>慢 rAF／长任务</th><th>有效性</th></tr></thead><tbody id="map-frame-results"></tbody></table></div>
    <p class="helper-text">FPS 表示回调节奏，不是屏幕物理呈现帧率。空业务层仍保留自定义层回调开销。关闭自适应 LOD，保留风险规则；底图缓存与 SDK 内部工作无法完全隔离，记录预热及加载事件。页面隐藏、窗口尺寸改变或手动操作会终止并保留无效样本。百度底图真实，不代表叠加的业务数据来自百度。</p>`;
  $('bench-view').append(section);
  const overlay=document.createElement('div');overlay.hidden=true;
  Object.assign(overlay.style,{position:'absolute',right:'48px',top:'52px',zIndex:'50',maxWidth:'75%',
    background:'#0b1a24ee',border:'1px solid #304d60',borderRadius:'5px',padding:'8px 10px',fontSize:'10px',color:'#b4d5e2'});
  const liveStatus=document.createElement('span'), liveStop=document.createElement('button');
  liveStop.type='button';liveStop.className='secondary-button';liveStop.textContent='停止对照';liveStop.style.marginLeft='8px';
  overlay.append(liveStatus,liveStop);$('map-stage').append(overlay);
  let running=false, active=null, phase=null;

  function status(message) { $('map-frame-progress').textContent=message;liveStatus.textContent=message;onPhase?.(message); }
  function stop(reason='用户停止') { if(active) active.cancelReason=reason; }
  function renderTable() {
    const fragment=document.createDocumentFragment();
    for(const record of records) {
      const row=document.createElement('tr');
      const values=[`${record.mapMode==='baidu'?'百度':'沙盒'}／${record.scenarioLabel}／${record.methodLabel}／${record.repeat}`,
        format(record.raf.fpsMean),`${format(record.raf.p95Ms)} / ${format(record.raf.p99Ms)}`,
        format(record.business.fpsMean),format(record.business.p95Ms),
        record.businessCounts.verticesMean===null?'—':Math.round(record.businessCounts.verticesMean).toLocaleString('zh-CN'),
        `${record.raf.slowFrames??'—'} / ${record.longTasks.length}`,record.valid?'有效':`无效：${record.invalidReason}`];
      values.forEach(value=>{const cell=document.createElement('td');cell.textContent=value;row.append(cell);});fragment.append(row);
    }
    $('map-frame-results').replaceChildren(fragment);
  }
  function currentRect() { const rect=$('map-container').getBoundingClientRect();return {width:rect.width,height:rect.height,dpr:devicePixelRatio}; }
  function assertActive(allowRectChange=false) {
    if(active.cancelReason) throw new Error(active.cancelReason);
    if(document.visibilityState!=='visible') throw new Error('页面进入后台');
    if(getRenderer()!==active.renderer) throw new Error('渲染器实例发生变化');
    const stats=active.renderer.getStats(), rect=currentRect();
    if(stats.mode!==active.mode) throw new Error('地图模式发生变化');
    if(stats.contextLost||stats.lastError) throw new Error(stats.lastError||'WebGL 上下文丢失');
    if(stats.features!==active.features||stats.totalVertices!==active.totalVertices) throw new Error('加载数据发生变化');
    if(!allowRectChange&&(rect.width<=0||rect.height<=0||Math.abs(rect.width-active.rect.width)>1||Math.abs(rect.height-active.rect.height)>1||rect.dpr!==active.rect.dpr)) throw new Error('地图区域尺寸或像素比例发生变化');
  }
  function waitCameraReady(requested,{allowRectChange=false}={}) {
    return new Promise((resolve,reject)=>{
      const begun=performance.now(),firstSerial=active.frameSerial;let lastSerial=firstSerial,
        previousMatrix=null,previousRect=null,previousActual=null,stableFrames=0,stableSince=null;
      const tick=at=>{
        try {
          assertActive(allowRectChange);
          const rect=currentRect(),actual=active.renderer.getViewState(),matrix=Array.from(active.renderer.matrix||[]);
          if(phase?.entryCapture) {
            if(phase.entry.lastRaf!==null)phase.entry.rafIntervalsMs.push(at-phase.entry.lastRaf);
            phase.entry.lastRaf=at;
          }
          if(active.frameSerial!==lastSerial) {
            const sameRect=previousRect&&Math.abs(previousRect.width-rect.width)<=.5&&Math.abs(previousRect.height-rect.height)<=.5&&previousRect.dpr===rect.dpr;
            const ready=rect.width>0&&rect.height>0&&mapCameraPoseMatches(requested,actual)&&
              previousActual&&mapCameraPoseMatches(previousActual,actual)&&sameRect&&sameMatrix(matrix,previousMatrix);
            if(ready) {stableFrames++;if(stableSince===null)stableSince=at;}else {stableFrames=0;stableSince=null;}
            previousMatrix=matrix;previousRect=rect;previousActual=copy(actual);lastSerial=active.frameSerial;
            if(stableFrames>=3&&stableSince!==null&&at-stableSince>=80) {
              if(allowRectChange)active.rect=rect;
              resolve({ready:true,requestedView:copy(requested),actualView:copy(actual),elapsedMs:at-begun,
                stableFrames,stableDurationMs:at-stableSince,renderFrames:active.frameSerial-firstSerial,
                mapRect:copy(rect),mvp:matrix,poseTolerance:{centerDegrees:1e-6,zoom:1e-3,headingDegrees:.1,tiltDegrees:.1},
                mvpRelativeTolerance:1e-6,timeoutMs:active.cameraReadyTimeoutMs});return;
            }
          }
          if(at-begun>=active.cameraReadyTimeoutMs)throw new Error('相机未在限定时间内达到实际视角、MVP 与画布尺寸稳定状态');
          active.raf=requestAnimationFrame(tick);
        }catch(error){
          if(phase)phase.readiness.cameraReady={ready:false,requestedView:copy(requested),actualView:copy(active.renderer.getViewState()),
            elapsedMs:performance.now()-begun,stableFrames,renderFrames:active.frameSerial-firstSerial,timeoutMs:active.cameraReadyTimeoutMs,error:error.message};
          reject(error);
        }
      };
      active.raf=requestAnimationFrame(tick);
    });
  }
  function waitSpatialReady(spatial) {
    return new Promise((resolve,reject)=>{
      const begun=performance.now(),firstSerial=active.frameSerial;let firstReadySerial=null;
      const tick=at=>{
        try {
          assertActive();
          if(phase?.entryCapture) {
            if(phase.entry.lastRaf!==null)phase.entry.rafIntervalsMs.push(at-phase.entry.lastRaf);
            phase.entry.lastRaf=at;
          }
          const stats=active.renderer.getStats();
          const ready=active.frameSerial>firstSerial&&spatialPreparationReady(stats,spatial);
          if(!ready)firstReadySerial=null;
          else if(firstReadySerial===null)firstReadySerial=active.frameSerial;
          // The completion frame intentionally still draws complete pages; one
          // subsequent business frame must have a chance to use the new index.
          if(ready&&(!spatial||active.frameSerial>firstReadySerial)) {
            resolve({ready:true,elapsedMs:at-begun,renderFrames:active.frameSerial-firstSerial,
              pendingPages:finite(stats.spatialPendingPages),finePages:finite(stats.spatialFinePages),
              required:spatial,spatialSettled:stats.spatialSettled??null,timeoutMs:active.spatialReadyTimeoutMs,
              interpretation:'Spatial methods require pending zero, a stable selection decision, and a subsequent business render that can consume a completed fine index. Dense coarse fallback requires no fine construction.'});return;
          }
          if(at-begun>=active.spatialReadyTimeoutMs)throw new Error('空间细索引未在限定时间内完成，冷启动样本保留且不进入正式采样');
          active.raf=requestAnimationFrame(tick);
        }catch(error){reject(error);}
      };
      active.raf=requestAnimationFrame(tick);
    });
  }
  function collect(ms,{capture=false,motion=null,update=false,reference=false}={}) {
    return new Promise((resolve,reject)=>{
      const begun=performance.now(), intervals=[];let previous=null,lastUpdate=0;
      const tick=at=>{
        try {
          assertActive();
          const elapsed=at-begun;
          if(motion) {
            const view=mapExperimentView(active.baseView,'motion',elapsed+(capture?active.warmupMs:0));
            const actualView=active.renderer.setViewState(view);
            if(capture) {
              phase.cameraCommandCount++;
              // The path still executes each rAF; only evidence is decimated to 10 Hz.
              if(elapsed>=phase.nextCameraEvidenceAt) {
                phase.cameraCommands.push({atMs:elapsed,view:copy(view),actualView:copy(actualView)});
                phase.nextCameraEvidenceAt=Math.floor(elapsed/100+1)*100;
              }
            }
          }
          if(update) {
            const slot=Math.floor(elapsed/100);
            if(slot>lastUpdate) {
              const skipped=slot-lastUpdate-1, updates=active.targets.map(target=>({id:target.id,color:[slot%2?64:70,slot%2?180:195,slot%2?170:185,target.color[3]]}));
              const begunUpdate=performance.now(), result=active.renderer.updateFeatureColors(updates);
              phase.updates.push({atMs:elapsed,scheduledAtMs:slot*100,skippedSlots:skipped,cpuMs:performance.now()-begunUpdate,
                updated:result.updated,updatedVertices:result.updatedVertices,revision:result.revision});
              lastUpdate=slot;
            }
          }
          if(previous!==null&&(capture||reference))intervals.push(at-previous);previous=at;
          if(capture)phase.rafSamples.push({atMs:at-phase.sampleStarted,intervalMs:intervals.length?intervals.at(-1):null});
          if(elapsed>=ms) resolve(intervals);else active.raf=requestAnimationFrame(tick);
        }catch(error){reject(error);}
      };
      active.raf=requestAnimationFrame(tick);
    });
  }
  function onBusinessFrame(info) {
    if(active)active.frameSerial++;
    if(phase?.entryCapture) {
      const elapsed=performance.now()-phase.phaseStarted;
      if(phase.entry.firstBusinessRenderWallMs===null)phase.entry.firstBusinessRenderWallMs=elapsed;
      if(info.vertices>0&&phase.entry.firstNonemptyBusinessRenderWallMs===null)phase.entry.firstNonemptyBusinessRenderWallMs=elapsed;
      phase.entry.businessSamples.push({atMs:elapsed,vertices:finite(info.vertices),drawCalls:finite(info.drawCalls),
        frameCpuMs:finite(info.frameMs),frameIntervalMs:finite(info.frameInterval),matrixChanged:info.matrixChanged??null,
        spatialSettled:info.spatialSettled??null,...buildSnapshot(info)});
    }
    if(!phase?.sampling) return;
    const at=Number.isFinite(info.time)?info.time:performance.now();
    if(at<phase.sampleStarted) return;
    const matrix=active.renderer.matrix;
    let matrixChanged=info.matrixChanged;
    if(typeof matrixChanged!=='boolean') {
      matrixChanged=matrix?(!phase.previousMatrix||matrix.some((value,index)=>value!==phase.previousMatrix[index])):null;
      if(matrix)phase.previousMatrix=Array.from(matrix);
    }
    const interval=phase.previousBusinessAt===null?null:at-phase.previousBusinessAt;phase.previousBusinessAt=at;
    if(interval!==null&&interval>=0)phase.businessIntervals.push(interval);
    phase.businessSamples.push({atMs:at-phase.sampleStarted,intervalMs:interval,matrixChanged,
      frameCpuMs:finite(info.frameMs),previousFrameTelemetryCpuMs:finite(info.previousFrameTelemetryCpuMs),
      previousFrameTotalCpuMs:finite(info.previousFrameTotalCpuMs),vertices:finite(info.vertices),pointsSubmitted:finite(info.pointsSubmitted),
      drawCalls:finite(info.drawCalls),pointAlertsDrawn:finite(info.pointAlertsDrawn),
      spatialSettled:info.spatialSettled??null,cacheHits:finite(info.cacheHits),nodesTested:finite(info.nodesTested),
      queryMs:finite(info.queryMs),indexMs:finite(info.indexMs),indexUploadedBytes:finite(info.indexUploadedBytes),
      indexUploadSubmissionMs:finite(info.indexUploadSubmissionMs),uploadedBytes:finite(info.uploadedBytes),
      glUploadSubmissionMs:finite(info.glUploadSubmissionMs),stagingRevision:finite(info.stagingRevision),committedRevision:finite(info.committedRevision),
      coarseQueryMs:finite(info.coarseQueryMs),coarseDensityGuardPages:finite(info.coarseDensityGuardPages),
      coarseBucketsTested:finite(info.coarseBucketsTested),...buildSnapshot(info),
      spatialDenseFallbackPages:finite(info.spatialDenseFallbackPages),lodStride:finite(info.lodStride)});
  }
  function finalizePhase(valid,invalidReason=null) {
    if(!phase)return;
    phase.sampling=false;phase.sampleEnded=performance.now();
    phase.readiness.afterSampling=submissionSnapshot(active.renderer.getStats());
    if(phase.entryCapture) {
      phase.entryCapture=false;phase.entry.elapsedMs=phase.sampleEnded-phase.phaseStarted;
      phase.entry.after=submissionSnapshot(active.renderer.getStats());phase.entry.buildDeltas=buildDeltas(phase.entry.before,phase.entry.after);
      phase.entry.raf=summarizeMapFrames(phase.entry.rafIntervalsMs,active.referenceMs);delete phase.entry.lastRaf;
    }
    if(active.observer)active.longTasks.push(...active.observer.takeRecords().map(entry=>({startTime:entry.startTime,duration:entry.duration,name:entry.name})));
    phase.entry.longTasks=active.longTasks.filter(entry=>entry.startTime<phase.phaseStarted+phase.entry.elapsedMs&&entry.startTime+entry.duration>phase.phaseStarted)
      .map(entry=>({...entry,atMs:entry.startTime-phase.phaseStarted}));
    phase.entry.construction=summarizeBuildPreparation(phase.entry.businessSamples);
    phase.entry.interpretation='Cold entry includes camera readiness and, for visible spatial methods, full fine-index readiness before warmup; first business render is a CPU/GL submission callback, not proof of displayed pixels. Spatial formal samples begin with no pending fine work and retained indexes may already be warm.';
    const frames=phase.businessSamples;
    const values=key=>frames.map(frame=>frame[key]).filter(Number.isFinite);
    const longTasks=active.longTasks.filter(entry=>entry.startTime<phase.sampleEnded&&entry.startTime+entry.duration>phase.sampleStarted)
      .map(entry=>({...entry,atMs:entry.startTime-phase.sampleStarted,overlapMs:Math.max(0,Math.min(entry.startTime+entry.duration,phase.sampleEnded)-Math.max(entry.startTime,phase.sampleStarted))}));
    const rafIntervals=phase.rafSamples.map(item=>item.intervalMs).filter(Number.isFinite);
    const actualValid=valid&&rafIntervals.length>0&&frames.length>1;
    const record={schemaVersion:1,kind:'map-frame-comparison',runId:active.id,implementationVersion:IMPLEMENTATION_VERSION,
      startedAt:phase.startedAt,endedAt:new Date().toISOString(),repeat:phase.repeat,order:phase.order,
      scenario:phase.scenario.id,scenarioLabel:phase.scenario.label,method:phase.method.id,methodLabel:phase.method.label,
      mapMode:active.mode,valid:actualValid,invalidReason:invalidReason||(actualValid?null:'rAF 或业务回调样本不足'),
      dataset:copy(active.config),features:active.features,totalVertices:active.totalVertices,
      environment:publicMetadata(getEnvironment?.()),userAgent:navigator.userAgent,graphics:active.renderer.getGraphicsInfo?.()||null,
      viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,mapCss:copy(active.rect)},
      reference:{intervalMs:active.referenceMs,source:'20th percentile of foreground rAF during map-only reference',rawIntervalsMs:active.referenceIntervals},
      protocol:{repeats:active.repeats,warmupMs:active.warmupMs,sampleMs:active.sampleMs,
        implementationVersion:IMPLEMENTATION_VERSION,design:'factorial',factorial:true,
        methods:METHODS.map(method=>method.id),methodsDeclared:METHODS.map(method=>({id:method.id,spatial:method.spatial,
          dirtyMode:method.dirtyMode,businessLayersVisible:method.visible,spatialBuildPolicy:'lazy',spatialRetainOnDisable:true,
          spatialBuildExecution:'progressive'})),
        scenarios:SCENARIOS.map(scenario=>scenario.id),phaseCount:active.repeats*METHODS.length*SCENARIOS.length,
        factors:{spatial:[false,true],dirtyMode:['envelope','ranges']},factorLevels:{spatial:phase.method.spatial,dirtyMode:phase.method.dirtyMode},
        ordering:'cyclic method and scenario order rotated between rounds',sameMapInstance:true,sameLoadedData:true,
        adaptiveLod:false,riskPreservation:true,renderPolicy:'continuous',baseView:copy(active.baseView),cameraPreset:active.cameraPreset,
        cameraCenterSource:active.cameraCenterSource,initialCameraReady:copy(active.initialCameraReady),
        spatialBuildPolicy:'lazy',spatialRetainOnDisable:true,spatialBuildExecution:'progressive',
        spatialBuildBudgetMs:finite(active.renderer.getStats().optimization.spatialBuildBudgetMs),
        spatialBuildChunkPrimitives:finite(active.renderer.getStats().optimization.spatialBuildChunkPrimitives),
        fineReadyBeforeWarmup:true,spatialReadyTimeoutMs:active.spatialReadyTimeoutMs,
        indexLifecycle:'Retained lazy progressive indexes shared across phases; camera and full index-ready entry costs captured before warmup. Synchronous versus progressive cold construction belongs to the standalone local browser experiment.',
        pathPeriodMs:4000,cameraNoAnimationRequested:true,colorUpdateIntervalMs:phase.scenario.id==='updates'?100:null,
        cameraCommandCadence:'each foreground rAF',cameraEvidenceIntervalMs:100,cameraCommandCount:phase.cameraCommandCount,
        updateTargetIds:phase.scenario.id==='updates'?active.targets.map(target=>target.id):[],
        mapOnlyHasCustomLayerCallback:true,tilesAndSdkWorkIncluded:true,
        interpretation:'Explicit temporary continuous rendering for preparation and all formal phases; original policy restored afterward. rAF and onRender callback cadence; neither is physical display FPS or GPU completion time'},
      readiness:copy(phase.readiness),optimization:copy(active.renderer.getStats().optimization),layers:copy(active.renderer.layers),
      raf:summarizeMapFrames(rafIntervals,active.referenceMs),business:summarizeMapFrames(phase.businessIntervals,active.referenceMs),
      businessCounts:{verticesMean:mean(values('vertices')),pointsMean:mean(values('pointsSubmitted')),
        drawCallsMean:mean(values('drawCalls')),frameCpuMeanMs:mean(values('frameCpuMs')),frameCpuP95Ms:percentile(values('frameCpuMs'),.95),
        cacheHitsMean:mean(values('cacheHits')),matrixChanges:frames.filter(frame=>frame.matrixChanged).length,
        settledFrames:frames.filter(frame=>frame.spatialSettled).length,indexUploadedBytes:values('indexUploadedBytes').reduce((sum,value)=>sum+value,0)},
      rafIntervalsMs:rafIntervals,rafSamples:phase.rafSamples,businessIntervalsMs:phase.businessIntervals,businessSamples:frames,
      uploadSubmission:summarizeMapUploads(phase.readiness.beforeSampling,phase.readiness.afterSampling,frames),
      entryPreparation:copy(phase.entry),
      actualSampleMs:phase.sampleEnded-phase.sampleStarted,updates:phase.updates,cameraCommands:phase.cameraCommands,
      longTasks,longTaskApiAvailable:active.longTaskApiAvailable,mapEvents:phase.mapEvents,interactions:phase.interactions,
      warmupExcluded:true, gpuExecutionMs:null,displayPresentationFps:null};
    records.push(record);phase=null;renderTable();return record;
  }

  async function start({allowSandbox=false,repeats=Number($('map-frame-repeats').value),warmupMs=1000,sampleMs=4000,referenceMs=1000,
    cameraPreset=$('map-frame-camera').value,cameraCenter=null,cameraReadyTimeoutMs=5000,spatialReadyTimeoutMs=30000}={}) {
    if(running||isBusy?.()){status('请等待当前加载或实验结束。');return {ok:false,error:'busy'};}
    const renderer=getRenderer(),config=getConfig(),stats=renderer?.getStats();
    if(!renderer||!config||!stats?.features){status('请先完成一次空间数据加载。');return {ok:false,error:'no-data'};}
    if(stats.mode!=='baidu'&&!allowSandbox){status('尚未连接百度地图。请在“地图接入”填入浏览器端 AK 并连接，真实测试不会用沙盒替代。');return {ok:false,error:'baidu-not-connected'};}
    if(stats.contextLost||stats.lastError||stats.stagingRevision!==stats.committedRevision){status('渲染器尚未就绪，请等待数据提交或解决地图错误。');return {ok:false,error:'renderer-not-ready'};}
    if(typeof renderer.subscribeFrames!=='function'||typeof renderer.getViewState!=='function'||typeof renderer.setViewState!=='function') {
      status('当前渲染器缺少地图实验接口。');return {ok:false,error:'missing-interface'};
    }
    if(!Number.isInteger(repeats)||repeats<1||repeats>5||![warmupMs,sampleMs,referenceMs].every(value=>Number.isFinite(value)&&value>0&&value<=60000)) {
      status('轮数或采样时长无效。');return {ok:false,error:'invalid-parameters'};
    }
    if(!['overview','local'].includes(cameraPreset)||!Number.isFinite(cameraReadyTimeoutMs)||cameraReadyTimeoutMs<=0||cameraReadyTimeoutMs>60000||
      !Number.isFinite(spatialReadyTimeoutMs)||spatialReadyTimeoutMs<=0||spatialReadyTimeoutMs>60000||
      cameraCenter&&(!Number.isFinite(cameraCenter.lng)||!Number.isFinite(cameraCenter.lat)||Math.abs(cameraCenter.lng)>180||Math.abs(cameraCenter.lat)>90)) {
      status('视角档位、中心或就绪等待时长无效。');return {ok:false,error:'invalid-camera-parameters'};
    }
    if(document.visibilityState!=='visible'){status('请将页面保持在前台。');return {ok:false,error:'background'};}
    const tracked=renderer.getTrackedFeatureIds?.();
    const targets=ordinaryTargets(renderer).slice(0,2).map(target=>({id:target.id,color:Array.from(target.color)}));
    if(targets.length!==2){
      if(tracked)renderer.trackFeatures(tracked);
      status('需要两个普通设备点进行相同更新负载；请完成数据加载后再运行。');return {ok:false,error:'two-ordinary-points-required'};
    }
    const controls=[...document.querySelectorAll('[data-mode],[data-view],[data-workspace-control]'),...['start-button','map-start-button','benchmark-button',
      'count','seed','delay','chunk','layer-points','layer-lines','layer-polygons','zoom-in','zoom-out','rotate-view','reset-view',
      'neural-start','neural-jump','lod-benchmark','connect-button','settings-button','map-frame-start','map-frame-repeats','map-frame-camera',
      'render-policy','demand-start','loading-benchmark-button','loading-benchmark-sizes'].map($)].filter(Boolean);
    const disabled=controls.map(element=>element.disabled);
    const original={view:copy(renderer.getViewState()),optimization:copy(stats.optimization),adaptive:renderer.adaptive,
      risk:stats.riskPreservation,layers:{...renderer.layers},tracked,renderPolicy:renderer.renderPolicy||'continuous'};
    running=true;onActiveChange?.(true);stopNeural?.();onShowMap?.();
    controls.forEach(element=>element.disabled=true);$('map-frame-stop').disabled=false;overlay.hidden=false;
    active={id:'map-frame-'+Date.now(),renderer,config:publicMetadata(copy(config)),mode:stats.mode,features:stats.features,
      totalVertices:stats.totalVertices,original,targets,repeats,warmupMs,sampleMs,cancelReason:null,raf:0,
      rect:currentRect(),longTasks:[],longTaskApiAvailable:false,referenceMs:null,referenceIntervals:[],
      frameSerial:0,cameraPreset,cameraReadyTimeoutMs,spatialReadyTimeoutMs,baseView:null,cameraCenterSource:null,initialCameraReady:null};
    const runId=active.id;let unsubscribe=null, outcome={ok:false,runId,error:null};
    const map=renderer.getBaiduMap?.();const mapRemovers=[];
    try {
      renderer.setRenderPolicy?.('continuous');
      unsubscribe=renderer.subscribeFrames(onBusinessFrame);
      if(typeof PerformanceObserver!=='undefined'&&PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
        active.observer=new PerformanceObserver(list=>active?.longTasks.push(...list.getEntries().map(entry=>({startTime:entry.startTime,duration:entry.duration,name:entry.name}))));
        active.observer.observe({entryTypes:['longtask']});active.longTaskApiAvailable=true;
      }
      if(map?.addEventListener)for(const type of ['tilesloaded','moveend','zoomend','headingend','tiltend']) {
        const listener=()=>{if(phase)phase.mapEvents.push({type,atMs:performance.now()-(phase.sampleStarted||phase.phaseStarted)});};
        map.addEventListener(type,listener);mapRemovers.push(()=>map.removeEventListener?.(type,listener));
      }
      renderer.setAdaptive(false);renderer.setRiskPreservation(true);
      renderer.setLayers({points:false,lines:false,polygons:false});
      status('地图显示后，等待实际视角、MVP 与画布尺寸稳定…');
      const shownReady=await waitCameraReady(null,{allowRectChange:true});
      original.view=copy(renderer.getViewState());
      if(active.mode==='baidu') {
        let center=cameraCenter||renderer.getStats().referenceCenter;
        active.cameraCenterSource=cameraCenter?'explicit geographic center':'renderer referenceCenter';
        if(!cameraCenter&&cameraPreset==='local'&&config.dataSource!=='baidu-poi') {
          const geographic=typeof renderer.unprojectLocalPoint==='function'?renderer.unprojectLocalPoint([-1200,900]):renderer._layer?.unprojectFromLayer([-1200,900]);
          if(!geographic?.length||!geographic.every(Number.isFinite))throw new Error('无法将固定 R06 局部中心转换为真实地图坐标');
          center={lng:geographic[0],lat:geographic[1]};active.cameraCenterSource='fixed synthetic region R06 at local metres [-1200,900]';
        }
        if(!center||![center.lng,center.lat].every(Number.isFinite))throw new Error('渲染器没有有效的地理参考中心');
        active.baseView={mode:'baidu',center:{...center},zoom:cameraPreset==='local'?14:12,heading:0,tilt:0};
      }else {
        active.baseView={...original.view,heading:0};active.cameraCenterSource='sandbox loaded view (functional verification only)';
      }
      const referenceView=mapExperimentView(active.baseView,'static',0);
      renderer.setViewState(referenceView);
      const referenceReady=await waitCameraReady(referenceView);
      active.initialCameraReady={shown:shownReady,reference:referenceReady};
      status(`${stats.mode==='baidu'?'百度真实地图':'本地沙盒（开发验证）'}：测量前台 rAF 参考预算…`);
      active.referenceIntervals=await collect(referenceMs,{reference:true});
      active.referenceMs=percentile(active.referenceIntervals,.2);
      if(!Number.isFinite(active.referenceMs)||active.referenceMs<=0)throw new Error('未得到可靠的前台 rAF 参考间隔');
      for(let repeat=0;repeat<repeats;repeat++)for(let sceneIndex=0;sceneIndex<SCENARIOS.length;sceneIndex++) {
        const scenario=SCENARIOS[(sceneIndex+repeat)%SCENARIOS.length];
        for(let order=0;order<METHODS.length;order++) {
          assertActive();const method=METHODS[(order+repeat)%METHODS.length];
          const label=`${stats.mode==='baidu'?'百度':'沙盒验证'} ${repeat+1}/${repeats} · ${scenario.label} · ${method.label}`;
          status(label+' · 相机就绪检查');
          const prepared=renderer.getStats(), phaseStarted=performance.now();
          phase={method,scenario,repeat:repeat+1,order:order+1,phaseStarted,startedAt:new Date().toISOString(),
            sampling:false,sampleStarted:phaseStarted,rafSamples:[],businessSamples:[],businessIntervals:[],
            previousBusinessAt:null,previousMatrix:null,cameraCommands:[],cameraCommandCount:0,nextCameraEvidenceAt:0,updates:[],interactions:[],mapEvents:[],
            entryCapture:true,entry:{rafIntervalsMs:[],businessSamples:[],lastRaf:null,before:submissionSnapshot(prepared),
              firstBusinessRenderWallMs:null,firstNonemptyBusinessRenderWallMs:null,fullIndexReadyWallMs:null},
            readiness:{beforeConfiguration:{...submissionSnapshot(prepared),contextLost:prepared.contextLost,lastError:prepared.lastError}}};
          const configurationStarted=performance.now();
          renderer.updateFeatureColors(targets);renderer.setAdaptive(false);renderer.setRiskPreservation(true);
          renderer.setOptimizationOptions({spatial:method.spatial,spatialPolicy:'settled',settleFrames:3,leafSize:64,
            minExtent:8,maxDepth:16,maxCandidateRatio:.15,dirtyMode:method.dirtyMode,mergeGapBytes:64,maxDirtyRanges:32,
            spatialBuildPolicy:'lazy',spatialRetainOnDisable:true,spatialBuildExecution:'progressive'});
          renderer.setLayers({points:method.visible,lines:method.visible,polygons:method.visible});
          const initialView=mapExperimentView(active.baseView,scenario.id,0);
          renderer.setViewState(initialView);phase.entry.configurationCpuMs=performance.now()-configurationStarted;
          phase.readiness.cameraReady=await waitCameraReady(initialView);
          status(label+' · 等待细索引就绪（冷启动单独记录）');
          phase.readiness.spatialReady=await waitSpatialReady(method.spatial&&method.visible);
          phase.entry.selectionReadyWallMs=performance.now()-phaseStarted;
          if(method.spatial&&method.visible)phase.entry.fullIndexReadyWallMs=phase.entry.selectionReadyWallMs;
          phase.entryCapture=false;phase.entry.elapsedMs=performance.now()-phaseStarted;
          phase.entry.after=submissionSnapshot(renderer.getStats());phase.entry.buildDeltas=buildDeltas(phase.entry.before,phase.entry.after);
          phase.entry.raf=summarizeMapFrames(phase.entry.rafIntervalsMs,active.referenceMs);delete phase.entry.lastRaf;
          const beforeWarmup=renderer.getStats();phase.readiness.beforeWarmup={...submissionSnapshot(beforeWarmup),
            contextLost:beforeWarmup.contextLost,lastError:beforeWarmup.lastError};
          status(label+' · 预热');
          await collect(warmupMs,{motion:scenario.id==='motion'});
          const ready=renderer.getStats();phase.readiness.afterWarmup={...submissionSnapshot(ready),
            spatialBuildDeltaMs:ready.spatialBuildMs-beforeWarmup.spatialBuildMs,
            coarseBuildDeltaMs:Number.isFinite(ready.coarseBuildMs)&&Number.isFinite(beforeWarmup.coarseBuildMs)?ready.coarseBuildMs-beforeWarmup.coarseBuildMs:null,
            ...buildDeltas(beforeWarmup,ready),spatialSettled:ready.spatialSettled,
            contextLost:ready.contextLost,lastError:ready.lastError};
          if(ready.stagingRevision!==ready.committedRevision)throw new Error('预热后仍有未提交数据');
          if(cameraPreset==='local'&&method.visible&&scenario.id!=='motion'&&ready.vertices<=0)throw new Error('局部视窗没有实际提交业务顶点，当前相机或数据覆盖不适合此实验');
          phase.sampleStarted=performance.now();phase.readiness.beforeSampling=submissionSnapshot(renderer.getStats());
          phase.sampling=true;status(label+' · 采样');
          await collect(sampleMs,{capture:true,motion:scenario.id==='motion',update:scenario.id==='updates'});
          finalizePhase(true);
        }
      }
      const completedRecords=records.filter(record=>record.runId===runId),invalidRecords=completedRecords.filter(record=>!record.valid).length;
      const localStatic=completedRecords.filter(record=>record.scenario==='static');
      const coverage={nonemptyLocalBaseline:cameraPreset==='local'?localStatic.filter(record=>record.method==='input-pages').every(record=>record.businessCounts.verticesMean>0):null,
        localSpatialReductionObserved:cameraPreset==='local'?localStatic.filter(record=>record.method==='hybrid').some(record=>{
          const baseline=localStatic.find(other=>other.method==='input-pages'&&other.repeat===record.repeat);
          return baseline&&record.businessCounts.verticesMean>0&&record.businessCounts.verticesMean<baseline.businessCounts.verticesMean;
        }):null};
      outcome={ok:invalidRecords===0,completed:true,runId,records:completedRecords.length,
        validRecords:completedRecords.length-invalidRecords,invalidRecords,coverage};
      status(`${stats.mode==='baidu'?'百度真实地图':'沙盒开发验证'}对照完成，${outcome.validRecords} 组有效、${invalidRecords} 组无效。已保留原始样本；通过“导出实验报告”保存。`);
    }catch(error) {
      if(phase)finalizePhase(false,error.message);
      outcome={ok:false,runId,error:error.message};status('对照中断，当前样本无效：'+error.message);
    }finally {
      if(active?.raf)cancelAnimationFrame(active.raf);
      unsubscribe?.();active?.observer?.disconnect();mapRemovers.forEach(remove=>remove());
      try {
        renderer.updateFeatureColors(targets);
        if(original.tracked)renderer.trackFeatures(original.tracked);
        renderer.setOptimizationOptions(original.optimization);
        renderer.setAdaptive(original.adaptive);renderer.setRiskPreservation(original.risk);
        renderer.setLayers(original.layers);renderer.setViewState(original.view);
        Object.entries(original.layers).forEach(([kind,value])=>{if($('layer-'+kind))$('layer-'+kind).checked=value;});
      }catch(error){outcome.restoreError=error.message;status('对照结束，恢复状态时出错：'+error.message);}
      finally {
        try { renderer.setRenderPolicy?.(original.renderPolicy); }
        catch(error) { outcome.restoreError=outcome.restoreError||error.message; }
      }
      controls.forEach((element,index)=>element.disabled=disabled[index]);$('map-frame-stop').disabled=true;
      overlay.hidden=true;phase=null;active=null;running=false;onActiveChange?.(false);onShowResults?.();
    }
    return outcome;
  }

  $('map-frame-start').addEventListener('click',()=>start());
  $('map-frame-stop').addEventListener('click',()=>stop());liveStop.addEventListener('click',()=>stop());
  document.addEventListener('visibilitychange',()=>{if(running&&document.visibilityState!=='visible')stop('页面进入后台');});
  const userEvent=event=>{
    if(!running||!event.isTrusted||event.target===liveStop||event.target===$('map-frame-stop'))return;
    if(event.type==='keydown'&&['Shift','Control','Alt','Meta'].includes(event.key))return;
    if(phase)phase.interactions.push({type:event.type,atMs:performance.now()-phase.sampleStarted,trusted:true});
    stop('检测到手动操作，避免相机或负载污染');
  };
  ['pointerdown','wheel','keydown'].forEach(type=>document.addEventListener(type,userEvent,{capture:true,passive:true}));
  return {evidence:()=>records,start,stop,interaction(info) {
    if(!running)return;
    if(phase)phase.interactions.push({type:info?.type||'unknown',atMs:performance.now()-phase.sampleStarted,
      source:'renderer-event',trusted:info?.isTrusted===true||info?.userInitiated===true});
    // SDK moveend/zoomend also follow programmed camera commands; they are metadata.
    if(info?.isTrusted===true||info?.userInitiated===true)stop('检测到手动地图操作');
  }};
}
