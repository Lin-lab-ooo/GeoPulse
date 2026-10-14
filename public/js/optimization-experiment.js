import {GeoRenderer} from './renderer.js';
import {EXPERIMENT_SEED, SPATIAL_VARIANTS, makeOptimizationData, optimizationCameraTrace} from './optimization-fixtures.js';

const median = values => { const a = values.filter(Number.isFinite).sort((x,y) => x-y); return a.length ? (a[Math.floor((a.length-1)/2)]+a[Math.floor(a.length/2)])/2 : null; };
const $ = id => document.getElementById(id);
let active = null, lastReport = null;
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

function gpuTimer(gl) {
  const v2 = typeof gl.createQuery === 'function';
  const ext = gl.getExtension(v2 ? 'EXT_disjoint_timer_query_webgl2' : 'EXT_disjoint_timer_query');
  if (!ext) return {measure: async fn => {fn(); return {ms:null,reason:'extension unavailable'};}};
  return {measure: async fn => {
    const query = v2 ? gl.createQuery() : ext.createQueryEXT();
    const began = performance.now();
    try {
      if (v2) gl.beginQuery(ext.TIME_ELAPSED_EXT,query); else ext.beginQueryEXT(ext.TIME_ELAPSED_EXT,query);
      try {fn();} finally {if(v2)gl.endQuery(ext.TIME_ELAPSED_EXT);else ext.endQueryEXT(ext.TIME_ELAPSED_EXT);}
      gl.flush();
      while (performance.now()-began<5000) {
        await nextFrame();
        const ready = v2 ? gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE) : ext.getQueryObjectEXT(query,ext.QUERY_RESULT_AVAILABLE_EXT);
        if (gl.getParameter(ext.GPU_DISJOINT_EXT)) return {ms:null,reason:'disjoint'};
        if (ready) return {ms:(v2 ? gl.getQueryParameter(query,gl.QUERY_RESULT) : ext.getQueryObjectEXT(query,ext.QUERY_RESULT_EXT))/1e6,reason:null};
      }
      return {ms:null,reason:'query timeout'};
    } finally {if(v2)gl.deleteQuery(query);else ext.deleteQueryEXT(query);}
  }};
}

function stopAutomaticFrames(renderer) {
  cancelAnimationFrame(renderer._raf);renderer._raf=0;renderer._startTime=0;
}

function summary(report) {
  const groups = new Map();
  for(const run of report.runs) {
    const key=run.distribution+' / '+run.variant;
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(run);
  }
  return [...groups].map(([name,runs])=>({name,
    buildMs:median(runs.map(r=>r.buildMs)),
    changingCpuMs:median(runs.flatMap(r=>r.frames.filter(f=>!f.cached).map(f=>f.cpuMs))),
    cachedCpuMs:median(runs.flatMap(r=>r.frames.filter(f=>f.cached).map(f=>f.cpuMs))),
    gpuMs:median(runs.flatMap(r=>r.frames.map(f=>f.gpuMs))),
    changingGpuMs:median(runs.flatMap(r=>r.frames.filter(f=>!f.cached).map(f=>f.gpuMs))),
    cachedGpuMs:median(runs.flatMap(r=>r.frames.filter(f=>f.cached).map(f=>f.gpuMs))),
    cachedSubmitted:median(runs.flatMap(r=>r.frames.filter(f=>f.cached).map(f=>f.vertices))),
    refinementCpuMs:median(runs.flatMap(r=>r.frames.filter(f=>f.cached).map(f=>f.refinementCpuMs))),
    submitted:median(runs.flatMap(r=>r.frames.map(f=>f.vertices))),
    indexBytes:runs.map(r=>r.frames.reduce((s,f)=>s+f.indexUploadedBytes+(f.refinementIndexUploadedBytes||0),0)),
    pixelChecks:runs.flatMap(r=>r.pixelChecks)
  }));
}

