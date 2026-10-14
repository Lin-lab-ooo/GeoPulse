import {IMPLEMENTATION_VERSION} from './version.js';
import {percentile} from './scheduler.js';

const MODES={full:'完整点绘制',uniform:'均匀抽样 LOD',risk:'告警保留 LOD'};
const frameSummary=frames=>({samples:frames.length,fps:frames.length?1000/(frames.reduce((n,v)=>n+v,0)/frames.length):null,p95:percentile(frames,.95),p99:percentile(frames,.99),max:frames.length?Math.max(...frames):null});

/** A paired ablation changes only point selection, with the loaded data and camera fixed. */
export function initLodExperiment({getRenderer,getConfig,isBusy,onActiveChange,onPhase,onShowMap,onShowResults,stopNeural,getEnvironment}) {
  const $=id=>document.getElementById(id),records=[];
  const section=document.createElement('section');section.className='lod-experiment';
  section.innerHTML='<h3>重要告警是否在提速时丢失？</h3><p class="helper-text">同一份已加载数据、同一视角，比较完整绘制、均匀抽样和告警保留。三轮轮换顺序，每组预热 1 秒、采样 4 秒。计数表示提交给 GL 的点，不保证被遮挡的像素可见。</p><button id="lod-benchmark" class="secondary-button" type="button">开始告警保留消融（3 轮）</button><p id="lod-progress" class="benchmark-progress" role="status">先完成空间数据加载。</p><div class="table-scroll"><table class="results-table"><thead><tr><th>方法 / 次数</th><th>提交点数</th><th>保留告警 / 全部告警</th><th>rAF FPS</th><th>P95 ms</th></tr></thead><tbody id="lod-results"></tbody></table></div>';
  $('bench-view').append(section);
  let running=false,phase=null;
  function collect(ms,capture=false) {
    return new Promise(resolve=>{
      const start=performance.now(),frames=[];let previous=null;
      const step=at=>{
        if(capture&&previous!==null)frames.push(at-previous);previous=at;
        if(at-start>=ms)resolve(frames);else requestAnimationFrame(step);
      };requestAnimationFrame(step);
    });
  }
  function renderTable() {
    const fragment=document.createDocumentFragment();
    for(const record of records) {
      const row=document.createElement('tr');
      const values=[MODES[record.mode]+' / '+record.repeat,record.pointsSubmitted.toLocaleString('zh-CN'),record.pointAlertsDrawn.toLocaleString('zh-CN')+' / '+record.pointAlertsTotal.toLocaleString('zh-CN'),record.frame.fps?.toFixed(1)||'—',record.frame.p95?.toFixed(1)||'—'];
      values.forEach(value=>{const cell=document.createElement('td');cell.textContent=value;row.append(cell);});fragment.append(row);
    }$('lod-results').replaceChildren(fragment);
  }
  async function start() {
    const renderer=getRenderer(),config=getConfig();
    if(running||isBusy()||!config||!renderer?.getStats().features){$('lod-progress').textContent='请先完成一次空间数据加载。';return;}
    if(renderer.getStats().pointVertices<50000){$('lod-progress').textContent='当前点数未达到 LOD 启用规模，请选择至少 100,000 要素加载。';return;}
    running=true;onActiveChange(true);stopNeural();onShowMap();
    const controls=[...document.querySelectorAll('[data-mode],[data-view],[data-workspace-control]'),...['start-button','map-start-button','benchmark-button','count','seed','delay','chunk','layer-points','layer-lines','layer-polygons','zoom-in','zoom-out','rotate-view','reset-view','neural-start','neural-jump','lod-benchmark','render-policy','demand-start','loading-benchmark-button','loading-benchmark-sizes','map-frame-start'].map($)].filter(Boolean);
    const disabled=controls.map(element=>element.disabled);controls.forEach(element=>element.disabled=true);
    const original={adaptive:renderer.adaptive,risk:renderer.getStats().riskPreservation,layers:{...renderer.layers},renderPolicy:renderer.renderPolicy||'continuous'};
    const orders=[['full','uniform','risk'],['risk','full','uniform'],['uniform','risk','full']];
    try {
      renderer.setRenderPolicy?.('continuous');
      ['points','lines','polygons'].forEach(kind=>$('layer-'+kind).checked=true);
      renderer.setLayers({points:true,lines:true,polygons:true});renderer.resetView();
      for(let repeat=0;repeat<orders.length;repeat++)for(const mode of orders[repeat]) {
        const message=`告警保留消融 ${repeat+1}/3 · ${MODES[mode]} · 同一 ${config.count.toLocaleString('zh-CN')} 要素`;
        $('lod-progress').textContent=message;
        onPhase(message);
        renderer.setAdaptive(mode!=='full');renderer.setRiskPreservation(mode==='risk');
        await collect(1000);
        phase={mode,repeat:repeat+1,startedAt:new Date().toISOString(),interactions:[],visibilityChanges:[]};
        const frames=await collect(4000,true),stats=renderer.getStats();
        records.push({...phase,endedAt:new Date().toISOString(),config:{...config},mapMode:stats.mode,implementationVersion:IMPLEMENTATION_VERSION,renderPolicy:'continuous',environment:getEnvironment(),pointLodStride:stats.pointLodStride,pointsSubmitted:stats.pointsSubmitted,pointAlertsTotal:stats.pointAlertsTotal,pointAlertsDrawn:stats.pointAlertsDrawn,verticesSubmitted:stats.vertices,totalVertices:stats.totalVertices,features:stats.features,drawCalls:stats.drawCalls,gpuBytes:stats.gpuBytes,frame:frameSummary(frames),frameIntervalsMs:frames,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},measurement:'Temporary continuous rendering throughout preparation and comparison; original policy restored afterward. GL point submission counts and rAF cadence, not pixel visibility or GPU execution time'});
        phase=null;renderTable();
      }
      $('lod-progress').textContent='三轮告警保留消融完成。查看告警保留数量、提交量与帧间隔；通过“导出实验报告”保留原始样本。';
    } catch(error){$('lod-progress').textContent='消融中断：'+error.message;}
    finally {
      phase=null;
      try {
        renderer.setAdaptive(original.adaptive);renderer.setRiskPreservation(original.risk);
        renderer.setLayers(original.layers);Object.entries(original.layers).forEach(([kind,value])=>$('layer-'+kind).checked=value);
      } finally {
        try { renderer.setRenderPolicy?.(original.renderPolicy); }
        finally { controls.forEach((element,index)=>element.disabled=disabled[index]);running=false;onActiveChange(false);onShowResults(); }
      }
    }
  }
  $('lod-benchmark').addEventListener('click',start);
  document.addEventListener('visibilitychange',()=>{if(phase)phase.visibilityChanges.push({at:new Date().toISOString(),state:document.visibilityState});});
  return {evidence:()=>records,interaction:info=>{if(phase)phase.interactions.push({at:new Date().toISOString(),type:info.type});}};
}
