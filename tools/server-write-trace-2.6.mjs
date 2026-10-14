// Test-only response.write timestamps. No payload logging or production source changes.
import {performance} from 'node:perf_hooks';
const epoch=()=>performance.timeOrigin+performance.now();
const describe=chunk=>typeof chunk==='string'?{length:chunk.length,unit:'UTF-16 code units'}:
 ArrayBuffer.isView(chunk)?{length:chunk.byteLength,unit:'bytes'}:{length:0,unit:'unknown/empty'};

export function identityWriteBudget({sizes,expectedRuns,chunk,compression,maximumWrites=50000}){
 if(compression!=='identity')throw new Error('Source-write proof requires identity: a gzip tail is not evidence of later business records');
 if(!Array.isArray(sizes)||!sizes.length||!sizes.every(n=>Number.isSafeInteger(n)&&n>0)||!Number.isSafeInteger(expectedRuns)||expectedRuns<1||expectedRuns%sizes.length||!Number.isSafeInteger(chunk)||chunk<1||!Number.isSafeInteger(maximumWrites)||maximumWrites<1)throw new Error('Invalid source-write capacity protocol');
 const expectedWrites=sizes.reduce((sum,n)=>sum+Math.ceil(n/chunk),0)*(expectedRuns/sizes.length);
 if(!Number.isSafeInteger(expectedWrites)||expectedWrites>maximumWrites)throw new Error(`Source-write trace capacity insufficient before startup: expected ${expectedWrites}, maximum ${maximumWrites}`);
 return {compression,expectedWrites,maximumWrites,scope:'Exact planned identity service chunks; each nonempty write contains generated NDJSON business records.'};
}

export function attachStreamWriteTrace(server,{maximumWrites=50000}={}) {
 if(!Number.isSafeInteger(maximumWrites)||maximumWrites<1)throw new Error('maximumWrites must be a positive safe integer');
 const streams=[];let observedWrites=0,droppedWrites=0,disposed=false;
 const listener=(request,response)=>{
  if(disposed)return;
  const url=new URL(request.url,'http://127.0.0.1');
  if(url.pathname==='/api/health'&&request.headers['x-geopulse-clock-probe']==='1'){
   response.setHeader('X-GeoPulse-Server-Epoch-Ms',String(epoch()));
  }
  if(url.pathname!=='/api/stream'||request.method!=='GET')return;
  const item={ordinal:streams.length,requestEpochMs:epoch(),parameters:Object.fromEntries(['count','seed','chunk','delay','compression'].map(key=>[key,url.searchParams.get(key)])),writes:[],finishEpochMs:null,closeEpochMs:null,endCallEpochMs:null};
  streams.push(item);
  const originalWrite=response.write,originalEnd=response.end;
  const record=(chunk,kind,invoke)=>{
   const description=describe(chunk),at=epoch();
   const returned=invoke();
   if(description.length){
    observedWrites++;
    if(observedWrites<=maximumWrites)item.writes.push({sequence:observedWrites,kind,serverEpochMs:at,returnEpochMs:epoch(),...description,accepted:typeof returned==='boolean'?returned:null});
    else droppedWrites++;
   }
   return returned;
  };
  response.write=function(chunk,...rest){return record(chunk,'write',()=>originalWrite.call(this,chunk,...rest));};
  response.end=function(chunk,...rest){item.endCallEpochMs=epoch();return record(chunk,'end',()=>originalEnd.call(this,chunk,...rest));};
  response.once('finish',()=>{item.finishEpochMs=epoch();});
  response.once('close',()=>{item.closeEpochMs=epoch();});
 };
 server.prependListener('request',listener);
 return {
  snapshot(){return {schema:'geopulse/server-write-trace-2.6',scope:'Timestamp before Node response.write/end for nonempty application entity data, not socket delivery or browser reception. No content recorded. Each wrapper adds timestamp/allocation overhead.',clock:'Node performance.timeOrigin + performance.now',maximumWrites,observedWrites,droppedWrites,streams:streams.map(s=>({...s,writes:s.writes.map(w=>({...w}))}))};},
  dispose(){disposed=true;server.off('request',listener);}
 };
}

