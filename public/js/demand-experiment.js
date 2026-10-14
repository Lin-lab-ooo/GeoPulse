import {IMPLEMENTATION_VERSION} from './version.js';
import {percentile} from './scheduler.js';
import {loadingCameraView, waitLoadingCamera} from './loading-experiment.js';
import {mapCameraPoseMatches} from './map-frame-experiment.js';

const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const finite = value => Number.isFinite(value) ? value : null;
const labels = {continuous:'持续绘制',demand:'按需绘制'};
const scenarios = ['idle','motion','updates'];
const sceneLabels = {idle:'静止',motion:'相机移动',updates:'每100ms更新两点'};

export function demandTrialPlan(repeats=5) {
  if(!Number.isInteger(repeats)||repeats<1||repeats>5)throw new RangeError('Repeats must be 1–5.');
  const plan=[];
  for(let repeat=1;repeat<=repeats;repeat++)for(const scenario of scenarios)
    for(const policy of repeat%2?['continuous','demand']:['demand','continuous'])
      plan.push({repeat,scenario,policy,ordinal:plan.length+1});
  return plan.map(trial=>({...trial,total:plan.length}));
}

export function summarizeDemandFrames(frames,elapsedMs) {
  const total = key => frames.reduce((sum,frame)=>sum+(Number.isFinite(frame[key])?frame[key]:0),0);
  const cpu=frames.map(frame=>frame.frameMs).filter(Number.isFinite);
  return {businessFrames:frames.length,businessFramesPerSecond:elapsedMs>0?frames.length*1000/elapsedMs:null,
    drawCalls:total('drawCalls'),verticesSubmitted:total('vertices'),renderBodyCpuMs:total('frameMs'),
    renderBodyCpuP95Ms:percentile(cpu,.95),pulseFrames:frames.filter(frame=>frame.pulseActive).length};
}

function applyView(renderer,view) {
  if(view.mode==='baidu')renderer.setViewState({...view,center:{...renderer.getViewState().center}});
  renderer.setViewState(view);
}
const matrixChanged=(left,right)=>left?.length===16&&right?.length===16&&left.some((value,index)=>
  Math.abs(value-right[index])>1e-6*Math.max(1,Math.abs(value),Math.abs(right[index])));
const timeout = (promise,ms,message) => {
  let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms);})])
    .finally(()=>clearTimeout(timer));
};

