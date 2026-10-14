import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from '../server.mjs';
import {planReportExport,createReportExportSession,REPORT_MAX_BYTES} from '../public/js/report-export.js';
const common={project:'GeoPulse',schemaVersion:'1.0',loadingProtocols:[{id:'L1',recordIds:['duplicate-id'],attempts:[{status:'completed',trace:['original']}]}],lodAblation:[{samples:[1,2,3]}],demandRenderExperiments:[{raw:['keep']}],realPoiEvidence:{records:[{title:'真实地点'}]},aiReplayEvidence:{labels:['keep']}};
const run=(i,payload='')=>({id:'duplicate-id',config:{seed:i},metrics:{features:i},status:i%3===0?'failed':i%3===1?'cancelled':'completed',rawSamples:[i,'中文',payload]});
const parseParts=plan=>plan.parts.map(part=>JSON.parse(plan.serializePart(part.index).body));
function reconstruct(parts){
 const runs=new Map(),groups=new Map();
 for(const part of parts){
   part.exportBundle.runOrdinals.forEach((ordinal,i)=>{const old=runs.get(ordinal);if(old)assert.deepEqual(part.runs[i],old);runs.set(ordinal,part.runs[i]);});
   const group=part.exportBundle.mapGroupIndex;if(group!==null){assert.ok(!groups.has(group),'map group must not be repeated');groups.set(group,part.mapFrameAblation);}
 }
 return {runs:[...runs].sort((a,b)=>a[0]-b[0]).map(([,value])=>value),groups:[...groups].sort((a,b)=>a[0]-b[0]).map(([,value])=>value)};
}
test('201 mixed successful/failed/cancelled runs reconstruct exactly without sample truncation',()=>{
 const runs=Array.from({length:201},(_,i)=>run(i)),plan=planReportExport({common,runs,exportId:'E1'}),parts=parseParts(plan);
 assert.deepEqual(parts.map(part=>part.runs.length),[100,100,1]);assert.deepEqual(reconstruct(parts).runs,runs);
 for(const part of parts){assert.deepEqual(part.loadingProtocols,common.loadingProtocols);assert.deepEqual(part.demandRenderExperiments,common.demandRenderExperiments);assert.deepEqual(part.realPoiEvidence,common.realPoiEvidence);assert.equal(part.exportBundle.commonEvidenceId,'E1/common');}
});
test('paired chunks and complete map groups avoid a Cartesian product',()=>{
 const runs=Array.from({length:250},(_,i)=>run(i));
 const mapRecords=[{runId:'A',camera:[1]},{runId:'B',camera:[2]},{runId:'A',camera:[3]}];
 const plan=planReportExport({common,runs,mapRecords,exportId:'E2'}),parts=parseParts(plan),restored=reconstruct(parts);
 assert.equal(parts.length,3);assert.deepEqual(parts.map(part=>part.exportBundle.mapRecordOrdinals),[[0,2],[1],[]]);assert.deepEqual(parts.map(part=>part.mapFrameAblation.length),[2,1,0]);assert.deepEqual(restored.runs,runs);assert.deepEqual(restored.groups,[[mapRecords[0],mapRecords[2]],[mapRecords[1]]]);
});
test('extra map groups use explicit ordinal-zero anchors even when run IDs are duplicated',()=>{
 const runs=[run(0),run(1)],mapRecords=Array.from({length:4},(_,i)=>({runId:'group-'+i,raw:[i]}));
 const plan=planReportExport({common,runs,mapRecords,exportId:'E3'}),parts=parseParts(plan);
 assert.equal(parts.length,4);assert.deepEqual(parts.map(part=>part.exportBundle.anchorOnly),[false,true,true,true]);
 assert.deepEqual(parts[2].exportBundle.repeatedRunOrdinals,[0]);assert.deepEqual(reconstruct(parts).runs,runs);assert.equal(reconstruct(parts).groups.length,4);
});
test('UTF-8 byte-aware splitting keeps each raw run intact',()=>{
 const runs=Array.from({length:4},(_,i)=>run(i,'测'.repeat(500)));
 const single=planReportExport({common,runs:[runs[0]],exportId:'byte'}).parts[0].bytes;
 const limit=single+200;
 const plan=planReportExport({common,runs,exportId:'byte',maxBytes:limit}),parts=parseParts(plan);
 assert.equal(parts.length,4);assert.deepEqual(reconstruct(parts).runs,runs);
 for(const item of plan.parts){const serialized=plan.serializePart(item.index);assert.equal(new TextEncoder().encode(serialized.body).byteLength,item.bytes);assert.ok(item.bytes<=limit);}
});
test('oversized single run/map group fails before producing a savable plan',()=>{
 assert.throws(()=>planReportExport({common,runs:[run(0,'x'.repeat(5000))],exportId:'large',maxBytes:1500}),/Run ordinal 0/);
 assert.throws(()=>planReportExport({common,runs:[run(0)],mapRecords:[{runId:'g',samples:'x'.repeat(5000)}],exportId:'large',maxBytes:1500}),/Map evidence group 1/);
});
test('preparation-only interruption evidence survives empty measured runs',()=>{
 const prep={...common,loadingProtocols:[{kind:'loading-interaction-comparison',status:'failed',attempts:[{status:'failed',reason:'camera-timeout'}]}]};
 const plan=planReportExport({common:prep,runs:[],exportId:'prep'}),parts=parseParts(plan);
 assert.equal(parts.length,1);assert.deepEqual(parts[0].runs,[]);assert.deepEqual(parts[0].loadingProtocols,prep.loadingProtocols);
 assert.throws(()=>planReportExport({common,runs:[],exportId:'empty'}),/measured run/);
});
test('later mutation of inputs cannot alter the frozen export or its byte preflight',()=>{
 const metadata=structuredClone(common),runs=[run(7)],mapRecords=[{runId:'g',samples:[1,2]}];
 const plan=planReportExport({common:metadata,runs,mapRecords,exportId:'snapshot'}),before=plan.serializePart(0);
 runs[0].rawSamples.push('later');metadata.loadingProtocols[0].attempts[0].trace.push('later');mapRecords[0].samples.push(3);
 assert.deepEqual(plan.serializePart(0),before);
});
test('limits and reserved metadata cannot weaken the existing server contract',()=>{
 assert.throws(()=>planReportExport({common,runs:[run(0)],exportId:'limit',maxRuns:101}));
 assert.throws(()=>planReportExport({common,runs:[run(0)],exportId:'limit',maxBytes:REPORT_MAX_BYTES+1}));
 assert.throws(()=>planReportExport({common:{...common,runs:[]},runs:[run(0)],exportId:'limit'}));
});