function renderTable(report) {
  $('results').replaceChildren();
  for(const s of summary(report)) {
    const row=document.createElement('tr');
    for(const value of [s.name,s.buildMs,s.changingCpuMs,s.cachedCpuMs,s.cachedGpuMs,s.cachedSubmitted]) {
      const cell=document.createElement('td');cell.textContent=typeof value==='number'?value.toLocaleString('zh-CN',{maximumFractionDigits:3}):value??'未测';row.append(cell);
    }$('results').append(row);
  }
}

async function sparseExperiment(contextVersion) {
  const renderer=new GeoRenderer($('lab-canvas'),{contextVersion});stopAutomaticFrames(renderer);
  renderer.setOptimizationOptions({spatial:false});renderer.setAdaptive(false);
  renderer.append(makeOptimizationData(100000,'uniform'));
  const gl=renderer._localGL,timer=gpuTimer(gl);
  renderer.camera={x:0,y:0,scale:.045,heading:0};
  const render=()=>renderer._render(gl,renderer._localMatrix(),{time:1000,unitsPerPixel:1/renderer.camera.scale,pixelRatio:1});
  render();const measurements=[];
  const cases=[['two-adjacent',[101,102]],['two-far',[101,50001]],['two-pages',[101,70001]],['unchanged',[101,50001]],
    ['scattered-410',Array.from({length:410},(_,i)=>1+Math.floor(i*99999/410))]];
  for(let repeat=0;repeat<5;repeat++)for(const config of [{dirtyMode:'envelope',mergeGapBytes:0},
    ...[0,64,256].map(mergeGapBytes=>({dirtyMode:'ranges',mergeGapBytes}))]) {
    renderer.setOptimizationOptions(config);
    for(const [name,ids] of cases) {
      renderer.trackFeatures(ids);
      const color=repeat%2?[70,196,218,255]:[82,212,200,255];
      renderer.updateFeatureColors(ids.map(id=>({id,color})));render();
      const began=performance.now();
      const updated=renderer.updateFeatureColors(ids.map(id=>({id,color:name==='unchanged'?color:[75,190,205,255]})));
      const stagingMs=performance.now()-began;
      const before=renderer.getStats().uploadedBytes;
      const gpu=await timer.measure(render),stats=renderer.getStats();
      measurements.push({name,repeat,config,stagingMs,renderCpuMs:stats.frameMs,gpuMs:gpu.ms,
        uploadedBytes:stats.uploadedBytes-before,updatedVertices:updated.updatedVertices});
    }
  }
  renderer.destroy();gl.getExtension('WEBGL_lose_context')?.loseContext();return measurements;
}