/** Same loaded geometry/LOD/animation for both policies; no network or POI calls. */
export function initDemandRenderExperiment({getRenderer,getConfig,isBusy,onActiveChange,onPhase,
  onShowMap,onShowResults,stopNeural,getEnvironment}) {
  const $=id=>document.getElementById(id), reports=[];
  let running=false,cancelled=false,interruptionReason=null,active=null;
  const rect=()=>{const value=$('map-container').getBoundingClientRect();return {width:value.width,height:value.height,dpr:devicePixelRatio};};
  const guard=()=>{
    if(cancelled)throw new DOMException('实验已停止','AbortError');
    if(interruptionReason)throw new Error(interruptionReason);
    if(document.visibilityState!=='visible')throw new Error('页面进入后台，保留中断记录');
    const next=rect();
    if(active&&(Math.abs(next.width-active.rect.width)>.5||Math.abs(next.height-active.rect.height)>.5||next.dpr!==active.rect.dpr))
      throw new Error('视窗改变，保留无效记录');
  };
  const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
  async function prepare(renderer,view) {
    renderer.setRenderPolicy('continuous');
    const camera=await waitLoadingCamera(renderer,view,{isCancelled:()=>cancelled,getRect:rect,timeoutMs:6000});
    const began=performance.now();
    let readyFrame=null;
    for(;;) {
      guard();const stats=renderer.getStats();
      if(stats.contextLost||stats.lastError)throw new Error('渲染器异常，不能把停止绘制算作休眠');
      if(stats.spatialSettled&&stats.spatialPendingPages===0&&stats.committedRevision>=stats.stagingRevision) {
        if(readyFrame!==null&&stats.renderScheduling.businessFrames>readyFrame)return {camera,elapsedMs:performance.now()-began,stats:copy(stats)};
        readyFrame??=stats.renderScheduling.businessFrames;
      }else readyFrame=null;
      if(performance.now()-began>30000)throw new Error('建树准备超过30秒');
      await frame();
    }
  }
  async function sample(renderer,trial,view,targets,preparation) {
    const phase={...trial,status:'warming',valid:false,invalidReasons:[],preparation,
      frames:[],rafSamples:[],cameraCommands:[],updates:[]};active.phases.push(phase);
    renderer.setRenderPolicy(trial.policy);
    // Bounded wall-time warmup excludes policy transition from the phase delta;
    // sleeping phases do not require additional business callbacks.
    try{const warm=performance.now();while(performance.now()-warm<200){guard();await frame();guard();}}
    catch(error){phase.status=cancelled?'cancelled':'failed';phase.invalidReasons.push(error.message);throw error;}
    phase.status='sampling';
    const before=renderer.getStats(),started=performance.now();
    let pendingCamera=null,inflight=null,nextAction=0,lastRaf=started,capturing=true;
    const unsubscribe=renderer.subscribeFrames(info=>{
      const atMs=performance.now()-started;
      if(atMs<0||!capturing)return;
      phase.frames.push({atMs,frameMs:info.frameMs,drawCalls:info.drawCalls,vertices:info.vertices,
        pulseActive:info.renderScheduling?.pulseActive??null,stagingRevision:info.stagingRevision,
        committedRevision:info.committedRevision,spatialPendingPages:info.spatialPendingPages});
      if(pendingCamera) {
        const actual=renderer.getViewState(),mvp=Array.from(renderer.matrix);
        if(mapCameraPoseMatches(pendingCamera.requestedView,actual)&&matrixChanged(pendingCamera.beforeMvp,mvp)) {
          Object.assign(pendingCamera,{status:'observed',observedAtMs:atMs,latencyMs:atMs-pendingCamera.atMs,actualView:copy(actual),mvp});
          pendingCamera=null;
        }
      }
    });
    try {
      while(performance.now()-started<1500) {
        guard();await frame();guard();const now=performance.now(),atMs=now-started;
        phase.rafSamples.push({atMs,intervalMs:now-lastRaf});lastRaf=now;
        if(atMs>=1400||atMs<nextAction)continue;
        if(trial.scenario==='motion') {
          if(pendingCamera)pendingCamera.status='superseded';
          const requestedView=loadingCameraView(view,atMs),beforeMvp=Array.from(renderer.matrix);
          pendingCamera={sequence:phase.cameraCommands.length+1,atMs,requestedView,beforeMvp,status:'pending'};
          phase.cameraCommands.push(pendingCamera);applyView(renderer,requestedView);nextAction=atMs+100;
        }else if(trial.scenario==='updates'&&!inflight) {
          const sequence=phase.updates.length+1;
          const command={sequence,atMs,status:'pending',ids:targets.map(target=>target.id)};phase.updates.push(command);
          const result=renderer.updateFeatureColors(targets.map((target,index)=>({id:target.id,
            color:sequence%2?[70+index*10,160,190,255]:target.color})));
          command.revision=result.revision;
          inflight=timeout(renderer.awaitCommit(result.revision),5000,'颜色上传确认超时').then(()=>{
            command.status='committed';command.committedAtMs=performance.now()-started;
            command.latencyMs=command.committedAtMs-command.atMs;
          }).catch(error=>{command.status='failed';command.error=error.message;}).finally(()=>{inflight=null;});
          nextAction=atMs+100;
        }
      }
      capturing=false;
      const ended=performance.now(),after=renderer.getStats();
      phase.elapsedMs=ended-started;phase.before=copy(before);phase.afterAtBoundary=copy(after);
      phase.measurement=summarizeDemandFrames(phase.frames,phase.elapsedMs);
      phase.measurement.uploadedBytes=after.uploadedBytes-before.uploadedBytes;
      phase.measurement.renderSchedulingBefore=copy(before.renderScheduling);
      phase.measurement.renderSchedulingAfter=copy(after.renderScheduling);
      phase.measurement.renderTotalCpuMs=after.renderScheduling.renderCpuMs-before.renderScheduling.renderCpuMs;
      phase.measurement.maxRafGapMs=Math.max(...phase.rafSamples.map(value=>value.intervalMs),0);
      if(inflight)await inflight; // Post-boundary drain is retained, never added to measured upload bytes/frames.
      const latencies=phase.updates.filter(value=>value.status==='committed'&&value.committedAtMs<=phase.elapsedMs).map(value=>value.latencyMs);
      phase.measurement.updateLatencyP95Ms=percentile(latencies,.95);
      phase.measurement.cameraLatencyP95Ms=percentile(phase.cameraCommands.filter(value=>value.status==='observed').map(value=>value.latencyMs),.95);
      if(after.contextLost||after.lastError)phase.invalidReasons.push('renderer-unhealthy');
      if(trial.policy==='continuous'&&!phase.frames.length)phase.invalidReasons.push('continuous-draw-unobserved');
      if(trial.scenario==='motion'&&!phase.cameraCommands.some(value=>value.status==='observed'))phase.invalidReasons.push('camera-change-unobserved');
      if(trial.scenario==='updates'&&(!phase.updates.length||phase.updates.some(value=>value.status!=='committed'||value.committedAtMs>phase.elapsedMs)))phase.invalidReasons.push('update-not-committed-inside-window');
      phase.status='completed';phase.valid=phase.invalidReasons.length===0;
    }catch(error){phase.status=cancelled?'cancelled':'failed';phase.valid=false;phase.invalidReasons.push(error.message);throw error;}
    finally{capturing=false;unsubscribe();}
    const row=document.createElement('tr');
    const values=[`${sceneLabels[trial.scenario]} / ${labels[trial.policy]} / ${trial.repeat}`,
      phase.measurement.businessFramesPerSecond.toFixed(1),phase.measurement.drawCalls,
      phase.measurement.renderBodyCpuMs.toFixed(2),phase.measurement.updateLatencyP95Ms?.toFixed(1)??'—',phase.valid?'有效':'无效：'+phase.invalidReasons.join('、')];
    for(const value of values){const cell=document.createElement('td');cell.textContent=String(value);row.appendChild(cell);}
    $('demand-results').appendChild(row);
  }
  async function start() {
    if(running||isBusy())return;
    const renderer=getRenderer(),config=getConfig();
    if(!renderer||!config||!renderer.setRenderPolicy){$('demand-progress').textContent='先完成数据加载，再进行对照。';return;}
    const targets=renderer.getColorUpdateTargets(2);
    if(targets.length<2){$('demand-progress').textContent='已加载的数据需要至少两个普通设备点作为更新目标。';return;}
    const original={policy:renderer.renderPolicy,adaptive:renderer.adaptive,view:renderer.getViewState()};
    const plan=demandTrialPlan(Number($('demand-repeats').value));
    running=true;cancelled=false;interruptionReason=null;onActiveChange(true);stopNeural();onShowMap();
    const controls=[...document.querySelectorAll('[data-mode],[data-view],[data-workspace-control]'),...['start-button','map-start-button','benchmark-button','loading-benchmark-button','map-frame-start','lod-benchmark','demand-start','render-policy','count','seed','delay','chunk','poi-load','poi-refresh','layer-points','layer-lines','layer-polygons','zoom-in','zoom-out','rotate-view','reset-view','neural-start','neural-jump','connect-button','settings-button','export-button'].map($)].filter(Boolean);
    const disabled=controls.map(element=>element.disabled);controls.forEach(element=>element.disabled=true);$('demand-stop').disabled=false;
    active={schemaVersion:'1.0',kind:'demand-render-comparison',id:'demand-'+Date.now(),implementationVersion:IMPLEMENTATION_VERSION,
      startedAt:new Date().toISOString(),status:'running',environment:copy(getEnvironment()),config:copy(config),
      mapMode:renderer.mode,plan,rect:rect(),baseView:copy(original.view),layers:copy(renderer.layers),
      graphics:renderer.getGraphicsInfo(),phases:[],scope:'Loaded-data warm comparison, unchanged pulse shader and LOD 1. No data fetching or LocalSearch. SDK business callbacks are fully drawn even in demand mode. Callback cadence/CPU submission do not measure physical presentation or GPU execution.'};
    reports.push(active);renderer.setAdaptive(false);
    try {
      const fresh=await(await fetch('/api/environment',{cache:'no-store'})).json();
      if(fresh.sourceFingerprint!==active.environment?.sourceFingerprint||fresh.implementationVersion!==IMPLEMENTATION_VERSION)throw new Error('页面与服务器源码不一致，请刷新后重测');
      for(const trial of plan) {
        guard();const message=`按需对照 ${trial.ordinal}/${plan.length} · ${sceneLabels[trial.scenario]} · ${labels[trial.policy]}`;
        $('demand-progress').textContent=message;onPhase(message);
        renderer.setRenderPolicy('continuous');
        const restored=renderer.updateFeatureColors(targets.map(target=>({id:target.id,color:target.color})));
        await timeout(renderer.awaitCommit(restored.revision),5000,'恢复颜色确认超时');
        const preparation=await prepare(renderer,original.view);
        await sample(renderer,trial,original.view,targets,preparation);
      }
      active.status='completed';
    }catch(error){active.status=cancelled?'cancelled':'failed';active.error=error.message;}
    finally {
      renderer.setRenderPolicy('continuous');
      try{const restored=renderer.updateFeatureColors(targets.map(target=>({id:target.id,color:target.color})));await timeout(renderer.awaitCommit(restored.revision),5000,'恢复颜色确认超时');applyView(renderer,original.view);}catch(error){active.restorationError=error.message;}
      renderer.setAdaptive(original.adaptive);renderer.setRenderPolicy(original.policy);
      active.endedAt=new Date().toISOString();active.originalValidCount=active.phases.filter(phase=>phase.valid).length;
      active=null;running=false;onActiveChange(false);controls.forEach((element,index)=>element.disabled=disabled[index]);$('demand-stop').disabled=true;
      const report=reports.at(-1);$('demand-progress').textContent=`${report.status==='completed'?'已完成':'已中断'}：${report.phases.length}/${plan.length} 条阶段记录，${report.originalValidCount} 条有效。可导出完整报告。`;
      onShowResults();
    }
  }
  const stop=()=>{if(running)cancelled=true;};
  $('demand-start').addEventListener('click',start);$('demand-stop').addEventListener('click',stop);
  const userEvent=event=>{if(running&&event.isTrusted&&event.target?.id!=='demand-stop')stop();};
  ['pointerdown','wheel','keydown'].forEach(type=>document.addEventListener(type,userEvent,{capture:true,passive:true}));
  // Latch interruption events: rAF can pause while hidden and resume only after
  // visibility/size has returned, so current-state polling alone is insufficient.
  const visibilityChanged=()=>{if(running&&document.visibilityState!=='visible')interruptionReason??='页面曾进入后台，保留无效记录';};
  const resized=()=>{if(running&&active){const next=rect();if(Math.abs(next.width-active.rect.width)>.5||Math.abs(next.height-active.rect.height)>.5||next.dpr!==active.rect.dpr)interruptionReason??='视窗曾改变，保留无效记录';}};
  document.addEventListener('visibilitychange',visibilityChanged);window.addEventListener('resize',resized);
  const resizeObserver=new ResizeObserver(resized);resizeObserver.observe($('map-container'));
  const destroy=()=>{stop();resizeObserver.disconnect();document.removeEventListener('visibilitychange',visibilityChanged);window.removeEventListener('resize',resized);['pointerdown','wheel','keydown'].forEach(type=>document.removeEventListener(type,userEvent,true));};
  return {evidence:()=>reports,start,stop,destroy};
}