test('partial save retry preserves successful receipts and skips already saved parts',async()=>{
 const plan=planReportExport({common,runs:Array.from({length:201},(_,i)=>run(i)),exportId:'retry'});
 const session=createReportExportSession(plan),posted=[];let fail=true;
 const post=async part=>{posted.push(part.index);if(part.index===1&&fail)throw new Error('network interrupted');return {absolutePath:'server-selected-'+part.index};};
 await assert.rejects(session.saveRemaining(post),/network interrupted/);
 assert.equal(session.completed,false);assert.deepEqual(session.receipts,[{index:0,value:{absolutePath:'server-selected-0'}}]);
 fail=false;await session.saveRemaining(post);
 assert.equal(session.completed,true);assert.deepEqual(posted,[0,1,1,2]);
 assert.equal(session.receipts.length,3);assert.ok(!plan.serializePart(0).body.includes('absolutePath'));
 await session.saveRemaining(post);assert.deepEqual(posted,[0,1,1,2]);
});
test('only one sequential sender may operate on a report snapshot',async()=>{
 const plan=planReportExport({common,runs:[run(0),run(1)],exportId:'sequential',maxRuns:1});
 const session=createReportExportSession(plan);let release;const gate=new Promise(resolve=>release=resolve),posted=[];
 const first=session.saveRemaining(async part=>{posted.push(part.index);if(part.index===0)await gate;return 'receipt-'+part.index;});
 await assert.rejects(session.saveRemaining(async()=>{}),/already being saved/);
 assert.deepEqual(posted,[0]);release();await first;assert.deepEqual(posted,[0,1]);assert.equal(session.completed,true);
});
test('JSON custom metadata serialization cannot replace reserved fields',()=>{
 assert.throws(()=>planReportExport({common:{toJSON:()=>({runs:[]})},runs:[run(0)],exportId:'json'}),/cannot replace/);
 assert.throws(()=>planReportExport({common:{toJSON:()=>null},runs:[run(0)],exportId:'json'}),/remain an object/);
});

test('real local report endpoint accepts 201 runs across parts and all evidence reconstructs',async()=>{
 const reportsRoot=await mkdtemp(join(tmpdir(),'geopulse-export-test-'));
 const server=createServer({reportsRoot});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
   const runs=Array.from({length:201},(_,i)=>run(i));
   const mapRecords=[{runId:'A',samples:[1,2]},{runId:'A',samples:[3]},{runId:'B',samples:[4]}];
   const plan=planReportExport({common,runs,mapRecords,exportId:'real-server'});
   const session=createReportExportSession(plan);
   const endpoint=`http://127.0.0.1:${server.address().port}/api/reports`;
   await session.saveRemaining(async({body})=>{
     const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body});
     const receipt=await response.json();assert.equal(response.status,201,JSON.stringify(receipt));return receipt;
   });
   assert.equal(session.completed,true);assert.equal((await readdir(reportsRoot)).length,3);
   const parts=[];
   for(const {value} of session.receipts){parts.push(JSON.parse(await readFile(value.absolutePath,'utf8')));}
   assert.deepEqual(reconstruct(parts).runs,runs);assert.deepEqual(reconstruct(parts).groups,[[mapRecords[0],mapRecords[1]],[mapRecords[2]]]);
   for(const part of parts)assert.deepEqual(part.loadingProtocols,common.loadingProtocols);
 } finally {await new Promise(resolve=>server.close(resolve));await rm(reportsRoot,{recursive:true,force:true});}
});