export async function probeBrowserServerClocks(page,{samples=7}={}) {
 return page.evaluate(async samples=>{
  const rows=[];
  for(let i=0;i<samples;i++){
   const browserBeforeEpochMs=performance.timeOrigin+performance.now();
   const response=await fetch('/api/health',{cache:'no-store',headers:{'X-GeoPulse-Clock-Probe':'1'}});
   const raw=response.headers.get('X-GeoPulse-Server-Epoch-Ms');
   await response.arrayBuffer();
   const browserAfterEpochMs=performance.timeOrigin+performance.now();
   const serverEpochMs=raw===null?NaN:Number(raw);
   if(!response.ok||!Number.isFinite(serverEpochMs))throw new Error('Server/browser clock probe unavailable');
   rows.push({browserBeforeEpochMs,browserAfterEpochMs,serverEpochMs,offsetLowerMs:serverEpochMs-browserAfterEpochMs,offsetUpperMs:serverEpochMs-browserBeforeEpochMs});
  }
  return {scope:'Server-minus-browser monotonic epoch offset is bounded by each local request/response. Both clocks assumed stable during the run; before/after probes are checked together.',samples:rows};
 },samples);
}

export function auditFirstDrawBeforeLaterWrite({trace,clockBefore,clockAfter,runs,browserTimeOrigin}){
 if(trace.droppedWrites)throw new Error('Stream write trace truncated');
 if(trace.streams.length!==runs.length)throw new Error('Request-to-run count mismatch');
 if(!Number.isFinite(browserTimeOrigin))throw new Error('Missing browser time origin');
 const probes=[...clockBefore.samples,...clockAfter.samples];
 const lower=Math.max(...probes.map(p=>p.offsetLowerMs)),upper=Math.min(...probes.map(p=>p.offsetUpperMs));
 // 1ms padding accounts for timestamp representation/resolution, not arbitrary clock drift.
 const padding=1;
 if(!Number.isFinite(lower)||!Number.isFinite(upper)||lower>upper+padding)throw new Error('Before/after monotonic clock offset bounds conflict');
 const safeLower=lower-padding,safeUpper=upper+padding;
 const rows=runs.map((run,index)=>{
  const stream=trace.streams[index],l=run.loadingExperiment;
  if(stream.parameters.compression!=='identity'||run.config.compression!=='identity')throw new Error('Source-write proof requires identity business data at '+index);
  if(['count','seed','chunk','delay'].some(key=>stream.parameters[key]===null||Number(stream.parameters[key])!==run.config[key]))throw new Error('Ordered stream material/transport mismatch at '+index);
  if(!l||!Number.isFinite(l.firstBusinessDrawMs)||!Number.isFinite(l.startedMonotonicMs)||stream.finishEpochMs===null)throw new Error('Missing draw/stream completion evidence');
  if(stream.writes.length!==Math.ceil(run.config.count/run.config.chunk))throw new Error('Identity nonempty write count mismatch at '+index);
  const firstDrawEpochMs=browserTimeOrigin+l.startedMonotonicMs+l.firstBusinessDrawMs;
  const later=stream.writes.filter(w=>w.serverEpochMs-safeUpper>firstDrawEpochMs);
  const last=stream.writes.at(-1);
  return {ordinal:index,trialId:l.trial.trialId,mode:run.config.mode,count:run.config.count,firstDrawEpochMs,
   nonemptyWrites:stream.writes.length,provenLaterWrites:later.length,firstProvenLaterWriteBrowserLowerEpochMs:later.length?later[0].serverEpochMs-safeUpper:null,
   lastWriteAfterDrawLowerMs:last?last.serverEpochMs-safeUpper-firstDrawEpochMs:null,
   lastWriteAfterDrawUpperMs:last?last.serverEpochMs-safeLower-firstDrawEpochMs:null,
   progressiveSourceProven:later.length>0};
 });
 return {schema:'geopulse/progressive-source-proof-2.6',scope:'For identity NDJSON only, a later nonempty server write proves some business entity data had not been handed to HTTP when first business Draw was submitted, under the measured stable-clock bounds. Gzip tails cannot substitute. It does not measure wire throughput, arrival time, GPU completion, or visible presentation.',
  clockOffset:{lowerMs:safeLower,upperMs:safeUpper,paddingMs:padding,samples:probes.length},
  streamingTrials:rows.filter(r=>r.mode!=='baseline').length,streamingProven:rows.filter(r=>r.mode!=='baseline'&&r.progressiveSourceProven).length,
  baselineProgressive:rows.filter(r=>r.mode==='baseline'&&r.progressiveSourceProven).length,rows};
}
