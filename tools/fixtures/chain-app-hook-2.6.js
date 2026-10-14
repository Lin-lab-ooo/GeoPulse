/** Test-only suffix for the unchanged production app. Never shipped as an app module. */
{
  const defaults = {...renderer.optimization};
  const variants = {
    reference: {batch:2048,next:2048,render:'continuous',options:{spatial:false,spatialPicking:false,positionDirtyPolicy:'ranges',liveBounds:false,movedFilter:false}},
    current: {batch:2048,next:2048,render:'demand',options:{}},
    hybrid: {batch:2048,next:8192,render:'demand',options:{}},
    large: {batch:8192,next:8192,render:'demand',options:{}},
    hybridBounds: {batch:2048,next:8192,render:'demand',options:{liveBounds:true,movedFilter:true}},
  };
  let armed = 'current', errors = [], events = [], activeWorkers = 0, peakPending = 0;
  const now = () => performance.now();
  const c = () => run || lastRun;
  const NativeWorker = globalThis.Worker;
  const quality = () => {renderer.setAdaptive(false);renderer.setRiskPreservation(true);};
  globalThis.Worker = class ChainObservedWorker extends NativeWorker {
    constructor(url, options) {
      super(url, options);this.isStream = new URL(url, location.href).pathname.endsWith('/stream-worker.js');
      this.pending = 0;this.closed = false;this.runId = null;this.variant = variants[armed];
      if (!this.isStream) return;
      activeWorkers++;
      this.addEventListener('message', ({data:m}) => {
        if(m.runId !== this.runId) {errors.push('wrong-run-message');return;}
        if(m.type === 'batch') {this.pending++;peakPending=Math.max(peakPending,this.pending);if(this.pending!==1)errors.push('overlap');}
        if(m.type === 'done' && this.pending) errors.push('done-before-ack');
        events.push({at:now(),type:m.type,runId:m.runId,count:m.batch?.featureCount,pending:this.pending});
      });
    }
    postMessage(m, transfer) {
      if(this.isStream && m.type === 'start') {
        this.runId=m.runId;quality();
        m={...m,batchSize:this.variant.batch,mode:this.variant.next!==this.variant.batch?'adaptive':'fixed'};
      }
      if(this.isStream && m.type === 'ack') {
        const s=renderer.getCommitStats();
        if(this.pending!==1 || m.runId!==this.runId || c()?.id!==m.runId || s.committedRevision<s.stagingRevision || s.pendingGeometryPages!==0) errors.push('invalid-ack');
        this.pending--;m={...m,batchSize:this.variant.next};
        events.push({at:now(),type:'ack',runId:m.runId,revision:s.committedRevision,staged:s.stagingRevision,vertices:s.totalVertices,pending:this.pending});
      }
      return transfer===undefined?super.postMessage(m):super.postMessage(m,transfer);
    }
    terminate() {if(this.isStream&&!this.closed){activeWorkers--;this.closed=true;events.push({at:now(),type:'terminate',runId:this.runId,pending:this.pending});}return super.terminate();}
  };
  const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  globalThis.__chain = {
    begin(config, variant='current') {
      if(!variants[variant])throw Error('Unknown variant');
      armed=variant;renderer.setOptimizationOptions({...defaults,...variants[variant].options});renderer.setRenderPolicy(variants[variant].render);
      const p=startRun(config);quality();p.catch(()=>{});return {id:c().id,variant,policy:variants[variant]};
    },
    state() {const r=c();return {id:r?.id,status:r?runOutcome(r,now()).state:null,shown:r?.shown,staged:r?.uploadedVertices,confirmed:r?.confirmedVertices,acknowledged:r?.acknowledgedVertices,
      batches:r?.batches,worker:!!r?.worker,activeWorkers,peakPending,errors:[...errors],...renderer.getCommitStats(),mode:renderer.mode,graphics:renderer.getGraphicsInfo(),stats:renderer.getStats()};},
    stop(){stopRun('Chain quality cancellation');},
    async reset(){stopRun('Chain quality reset');renderer.reset();await renderer.awaitCommit(renderer.getCommitStats().stagingRevision);},
    async change(op, args) {
      if(!['updateFeaturePositions','updateFeatureColors','removeFeatures','restoreFeatures'].includes(op))throw Error('Bad operation');
      const before=now(),receipt=renderer[op](args,{summaryOnly:true}),cpuMs=now()-before;
      await renderer.awaitCommit(receipt.revision);return {receipt,cpuMs,commitWallMs:now()-before};
    },
    track(ids){return renderer.trackFeatures(ids);},
    async digest() {
      const out={};for(const kind of ['points','lines','polygons']){const pages=renderer.pages[kind],n=pages.reduce((s,p)=>s+p.count,0);out[kind]={vertices:n};
        for(const [field,width] of [['positions',8],['colors',4],['ids',4]]){const a=new Uint8Array(n*width);let at=0;for(const p of pages){const b=new Uint8Array(p[field].buffer,p[field].byteOffset,p.count*width);a.set(b,at);at+=b.length;}out[kind][field]=await hash(a);}
      }return out;
    },
    async exact(expected) {
      const checks=[];
      for(const group of expected.groups){const pages=renderer.pages[group.kind];
        for(const [field,width] of [['positions',2],['colors',4],['ids',1]]){let at=0,mismatch=null;for(const p of pages)for(let i=0;i<p.count*width;i++,at++)if(mismatch===null && p[field][i]!==group[field][at])mismatch={at,actual:p[field][i],expected:group[field][at]};
          checks.push({kind:group.kind,field,length:at,expected:group[field].length,mismatch,pass:mismatch===null&&at===group[field].length});}
        checks.push({kind:group.kind,field:'primitive-alignment',pass:pages.every(p=>p.count%({points:1,lines:2,polygons:3}[group.kind])===0)});
      }return checks;
    },
    async pixels(expected, view={}) {
      if(renderer.mode!=='local'&&renderer.mode!=='sandbox')throw Error('Pixel oracle is local-only');
      const host=document.createElement('div');Object.assign(host.style,{position:'fixed',left:'-10000px',top:'0',width:renderer.width+'px',height:renderer.height+'px'});document.body.append(host);
      const oracle=new GeoRenderer(host,{contextVersion:'webgl',onError:e=>errors.push(String(e))});
      try{
        oracle.setAdaptive(false);oracle.setOptimizationOptions({spatial:false,liveBounds:false,movedFilter:false});oracle.setLayers({...renderer.layers});oracle.pointSize=renderer.pointSize;
        for(const g of expected.groups)oracle.append({groups:[{...g,positions:new Float32Array(g.positions),colors:new Uint8Array(g.colors),ids:new Uint32Array(g.ids)}],featureCount:g.featureCount});
        Object.assign(renderer.camera,view);Object.assign(oracle.camera,renderer.camera);
        renderer._requestRender('chain-quality-camera');
        await new Promise(resolve=>setTimeout(resolve,180));
        const capture=r=>{const gl=r._localGL;r._render(gl,r._localMatrix(),{time:2500,unitsPerPixel:1/r.camera.scale,pixelRatio:r.pixelRatio});gl.finish();const out=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,out);if(gl.getError()!==gl.NO_ERROR)throw Error('GL pixel read error');return out;};
        const a=capture(renderer),b=capture(oracle);if(a.length!==b.length)throw Error('Pixel oracle canvas sizes differ');let diff=0,nonzero=0;for(let i=0;i<a.length;i++){if(a[i]!==b[i])diff++;if(a[i])nonzero++;}
        return {bytes:a.length,differingBytes:diff,nonzeroBytes:nonzero,actualSHA:await hash(a),oracleSHA:await hash(b),camera:{...renderer.camera},renderer:renderer.getStats()};
      } finally {oracle.destroy();host.remove();}
    },
    async workload(size=2048) {
      const ids=Array.from({length:size},(_,i)=>i+1);renderer.trackFeatures(ids);
      const receipts=[];for(let frame=0;frame<8;frame++) {
        const n=frame<2?2:size,updates=ids.slice(0,n).map((id,i)=>({id,x:(i%64)*45-1400+frame,y:Math.floor(i/64)*45-700-frame}));
        receipts.push(await this.change('updateFeaturePositions',updates));
      }
      return {receipts,stats:renderer.getStats()};
    },
    records(){return results;},events(){return events;},async export(){await exportReport();return {pending:!!pendingReportExport,saving:!!exportReport.saving,message:$('benchmark-progress').textContent};},
    camera(){return {...renderer.camera};},renderStats(){return renderer.getStats();},
  };
}