async function verifyCompleteGeometry(contextVersion) {
  const colors=count=>{const bytes=new Uint8Array(count*4);for(let i=0;i<count;i++)bytes.set([82,212,200,210],i*4);return bytes;};
  const positions=new Float32Array(65536*2);positions.fill(10000);positions.set([0,0],65534*2);positions.set([20,20],65535*2);
  const ids=Uint32Array.from({length:65536},(_,i)=>i+1);
  const pointColors=colors(65536);pointColors.set([255,70,90,245],65534*4);
  const lines=new Float32Array([-1000,0,1000,0, -1000,-1000,-900,-900, 0,-1000,0,1000]);
  const polygons=new Float32Array([-500,-100,500,-100,0,300, 900,900,1100,900,1000,1100]);
  const batch={groups:[{kind:'points',positions,colors:pointColors,ids,featureCount:65536},
    {kind:'lines',positions:lines,colors:colors(6),ids:new Uint32Array(6),featureCount:3},
    {kind:'polygons',positions:polygons,colors:colors(6),ids:new Uint32Array(6),featureCount:2}],featureCount:65541};
  const matrices=[];
  for(const heading of [0,.43]) {
    const m=new Float32Array(16),c=Math.cos(heading),s=Math.sin(heading);
    m[0]=c/400;m[4]=-s/400;m[1]=s/300;m[5]=c/300;m[10]=m[15]=1;matrices.push({name:'rotation-'+heading,matrix:m});
  }
  const perspective=new Float32Array(matrices[0].matrix);perspective[3]=.001;perspective[7]=.0002;
  matrices.push({name:'perspective-eye-plane',matrix:perspective});
  const references=new Map(),results=[];
  for(const spatial of [false,true]) {
    const renderer=new GeoRenderer($('lab-canvas'),{contextVersion});stopAutomaticFrames(renderer);
    renderer.setOptimizationOptions({spatial,spatialPolicy:'always',leafSize:8,maxCandidateRatio:1});renderer.setAdaptive(false);renderer.append(batch);
    const gl=renderer._localGL;
    for(const {name,matrix} of matrices) {
      renderer._render(gl,matrix,{time:1000,unitsPerPixel:1,pixelRatio:1});
      if(gl.getError()!==gl.NO_ERROR)throw new Error('完整图元 WebGL 错误');
      const pixels=new Uint8Array(800*600*4);gl.readPixels(0,0,800,600,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      const sha256=await digest(pixels);
      if(!spatial)references.set(name,sha256);
      const equal=references.get(name)===sha256;results.push({contextVersion,name,spatial,equal,sha256});
      if(!equal)throw new Error('线面或页尾像素不一致：'+name);
    }
    renderer.destroy();gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  return results;
}

export async function runOptimizationExperiment({count=100000,repeats=3,contextVersion='webgl2'}={}) {
  if(active)throw new Error('实验已在运行');
  active=true;$('start').disabled=true;$('download').disabled=true;
  const report={project:'GeoPulse',experiment:'spatial-update-real-webgl',schemaVersion:'1.0',seed:EXPERIMENT_SEED,
    startedAt:new Date().toISOString(),count,repeats,contextVersion,viewport:{width:800,height:600,dpr:1},
    measurement:{cpu:'actual GeoRenderer._render CPU call duration',gpu:'asynchronous disjoint timer query, excluding CPU tree build and pixel readback',
      frameRate:null,scope:'isolated WebGL canvas, no Baidu SDK',pixelChecks:'SHA-256 of immediate RGBA readPixels, same shader time and original transparency order',
      memory:'renderer ArrayBuffer ownership; JS tree estimate separate; browser total heap not attributed'},runs:[],datasets:[]};
  const hashes=new Map();
  try {
    for(const distribution of ['uniform','alternating-ab','corridor','dense-outliers']) {
      const batch=makeOptimizationData(count,distribution),group=batch.groups[0];
      report.datasets.push({distribution,positionsSha256:await digest(group.positions),colorsSha256:await digest(group.colors),idsSha256:await digest(group.ids)});
      const cameras=optimizationCameraTrace(distribution);
      for(let repeat=0;repeat<repeats;repeat++) {
        const order=repeat===0?SPATIAL_VARIANTS:[...SPATIAL_VARIANTS.slice(repeat%SPATIAL_VARIANTS.length),...SPATIAL_VARIANTS.slice(0,repeat%SPATIAL_VARIANTS.length)];
        for(const variant of order) {
          $('status').textContent=`${count.toLocaleString()} 点 · ${distribution} · ${variant.name} · 第 ${repeat+1}/${repeats} 轮`;
          const renderer=new GeoRenderer($('lab-canvas'),{contextVersion});stopAutomaticFrames(renderer);
          renderer.pixelRatio=1;renderer.canvas.width=800;renderer.canvas.height=600;
          renderer.setOptimizationOptions({spatial:variant.spatial,spatialPolicy:variant.spatialPolicy,leafSize:variant.leafSize,maxCandidateRatio:variant.maxCandidateRatio});renderer.setAdaptive(false);
          const buildBegan=performance.now();
          // Small appends mirror the streaming path and bound temporary staging.
          for(let offset=0;offset<count;offset+=2048) {
            const end=Math.min(count,offset+2048);
            renderer.append({groups:[{kind:'points',positions:group.positions.subarray(offset*2,end*2),colors:group.colors.subarray(offset*4,end*4),ids:group.ids.subarray(offset,end),featureCount:end-offset}],featureCount:end-offset});
          }
          const buildMs=performance.now()-buildBegan;
          const gl=renderer._localGL,timer=gpuTimer(gl),frames=[],pixelChecks=[];
          const render=()=>renderer._render(gl,renderer._localMatrix(),{time:1000,unitsPerPixel:1/renderer.camera.scale,pixelRatio:1});
          renderer.camera={...cameras[0]};render();await nextFrame();render();
          report.graphics ||= renderer.getGraphicsInfo();
          for(const camera of cameras) {
            renderer.camera={...camera};
            for(const cached of [false,true]) {
              let refinementCpuMs=0,refinementIndexUploadedBytes=0,refinementPeakCpuMs=0;
              if(cached) for(let warm=0;warm<4;warm++) {render();const s=renderer.getStats();refinementCpuMs+=s.frameMs;refinementPeakCpuMs=Math.max(refinementPeakCpuMs,s.frameMs);refinementIndexUploadedBytes+=s.indexUploadedBytes;}
              const gpu=await timer.measure(render),stats=renderer.getStats();
              if(gl.getError()!==gl.NO_ERROR)throw new Error('WebGL draw error');
              frames.push({camera:camera.name,cached,cpuMs:stats.frameMs,gpuMs:gpu.ms,gpuUnavailable:gpu.reason,
                vertices:stats.vertices,drawCalls:stats.drawCalls,queryMs:stats.queryMs,indexMs:stats.indexMs,
                indexUploadedBytes:stats.indexUploadedBytes,cacheHits:stats.cacheHits,refinementCpuMs,refinementPeakCpuMs,refinementIndexUploadedBytes,spatialDenseFallbackPages:stats.spatialDenseFallbackPages});
            }
            if(repeat===0) {
              render();const pixels=new Uint8Array(800*600*4);gl.readPixels(0,0,800,600,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
              const sha256=await digest(pixels),key=distribution+'/'+camera.name;
              if(variant.name==='input-pages')hashes.set(key,sha256);
              const equal=sha256===hashes.get(key);pixelChecks.push({camera:camera.name,sha256,equal});
              if(!equal)throw new Error('像素结果与基线不一致：'+key+'/'+variant.name);
            }
          }
          const tree=renderer.pages.points.map(page=>page.spatial?.getStats()).filter(Boolean);
          report.runs.push({distribution,variant:variant.name,repeat,buildMs,spatialBuildMs:renderer.getStats().spatialBuildMs,
            cpuGeometryBytes:renderer.getStats().cpuBytes,gpuBufferBytes:renderer.getStats().gpuBytes,
            spatialTypedArrayBytes:tree.reduce((s,t)=>s+t.typedArrayBytes,0),spatialEstimatedBytes:tree.reduce((s,t)=>s+t.estimatedBytes,0),frames,pixelChecks});
          renderer.destroy();gl.getExtension('WEBGL_lose_context')?.loseContext();renderTable(report);await nextFrame();
        }
      }
    }
    report.sparseUpdates=await sparseExperiment(contextVersion);
    report.geometryChecks=await verifyCompleteGeometry(contextVersion);
    report.summary=summary(report);report.endedAt=new Date().toISOString();lastReport=report;
    $('summary').textContent='完成：所有空间方案像素与基线一致。比较结果应同时看建树、移动 CPU 与 GPU 时间；静止复用单独报告。';
    $('status').textContent='实验完成，原始结果可以下载。';$('download').disabled=false;
    return report;
  } finally {active=false;$('start').disabled=false;}
}

$('start').addEventListener('click',()=>runOptimizationExperiment({count:Number($('scale').value)}).catch(error=>{$('status').textContent='实验失败：'+error.message;}));
$('download').addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(lastReport,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='geopulse-spatial-update-webgl.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
window.optimizationExperiment={run:runOptimizationExperiment,getReport:()=>lastReport};
