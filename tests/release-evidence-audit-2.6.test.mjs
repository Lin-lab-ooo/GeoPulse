/** Prepared offline regressions. No browser/benchmark; historical inputs remain unchanged.
 * Synthetic wrapper/trace mutations below are TEST FIXTURES, never emitted as release evidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {auditBaiduFormalReport,auditUIReport} from '../tools/release-evidence-audit-2.6.mjs';
import {auditFirstDrawBeforeLaterWrite} from '../tools/server-write-trace-2.6.mjs';
const load=name=>JSON.parse(readFileSync(new URL(`../reports/${name}`,import.meta.url),'utf8'));
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const raw=load('baidu-loading-2.6-formal-final-raw-evidence.json');
const original=load('baidu-loading-2.6-formal-final.json');
const saved=load('verified-browser-1791915669010-a4eef363-20f0-4b39-9c6d-e65bec617e5c.json');
const ui=load('ui-functional-2.6-final5.json');
const uiParts=[ui.exportReceipt,...ui.browserExportCapacity.receipts.map(x=>x.value)].map(receipt=>load(receipt.fileName));
const uiCompanions={savedReports:uiParts};
const changedReceipt=(old,part)=>{const count=Buffer.byteLength(JSON.stringify(part));return {...old,bytes:count,...(Object.hasOwn(old,'verifiedBytes')?{verifiedBytes:count}:{}),...(Object.hasOwn(old,'sha256')?{sha256:sha(part)}:{})};};
const history={historicalRecovery:true};
const historicalCompanions={rawEvidence:raw,savedReports:[saved]};
function completeFixture() {
  const r=structuredClone(original);
  r.status='completed';r.passed=true;delete r.error;
  r.checks=r.checks.filter(x=>x.pass);
  for(const name of ['exact planned UI trials completed without substitution','all trials are valid in the existing collector','all trials use real Baidu map with exact submitted counts','all streaming trials draw before consumer EOF','zero LocalSearch constructors and network requests','no uncaught browser page errors','report save response is successful'])r.checks.push({name,pass:true});
  r.saveReceipts=[{status:201,receipt:{ok:true,bytes:Buffer.byteLength(JSON.stringify(saved)),verifiedBytes:Buffer.byteLength(JSON.stringify(saved)),sha256:sha(saved)}}];
  const origin=r.browserClock.timeOrigin; let sequence=0;
  const trace={schema:'geopulse/server-write-trace-2.6',clock:'Node performance.timeOrigin + performance.now',maximumWrites:50000,observedWrites:0,droppedWrites:0,streams:raw.results.map((run,i)=>{
    const l=run.loadingExperiment,first=origin+l.startedMonotonicMs+l.firstBusinessDrawMs;
    const at=run.config.mode==='baseline'?first-10:first+10;
    return {ordinal:i,requestEpochMs:origin+l.startedMonotonicMs,parameters:Object.fromEntries(['count','seed','chunk','delay','compression'].map(k=>[k,String(run.config[k])])),writes:Array.from({length:Math.ceil(run.config.count/run.config.chunk)},(_,j)=>{const written=origin+l.startedMonotonicMs+(at-origin-l.startedMonotonicMs)*(j+1)/Math.ceil(run.config.count/run.config.chunk);return {sequence:++sequence,kind:'write',serverEpochMs:written,returnEpochMs:written+.01,length:100,unit:'bytes',accepted:true};}),finishEpochMs:at+1,closeEpochMs:at+1,endCallEpochMs:at+1};
  })};
  trace.observedWrites=sequence;
  const clock={scope:'Synthetic test-only exact same-host clock',samples:Array.from({length:7},(_,i)=>({browserBeforeEpochMs:origin+i,browserAfterEpochMs:origin+i+.2,serverEpochMs:origin+i+.1,offsetLowerMs:(origin+i+.1)-(origin+i+.2),offsetUpperMs:(origin+i+.1)-(origin+i)}))};
  r.sourceWriteClockBefore=clock;r.sourceWriteClockAfter=structuredClone(clock);
  r.sourceWriteTrace={sha256:sha(trace),streams:30,observedWrites:sequence,droppedWrites:0};
  r.instrumentation.sourceWriteTraceSha256='a'.repeat(64);
  r.progressiveSourceProof=auditFirstDrawBeforeLaterWrite({trace,clockBefore:clock,clockAfter:clock,runs:raw.results,browserTimeOrigin:origin});
  return {r,c:{...historicalCompanions,sourceWriteTrace:trace}};
}
function changedRun(fixture,change) {
  const runs=[...raw.results];runs[0]=change(runs[0]);const changed={...raw,results:runs};
  fixture.c={...fixture.c,rawEvidence:changed,savedReports:[{...saved,runs}]};fixture.r.rawEvidence={...fixture.r.rawEvidence,sha256:sha(changed)};
  const p=fixture.c.savedReports[0];fixture.r.saveReceipts[0].receipt={ok:true,bytes:Buffer.byteLength(JSON.stringify(p)),sha256:sha(p)};
  return fixture;
}
test('original collector failure cannot become current E2E pass',()=>assert.throws(()=>auditBaiduFormalReport(original,{},historicalCompanions)));
test('historical recovery verifies all original records but is never release eligible',()=>{
  const result=auditBaiduFormalReport(original,history,historicalCompanions);assert.equal(result.releaseEligible,false);assert.equal(result.classification,'historical-recovery');assert.equal(result.trials,30);assert.equal(result.serverWriteProof,null);
});
test('complete test-only wrapper plus independent write trace audits 30 exact trials',()=>{
  const {r,c}=completeFixture();const result=auditBaiduFormalReport(r,{source:r.sourceBefore,runtime:r.runtimeBefore},c);assert.equal(result.releaseEligible,true);assert.equal(result.serverWriteProof,20);
});
test('missing companion is rejected even when wrapper passed',()=>{const {r}=completeFixture();assert.throws(()=>auditBaiduFormalReport(r,{},{}),/Missing companion/);});
test('unexpected runtime identity is rejected',()=>{const {r,c}=completeFixture();assert.throws(()=>auditBaiduFormalReport(r,{runtime:'b'.repeat(64)},c),/unexpected runtime/);});
test('raw cadence summary tampering fails despite updated raw hash and save bytes',()=>{
  const f=changedRun(completeFixture(),run=>({...run,loadingExperiment:{...run.loadingExperiment,raf:{...run.loadingExperiment.raf,p95Ms:0}}}));assert.throws(()=>auditBaiduFormalReport(f.r,{},f.c),/p95Ms/);
});
test('same trial repeated is rejected, not counted as a valid replicate',()=>{
  const f=changedRun(completeFixture(),run=>({...run,loadingExperiment:{...run.loadingExperiment,trial:{...run.loadingExperiment.trial,trialId:'loading-100000-fixed-r1'}}}));assert.throws(()=>auditBaiduFormalReport(f.r,{},f.c),/trial differs/);
});
test('saved raw arrays cannot be dropped after successful receipt',()=>{
  const {r,c}=completeFixture();c.savedReports=[{...saved,runs:saved.runs.slice(1)}];assert.throws(()=>auditBaiduFormalReport(r,{},c));
});
test('trace counters and conservative later-write proof cannot be fabricated',()=>{
  const {r,c}=completeFixture();c.sourceWriteTrace={...c.sourceWriteTrace,droppedWrites:1};r.sourceWriteTrace.sha256=sha(c.sourceWriteTrace);assert.throws(()=>auditBaiduFormalReport(r,{},c));
});
test('claimed later write must remain after draw under raw timestamps',()=>{
  const {r,c}=completeFixture(),trace=structuredClone(c.sourceWriteTrace);const s=trace.streams[1];for(const w of s.writes){w.serverEpochMs=s.requestEpochMs;w.returnEpochMs=s.requestEpochMs+.01;}c.sourceWriteTrace=trace;r.sourceWriteTrace.sha256=sha(trace);assert.throws(()=>auditBaiduFormalReport(r,{},c),/proof differs/);
});
test('hidden-page raw event invalidates trial even if summary says valid',()=>{
  const f=changedRun(completeFixture(),run=>({...run,visibilityChanges:[{atMs:100,state:'hidden'}]}));assert.throws(()=>auditBaiduFormalReport(f.r,{},f.c),/hidden trial/);
});
test('legacy UI artifact is historical only and reconstructs 201 raw records',()=>{
  assert.throws(()=>auditUIReport(ui,{},uiCompanions));const result=auditUIReport(ui,history,uiCompanions);assert.equal(result.releaseEligible,false);assert.equal(result.capacityRecords,201);assert.equal(result.originalRuns,5);
});
test('UI complete test fixture with runtime identity and saved records passes',()=>{
  const runtime='d'.repeat(64),r={...ui,runtimeSourceBefore:runtime,runtimeSourceAfter:runtime,checks:[...ui.checks,{name:'complete runtime identity stable during UI verification',pass:true}]};
  const parts=uiParts.map(part=>({...part,runs:part.runs.map(run=>({...run,environment:{...run.environment,runtimeFingerprint:runtime}}))}));
  r.exportReceipt=changedReceipt(r.exportReceipt,parts[0]);r.browserExportCapacity={...ui.browserExportCapacity,receipts:ui.browserExportCapacity.receipts.map((item,i)=>({...item,value:changedReceipt(item.value,parts[i+1])})),bytes:parts.slice(1).reduce((n,p)=>n+Buffer.byteLength(JSON.stringify(p)),0)};
  assert.equal(auditUIReport(r,{runtime},{savedReports:parts}).releaseEligible,true);
});
test('UI map overflow is rechecked from raw rectangles',()=>{
  const r={...ui,layouts:ui.layouts.map((l,i)=>i?l:{...l,document:{...l.document,width:5000}})};assert.throws(()=>auditUIReport(r,history,uiCompanions),/overflow/);
});
test('UI cannot lose completed or partial commit geometry counters',()=>{
  const r={...ui,exportedStates:ui.exportedStates.map((s,i)=>i===4?{...s,confirmedVertices:0}:s)};assert.throws(()=>auditUIReport(r,history,uiCompanions),/reported states/);
  const parts=uiParts.map(part=>({...part,runs:part.runs.map(run=>run.status==='completed'?{...run,metrics:{...run.metrics,vertices:0,stagedVertices:0,confirmedVertices:0,fullyAcknowledgedVertices:0}}:run)}));
  const changed={...ui,exportReceipt:changedReceipt(ui.exportReceipt,parts[0]),exportedStates:ui.exportedStates.map((s,i)=>i? s:{...s,stagedVertices:0,confirmedVertices:0,fullyAcknowledgedVertices:0})};
  assert.throws(()=>auditUIReport(changed,history,{savedReports:parts}),/completed UI geometry/);
});
test('UI capacity duplicate ordinal is rejected',()=>{
  const parts=[...uiParts];parts[2]={...parts[2],exportBundle:{...parts[2].exportBundle,runOrdinals:Array.from({length:100},(_,i)=>i)}};assert.throws(()=>auditUIReport(ui,history,{savedReports:parts}));
});
test('UI raw frame sample alteration fails exact reconstruction',()=>{
  const parts=[...uiParts];parts[3]={...parts[3],runs:[{...parts[3].runs[0],frameSamples:[]}]};const r={...ui,browserExportCapacity:{...ui.browserExportCapacity,receipts:ui.browserExportCapacity.receipts.map((item,i)=>i===2?{...item,value:changedReceipt(item.value,parts[3])}:item),bytes:parts.slice(1).reduce((n,p)=>n+Buffer.byteLength(JSON.stringify(p)),0)}};assert.throws(()=>auditUIReport(r,history,{savedReports:parts}),/capacity raw sample/);
});
test('UI missing keyboard or cancellation checks cannot be hidden by passed flag',()=>{
  const r={...ui,checks:ui.checks.filter(c=>c.name!=='mobile close returns focus to opener')};assert.throws(()=>auditUIReport(r,history,uiCompanions),/Missing passing check/);
});
