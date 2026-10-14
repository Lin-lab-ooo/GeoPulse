/** Offline release adapters. No file paths from reports are opened and no browser is started.
 * Caller supplies parsed, independently SHA-bound companions as the third argument.
 * Historical recovery can never satisfy a current complete end-to-end release gate.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {auditFirstDrawBeforeLaterWrite} from './server-write-trace-2.6.mjs';
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const digest = (v, name='SHA256') => assert.match(v, /^[a-f0-9]{64}$/, name);
const finite = (v, name) => assert.ok(Number.isFinite(v), `${name}: finite number required`);
const nonnegative = (v, name) => { finite(v,name); assert.ok(v >= 0, `${name}: negative`); };
const integer = (v, name) => { nonnegative(v,name); assert.ok(Number.isSafeInteger(v), `${name}: integer required`); };
const close = (a,b,name) => { finite(a,name); finite(b,name); assert.ok(Math.abs(a-b) <= 1e-6*Math.max(1,Math.abs(b)), `${name}: ${a} != ${b}`); };
const unique = (a,name) => assert.equal(new Set(a).size,a.length,`${name}: duplicate`);
const required = (o,key) => { assert.ok(o?.[key] != null, `Missing companion ${key}`); return o[key]; };
const pick = (o,keys) => Object.fromEntries(keys.map(key => [key,o[key]]));
const quantile = (v,q) => v.length ? [...v].sort((a,b)=>a-b)[Math.max(0,Math.ceil(v.length*q)-1)] : null;
const mean = v => v.length ? v.reduce((a,b)=>a+b,0)/v.length : null;
const equalNumber = (a,b,name) => b===null ? assert.equal(a,null,name) : close(a,b,name);
function identity(r,e,{ui=false,historical=false}={}) {
  digest(r.sourceBefore); assert.equal(r.sourceAfter,r.sourceBefore,'legacy source changed');
  if(e.source) assert.equal(r.sourceBefore,e.source,'unexpected legacy source');
  const before=ui?r.runtimeSourceBefore:r.runtimeBefore,after=ui?r.runtimeSourceAfter:r.runtimeAfter;
  if(before != null || !historical || e.runtime) { digest(before,'runtime v2 required'); assert.equal(after,before,'runtime changed'); }
  if(e.runtime)assert.equal(before,e.runtime,'unexpected runtime');
  return before ?? null;
}
function checks(r,names,{historical=false}={}) {
  assert.ok(Array.isArray(r.checks)&&r.checks.length,'checks missing');
  for(const name of names) assert.ok(r.checks.some(c=>c.name===name&&c.pass===true),`Missing passing check: ${name}`);
  if(!historical) for(const c of r.checks) assert.equal(c.pass,true,`failed check ${c.name}`);
}
function savedReports(e,c) {
  const values=e.savedReportKeys ? e.savedReportKeys.map(key=>required(c,key)) : required(c,'savedReports');
  assert.ok(Array.isArray(values)&&values.length,'savedReports must contain parsed report objects'); return values;
}
function receipt(receipt,part) {
  assert.equal(receipt.ok,true,'save receipt failed'); integer(receipt.bytes,'save bytes');
  assert.equal(receipt.bytes,bytes(part),'saved byte count');
  if(receipt.verifiedBytes !== undefined)assert.equal(receipt.verifiedBytes,receipt.bytes);
  if(receipt.sha256 !== undefined)assert.equal(receipt.sha256,sha(part),'saved SHA');
}
function bundle(part,{index,total,totalRuns,ordinals,exportId}) {
  const b=part.exportBundle; assert.ok(b,'exportBundle missing');
  assert.equal(b.schemaVersion,'1.0'); assert.equal(b.partIndex,index); assert.equal(b.partCount,total);
  assert.equal(b.totalRuns,totalRuns); assert.equal(b.exportId,exportId); assert.equal(b.commonEvidenceId,`${exportId}/common`);
  assert.equal(b.totalMapGroups,0); assert.deepEqual(part.mapFrameAblation,[]); assert.deepEqual(b.mapRecordOrdinals,[]);
  assert.equal(b.mapGroupIndex,null); assert.equal(b.anchorOnly,false); assert.deepEqual(b.repeatedRunOrdinals,[]);
  assert.deepEqual(b.runOrdinals,ordinals); assert.equal(part.runs.length,ordinals.length);
  assert.equal(b.commonEvidenceRepeated,index>1); assert.ok(part.runs.length<=100); assert.ok(bytes(part)<=160*1024*1024);
}
function samePose(a,b) {
  return a?.mode==='baidu' && b?.mode==='baidu' && a.center && b.center &&
    Math.abs(a.center.lng-b.center.lng)<=1e-6 && Math.abs(a.center.lat-b.center.lat)<=1e-6 &&
    Math.abs(a.zoom-b.zoom)<=1e-3 && Math.abs(((a.heading-b.heading+540)%360)-180)<=.1 && Math.abs(a.tilt-b.tilt)<=.1;
}
function matrix(m) { assert.equal(m?.length,16,'MVP length'); m.forEach(v=>finite(v,'MVP')); }
const sameMatrix=(a,b)=>a.length===16&&b.length===16&&a.every((v,i)=>Math.abs(v-b[i])<=1e-6*Math.max(1,Math.abs(v),Math.abs(b[i])));
function cadence(summary,samples,reference,name) {
  const v=samples.map(s=>s.intervalMs).filter(v=>v>0),average=mean(v),threshold=reference>0?reference*1.5:null;
  assert.equal(summary.samples,v.length,`${name} samples`);
  for(const [field,value] of Object.entries({meanMs:average,fpsMean:average>0?1000/average:null,p95Ms:quantile(v,.95),p99Ms:quantile(v,.99),maxMs:v.length?Math.max(...v):null,slowThresholdMs:threshold}))equalNumber(summary[field],value,`${name} ${field}`);
  assert.equal(summary.slowFrames,threshold===null?null:v.filter(t=>t>threshold).length,`${name} slowFrames`);
}
function samples(values,l,{business=false}={}) {
  assert.ok(Array.isArray(values)&&values.length,'raw callback samples missing');
  let previous=0;
  for(let i=0;i<values.length;i++) {
    const s=values[i]; nonnegative(s.atMs,'sample time'); nonnegative(s.intervalMs,'sample interval');
    assert.ok(s.atMs>=previous && s.atMs<=l.loadingEndMs,'sample outside loading window');
    close(s.intervalMs,s.atMs-previous,'callback interval'); assert.equal(s.intervalStartsAtRunStart,i===0);
    const count=business?s.features:s.shown; integer(count,'sample features'); assert.ok(count<=l.expectedFeatures);
    close(s.progress,count/l.expectedFeatures,'progress'); assert.equal(s.stage,s.progress<.1?'0-10':s.progress<.5?'10-50':'50-100');
    if(business) { for(const k of ['totalVertices','vertices','drawCalls','stagingRevision','committedRevision'])integer(s[k],k); nonnegative(s.frameCpuMs,'frame CPU'); assert.ok(s.committedRevision<=s.stagingRevision); }
    previous=s.atMs;
  }
}
const planFields=['trialId','count','mode','repeat','position','seed','delay','chunk','ordinal','total','repeats','protocolVersion','methodOrder'];
function expectedPlan(config) {
  const orders=[['baseline','fixed','adaptive'],['fixed','adaptive','baseline'],['adaptive','baseline','fixed'],['baseline','adaptive','fixed'],['fixed','baseline','adaptive']];
  const plan=[];
  for(let repeat=1;repeat<=5;repeat++)for(const count of repeat%2?config.sizes:[...config.sizes].reverse())for(const [position,mode] of orders[repeat-1].entries())
    plan.push({trialId:`loading-${count}-${mode}-r${repeat}`,count,mode,repeat,position:position+1,seed:config.seed,delay:config.delay,chunk:config.chunk,ordinal:plan.length+1,total:30,repeats:5,protocolVersion:'2.6',methodOrder:orders[repeat-1]});
  return plan;
}
function auditRun(run,planned,protocol,r) {
  assert.deepEqual(pick(run.loadingExperiment.trial,planFields),planned,'run trial differs from plan');
  const l=run.loadingExperiment,m=run.metrics,n=planned.count;
  assert.equal(l.trial.protocolId,protocol.id); assert.equal(l.trial.index,planned.ordinal);
  assert.equal(run.status,'completed'); assert.equal(run.mapMode,'baidu'); assert.equal(run.failureReason,null);
  assert.deepEqual(pick(run.config,['count','mode','seed','delay','chunk']),pick(planned,['count','mode','seed','delay','chunk']));
  assert.equal(run.config.compression,r.configuration.compression); assert.equal(run.config.dataSource,'synthetic');
  assert.equal(run.environment.sourceFingerprint,r.sourceBefore); assert.equal(run.environment.runtimeFingerprint,r.runtimeBefore);
  assert.deepEqual(run.layers,{points:true,lines:true,polygons:true}); assert.equal(m.lodStride,1); assert.equal(run.renderPolicy,'continuous');
  assert.deepEqual(run.optimization,protocol.renderQuality.optimization);
  assert.deepEqual(pick(run.viewport,['width','height']),r.configuration.viewport); assert.equal(run.graphics.available,true); assert.equal(run.graphics.unmaskedRenderer,r.graphics.unmaskedRenderer);
  assert.equal(l.status,'completed'); assert.equal(l.valid,true); assert.deepEqual(l.invalidReasons,[]); assert.equal(l.mapMode,'baidu');
  for(const k of ['features'])assert.equal(m[k],n); for(const k of ['vertices','stagedVertices','confirmedVertices','fullyAcknowledgedVertices'])assert.equal(m[k],n*1.2);
  assert.equal(m.unacknowledgedConfirmedVertices,0); assert.equal(m.stagingRevision,m.committedRevision);
  assert.equal(l.expectedFeatures,n); assert.equal(l.completedFeatures,n); assert.equal(l.completedVertices,m.vertices);
  for(const k of ['startedMonotonicMs','loadingEndMs','endedAtMs','firstBusinessDrawMs'])nonnegative(l[k],k);
  assert.ok(l.firstBusinessDrawMs<=l.loadingEndMs && l.loadingEndMs<=l.endedAtMs);
  close(l.loadingEndMs,m.dataDoneMs,'loading boundary'); close(l.endedAtMs,m.totalMs,'run end');
  // app firstVisible and collector firstBusinessDraw call performance.now separately,
  // with a DOM text update between them. They must not be asserted numerically equal.
  nonnegative(m.firstVisibleMs,'app first draw'); assert.ok(m.firstVisibleMs<=l.firstBusinessDrawMs+1e-6,'first draw hook order');
  const eof=l.networkEOF; nonnegative(eof.atMs,'EOF'); close(eof.atMs,run.networkTiming.responseBodyEofAtMs,'EOF raw timing');
  assert.equal(l.firstBusinessDrawBeforeEOF,l.firstBusinessDrawMs<eof.atMs); close(l.eofToDataReadyMs,l.loadingEndMs-eof.atMs,'EOF to ready');
  if(planned.mode!=='baseline')assert.equal(l.firstBusinessDrawBeforeEOF,true,'stream did not draw before consumer EOF');
  samples(l.rafSamples,l); samples(l.businessSamples,l,{business:true});
  cadence(l.raf,l.rafSamples,protocol.referenceMs,'rAF'); cadence(l.business,l.businessSamples,protocol.referenceMs,'business');
  const first=l.businessSamples.find(s=>s.vertices>0&&s.drawCalls>0); assert.ok(first,'no raw nonempty draw'); close(first.atMs,l.firstBusinessDrawMs,'raw first draw');
  assert.deepEqual(l.stages.map(s=>s.id),['0-10','10-50','50-100']);
  for(const stage of l.stages) { const rs=l.rafSamples.filter(s=>s.stage===stage.id),bs=l.businessSamples.filter(s=>s.stage===stage.id); cadence(stage.raf,rs,protocol.referenceMs,'stage rAF');cadence(stage.business,bs,protocol.referenceMs,'stage business');equalNumber(stage.businessFrameCpuP95Ms,quantile(bs.map(s=>s.frameCpuMs),.95),'stage CPU p95'); }
  assert.equal(l.longTaskSupported,true,'required long-task evidence unsupported'); assert.equal(l.longTaskCount,l.longTasks.length);
  let duration=0; for(const t of l.longTasks) {finite(t.atMs,'longtask at');nonnegative(t.duration,'longtask duration');assert.ok(t.atMs<l.loadingEndMs&&t.atMs+t.duration>0);duration+=Math.min(t.atMs+t.duration,l.loadingEndMs)-Math.max(t.atMs,0);} close(l.longTaskDurationMs,duration,'clipped long tasks');
  const prep=l.cameraPreparation; assert.equal(prep.ready,true); assert.ok(samePose(prep.requestedView,prep.actualView),'initial pose mismatch'); assert.deepEqual(prep.requestedView,protocol.baseView);matrix(prep.mvp); assert.ok(prep.stableFrames>=3&&prep.stableDurationMs>=80);assert.ok(prep.elapsedMs<=prep.timeoutMs+100);
  const observed=l.cameraCommands.filter(c=>c.status==='observed'); assert.equal(l.camera.requestedCommands,l.cameraCommands.length); assert.equal(l.camera.observedCommands,observed.length); assert.ok(observed.length>0);
  let changedMatrices=0,changedPoses=0;
  for(const [i,c] of l.cameraCommands.entries()){assert.equal(c.sequence,i+1);nonnegative(c.requestedAtMs,'camera command');assert.ok(c.requestedAtMs<=l.loadingEndMs);if(i)assert.ok(c.requestedAtMs>=l.cameraCommands[i-1].requestedAtMs+99.99);}
  for(const [i,c] of observed.entries()) {assert.ok(c.observedAtMs>=c.requestedAtMs&&c.observedAtMs<=l.loadingEndMs);close(c.commandToBusinessFrameMs,c.observedAtMs-c.requestedAtMs,'camera latency');assert.ok(samePose(c.requestedView,c.actualView),'unobserved requested pose');matrix(c.mvp);matrix(c.beforeMvp);assert.ok(c.observedBusinessSerial>c.businessSerialAtRequest);if(!sameMatrix(i?observed[i-1].mvp:c.beforeMvp,c.mvp))changedMatrices++;if(!samePose(i?observed[i-1].actualView:c.beforeView,c.actualView))changedPoses++;}
  assert.equal(l.camera.observedMatrixChanges,changedMatrices);assert.equal(l.camera.observedPoseChanges,changedPoses);assert.ok(changedMatrices>0&&changedPoses>0);
  const latencies=observed.map(c=>c.commandToBusinessFrameMs);close(l.camera.commandToBusinessFrameMeanMs,mean(latencies),'camera mean');close(l.camera.commandToBusinessFrameP95Ms,quantile(latencies,.95),'camera p95');close(l.camera.commandToBusinessFrameMaxMs,Math.max(...latencies),'camera max');
  assert.ok(!run.visibilityChanges.some(v=>v.state==='hidden'||v.visibility==='hidden'),'hidden trial');
  return {trialId:planned.trialId,mode:planned.mode,count:n,repeat:planned.repeat,firstBusinessDrawMs:l.firstBusinessDrawMs,loadingEndMs:l.loadingEndMs,rawRaf:l.rafSamples.length,rawBusiness:l.businessSamples.length,lastRafAtMs:l.rafSamples.at(-1).atMs,tailAfterLastRafMs:l.loadingEndMs-l.rafSamples.at(-1).atMs,businessMaxIntervalMs:l.business.maxMs,longTaskDurationMs:l.longTaskDurationMs};
}
const baiduChecks=['official SDK custom layer reaches actual onRender','SDK WebGL graphics are identified and not a software rasterizer','UI protocol terminates within declared timeout','complete original report saved via actual export UI','at least one actual server save receipt was observed'];
export function auditBaiduFormalReport(r,e={},c={}) {
  assert.equal(r.schema,'geo-pulse/baidu-loading-ui-2.6'); const historical=e.historicalRecovery===true;
  const runtime=identity(r,e,{historical}); assert.equal(r.configuration.mode,'formal'); assert.deepEqual(r.configuration.sizes,[100000,1000000]);assert.equal(r.configuration.expectedRuns,30);
  if(historical) { assert.equal(r.passed,false);assert.equal(r.status,'failed'); assert.equal(r.error?.message,'report save response is successful');assert.equal(r.saveReceipts.length,1);assert.equal(r.saveReceipts[0].status,201);assert.equal(r.saveReceipts[0].receipt.ok,false);assert.match(r.saveReceipts[0].receipt.error,/evicted from inspector cache/);assert.deepEqual(r.checks.filter(x=>!x.pass).map(x=>x.name),['report save response is successful']); }
  else {assert.equal(r.passed,true);assert.equal(r.status,'completed');}
  checks(r,baiduChecks,{historical});
  if(!historical)checks(r,['exact planned UI trials completed without substitution','all trials are valid in the existing collector','all trials use real Baidu map with exact submitted counts','all streaming trials draw before consumer EOF','zero LocalSearch constructors and network requests','no uncaught browser page errors']);
  assert.deepEqual(r.pageErrors,[]);assert.deepEqual(r.blockedRequests,[]);assert.equal(r.localSearch.networkAttempts,0);assert.equal(r.localSearch.constructorAttempts,0);
  assert.equal(r.graphics.available,true);assert.ok(r.graphics.unmaskedRenderer);assert.doesNotMatch(r.graphics.unmaskedRenderer,/swiftshader|software rasterizer|llvmpipe/i);
  assert.equal(r.instrumentation.publicModified,false);for(const field of ['originalAppSha256','hookSha256','servedAppSha256','toolSha256','resourceModuleSha256','resourceHelperSha256'])digest(r.instrumentation[field],field);
  assert.ok(r.externalRequests.length>0,'no SDK network evidence');assert.ok(r.externalRequestsSeen>=r.externalRequests.length);
  for(const item of r.externalRequests) {assert.ok(!item.query&&!item.url&&!item.search,'external URL query must not be logged');const host=item.host??item.hostname;assert.match(host,/(^|\.)(baidu\.com|bdimg\.com|bdstatic\.com)$/);assert.doesNotMatch(item.path??item.pathname,/\/(place|geosearch)(\/|$)/i);}
  const raw=required(c,'rawEvidence');assert.equal(sha(raw),r.rawEvidence.sha256,'raw evidence SHA');assert.equal(raw.results.length,30);assert.equal(raw.loadingProtocols.length,1);
  assert.equal(raw.renderer.contextLost,false); assert.equal(raw.renderer.lastError,null); assert.equal(raw.renderer.features,raw.results.at(-1).config.count); assert.equal(raw.renderer.totalVertices,raw.results.at(-1).config.count*1.2);
  const protocol=raw.loadingProtocols[0],plan=expectedPlan(r.configuration);assert.deepEqual(protocol.plan,plan);assert.equal(protocol.status,'completed');assert.equal(protocol.formal,true);assert.equal(protocol.kind,'loading-interaction-comparison');assert.equal(protocol.attempts.length,30);assert.equal(protocol.validTrials,30);assert.equal(protocol.completedTrials,30);
  assert.equal(protocol.environment.sourceFingerprint,r.sourceBefore);assert.equal(protocol.environment.runtimeFingerprint,r.runtimeBefore);
  assert.equal(protocol.renderQuality.lodStride,1);assert.equal(protocol.renderQuality.adaptiveLod,false);assert.equal(protocol.renderQuality.riskPreservation,true);assert.equal(protocol.renderQuality.renderPolicy,'continuous');assert.deepEqual(protocol.renderQuality.layers,{points:true,lines:true,polygons:true});
  unique(raw.results.map(x=>x.id),'run IDs');assert.deepEqual(protocol.recordIds,raw.results.map(x=>x.id));
  assert.deepEqual(r.protocolSummary,[{id:protocol.id,status:'completed',attempts:30,validTrials:30,completedTrials:30,error:null}]);
  const trials=raw.results.map((run,i)=>{const attempt=protocol.attempts[i];assert.deepEqual(pick(attempt,planFields),plan[i]);assert.equal(attempt.index,i+1);assert.equal(attempt.recordId,run.id);assert.equal(attempt.valid,true);assert.equal(attempt.status,'completed');return auditRun(run,plan[i],protocol,r);});
  for(let i=1;i<raw.results.length;i++)assert.ok(raw.results[i].loadingExperiment.startedMonotonicMs>=raw.results[i-1].loadingExperiment.startedMonotonicMs+raw.results[i-1].loadingExperiment.endedAtMs,'overlapping trials');
  const saved=savedReports(e,c);assert.equal(saved.length,1,'30-run no-map export must be one part');const part=saved[0];bundle(part,{index:1,total:1,totalRuns:30,ordinals:Array.from({length:30},(_,i)=>i),exportId:part.exportBundle.exportId});assert.deepEqual(part.runs,raw.results,'saved runs differ from raw');assert.deepEqual(part.loadingProtocols,raw.loadingProtocols,'protocol evidence lost');
  if(!historical){assert.equal(r.saveReceipts.length,1);assert.equal(r.saveReceipts[0].status,201);receipt(r.saveReceipts[0].receipt,part);}
  let sourceProof=null;
  if(e.requireTraceWrites??!historical) {
    const trace=required(c,'sourceWriteTrace');assert.equal(sha(trace),r.sourceWriteTrace?.sha256,'source write SHA');digest(r.instrumentation.sourceWriteTraceSha256);assert.equal(trace.schema,'geopulse/server-write-trace-2.6');assert.equal(trace.droppedWrites,0);assert.equal(trace.streams.length,30);
    const writes=trace.streams.flatMap(s=>s.writes);assert.equal(trace.observedWrites,writes.length);assert.deepEqual(writes.map(w=>w.sequence),Array.from({length:writes.length},(_,i)=>i+1),'missing/out-of-order write sequence');assert.equal(r.sourceWriteTrace.observedWrites,writes.length);assert.equal(r.sourceWriteTrace.streams,30);assert.equal(r.sourceWriteTrace.droppedWrites,0);
    for(const [i,s] of trace.streams.entries()){assert.equal(s.ordinal,i);for(const key of ['count','seed','chunk','delay','compression'])assert.equal(String(s.parameters[key]),String(raw.results[i].config[key]),`write request ${key}`);assert.ok(s.writes.length>0);let previous=s.requestEpochMs;for(const w of s.writes){finite(w.serverEpochMs,'write epoch');finite(w.returnEpochMs,'write return epoch');assert.ok(w.serverEpochMs>=previous&&w.returnEpochMs>=w.serverEpochMs);integer(w.length,'nonempty write length');assert.ok(w.length>0);assert.ok(['write','end'].includes(w.kind));assert.ok(['bytes','UTF-16 code units'].includes(w.unit));previous=w.serverEpochMs;}}
    for(const clock of [r.sourceWriteClockBefore,r.sourceWriteClockAfter]){assert.ok(clock.samples.length>=3);for(const s of clock.samples){assert.ok(s.browserAfterEpochMs>=s.browserBeforeEpochMs);close(s.offsetLowerMs,s.serverEpochMs-s.browserAfterEpochMs,'clock lower');close(s.offsetUpperMs,s.serverEpochMs-s.browserBeforeEpochMs,'clock upper');}}
    sourceProof=auditFirstDrawBeforeLaterWrite({trace,clockBefore:r.sourceWriteClockBefore,clockAfter:r.sourceWriteClockAfter,runs:raw.results,browserTimeOrigin:r.browserClock.timeOrigin});assert.deepEqual(r.progressiveSourceProof,sourceProof,'proof differs from raw writes');assert.equal(sourceProof.streamingTrials,20);assert.equal(sourceProof.streamingProven,20);assert.equal(sourceProof.baselineProgressive,0);
  }
  return {auditPassed:true,releaseEligible:!historical,classification:historical?'historical-recovery':'complete-e2e',source:r.sourceBefore,runtime,trials:30,streamingTrials:20,rawRafSamples:trials.reduce((n,t)=>n+t.rawRaf,0),rawBusinessSamples:trials.reduce((n,t)=>n+t.rawBusiness,0),serverWriteProof:sourceProof?.streamingProven??null,trialDiagnostics:trials,scope:'Official SDK + synthetic business geometry, GL-submission/consumer timing. Resource utilization, display FPS and energy savings are not certified by this adapter.',recoveryLimitation:historical?'Original collector remains failed; independently verified saved records cannot turn it into a complete E2E pass.':null};
}
const uiChecks=['existing app initialized without visible error','mobile-only return action is absent on desktop','sleep state does not carry an FPS unit','desktop settings collapse updates semantic state','focus mode hides metrics','dialog Escape preserves focus mode','Escape exits focus and restores collapsed panel preference','changing workspace exits focus and tracks active navigation','sensor workspace navigation remains functional','100000 synthetic features load through gzip stream','loaded map replaces empty state','map tools and layer toggles are accessible','mobile opens with map and collapsed settings','mobile setting action moves focus into revealed section','mobile close returns focus to opener','keyboard control has visible focus outline','HTTP failure freezes finite duration and never says completed','failure diagnostics and progress report partial submitted count','failed status exposes a semantic state','malformed later line keeps exactly one acknowledged batch','partial failure retains map and labels incomplete result','a new run immediately hides the previous error toast','a new run immediately clears the prior partial count','manual stop freezes finite duration and keeps cancellation outcome','stopped run has partial count and an exported table record','stop during yielded commit reports partial geometry before a full batch','partial geometry diagnostics preserve lower-bound language','report export still completes','actual UI report receives server save confirmation','actual saved UI report keeps successful failed and cancelled runs','actual saved UI report preserves partial-geometry confirmation','report bundle supplies source ordinals and stable identity','browser export capacity fixture saves 201 records as exactly three parts','browser capacity fixture reconstructs all 201 original records including statuses and samples','no page errors','no external network or LocalSearch calls','source identity stable during UI verification'];
export function auditUIReport(r,e={},c={}) {
  assert.equal(r.schema,'geo-pulse/ui-functional-2.6');assert.equal(r.passed,true);const historical=e.historicalRecovery===true,runtime=identity(r,e,{ui:true,historical});digest(r.toolSha256);
  checks(r,uiChecks);if(!historical)checks(r,['complete runtime identity stable during UI verification']);assert.deepEqual(r.pageErrors,[]);assert.deepEqual(r.externalRequests,[]);
  const layoutLabels=['desktop empty','desktop loaded','desktop focused','loaded 1920','loaded 1024','loaded 820','loaded 320','loaded 390'];assert.deepEqual(r.layouts.map(x=>x.label),layoutLabels);
  for(const l of r.layouts){assert.ok(l.document.width<=l.viewport.width+1,'document overflow');assert.equal(l.workspace,'live');assert.deepEqual(l.metricOverflow,[]);assert.ok(l.map.width>=Math.min(300,l.viewport.width-24)&&l.map.height>=190,'invisible map');assert.notEqual(l.source,'none');assert.equal(l.map.hidden,false);for(const k of ['width','height']){nonnegative(l.map[k],k);close(l.map[k],k==='width'?l.map.right-l.map.left:l.map.bottom-l.map.top,'map rect');}checks(r,[`${l.label}: no horizontal document overflow`,`${l.label}: metric values remain inside their cell`,`${l.label}: nonzero map and source label`]);}
  assert.deepEqual(r.newMap,r.layouts[0].map);assert.ok(r.newMap.width*r.newMap.height>=r.baselineMap.width*r.baselineMap.height,'map area regression');assert.equal(r.keyboardFocus.outline,'solid');assert.ok(parseFloat(r.keyboardFocus.width)>=2);assert.equal(r.partialCommitFixture.instrumented,true);
  for(const suffix of ['before-1366','empty-1366','experiments-1366','loaded-1366','focus-1366','loaded-1920','loaded-1024','loaded-820','loaded-320','loaded-390','mobile-settings','http-failure','partial-failure','stopped','partial-geometry-stop'])assert.ok(r.screenshots.some(p=>p.endsWith(`-${suffix}.png`)),`missing ${suffix} screenshot reference`);unique(r.screenshots,'screenshot references');
  const saved=savedReports(e,c);assert.equal(saved.length,4,'requires original export plus three capacity parts');const original=saved[0];receipt(r.exportReceipt,original);
  assert.equal(original.runs.length,5); assert.deepEqual(original.runs.map(run=>run.config.count),[100000,10000,10000,100000,100000]); assert.equal(original.runs[0].config.compression,'gzip'); bundle(original,{index:1,total:1,totalRuns:5,ordinals:[0,1,2,3,4],exportId:original.exportBundle.exportId});
  const fields=['stagedVertices','confirmedVertices','fullyAcknowledgedVertices','unacknowledgedConfirmedVertices'];const states=original.runs.map(run=>({status:run.status,features:run.metrics.features,...pick(run.metrics,fields)}));assert.deepEqual(r.exportedStates,states,'reported states not saved states');assert.deepEqual(states.map(s=>s.status),['completed','failed','failed','cancelled','cancelled']);assert.equal(states[0].features,100000);for(const key of ['stagedVertices','confirmedVertices','fullyAcknowledgedVertices'])assert.equal(states[0][key],120000,'completed UI geometry');assert.equal(original.runs[0].metrics.vertices,120000);assert.equal(states[0].unacknowledgedConfirmedVertices,0);assert.equal(states[1].features,0);assert.equal(states[2].features,2048);assert.ok(states[3].features>0&&states[3].features<100000);assert.equal(states[4].features,0);assert.ok(states[4].confirmedVertices>0&&states[4].unacknowledgedConfirmedVertices>0);
  for(const [i,run] of original.runs.entries()){assert.equal(run.environment.sourceFingerprint,r.sourceBefore);if(runtime)assert.equal(run.environment.runtimeFingerprint,runtime);nonnegative(run.metrics.totalMs,'finite terminal duration');assert.ok(Array.isArray(run.frameSamples)&&Array.isArray(run.countSamples)&&Array.isArray(run.longTaskSamples));const s=states[i];for(const k of ['features',...fields])integer(s[k],k);assert.ok(s.stagedVertices>=s.confirmedVertices&&s.confirmedVertices>=s.fullyAcknowledgedVertices);assert.equal(s.unacknowledgedConfirmedVertices,s.confirmedVertices-s.fullyAcknowledgedVertices);}
  const capacity=r.browserExportCapacity;assert.equal(capacity.completed,true);assert.equal(capacity.partCount,3);assert.equal(capacity.totalRuns,201);assert.equal(capacity.receipts.length,3);let byteTotal=0;const exportId=saved[1].exportBundle.exportId;assert.notEqual(exportId,original.exportBundle.exportId);
  for(let i=0;i<3;i++){const part=saved[i+1],start=i*100,ordinals=Array.from({length:Math.min(100,201-start)},(_,j)=>start+j);bundle(part,{index:i+1,total:3,totalRuns:201,ordinals,exportId});assert.equal(capacity.receipts[i].index,i);receipt(capacity.receipts[i].value,part);byteTotal+=bytes(part);assert.equal(part.validationFixture.sourceExportId,original.exportBundle.exportId);assert.equal(part.validationFixture.sourceRunCount,5);assert.match(part.validationFixture.purpose,/not independent performance trials/);for(const [j,ordinal]of ordinals.entries())assert.deepEqual(part.runs[j],original.runs[ordinal%5],'capacity raw sample/status corruption');const {runs,mapFrameAblation,exportBundle,...common}=part;const {runs:unused,mapFrameAblation:unused2,exportBundle:unused3,...common0}=saved[1];assert.deepEqual(common,common0,'common evidence changed across parts');const {validationFixture,...capacityCommon}=common;const {runs:oruns,mapFrameAblation:omap,exportBundle:obundle,...originalCommon}=original;assert.deepEqual(capacityCommon,originalCommon,'capacity lost original common evidence');}
  assert.equal(capacity.bytes,byteTotal);
  return {auditPassed:true,releaseEligible:!historical,classification:historical?'historical-ui':'complete-ui',source:r.sourceBefore,runtime,layouts:r.layouts.length,screenshotReferences:r.screenshots.length,originalRuns:5,capacityRecords:201,capacityParts:3,checks:r.checks.length,scope:'Functional/layout and complete raw export reconstruction only. Screenshot pixels require separate visual review/file binding; synthetic capacity records are not independent performance trials.'};
}
