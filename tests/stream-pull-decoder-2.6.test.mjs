import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {setTimeout as sleep} from 'node:timers/promises';
import {createNdjsonPullDecoder,createNdjsonDecoder,generateRecords} from '../public/js/data.js';
const encode=s=>new TextEncoder().encode(s);
function drain(p,limit,out=[]){while(p.hasPendingInput){const b=p.drain(limit);assert.ok(b.length<=limit);out.push(...b);}return out;}
function decode(bytes,chunk,limit){const p=createNdjsonPullDecoder(),out=[];for(let i=0;i<bytes.length;i+=chunk){p.push(bytes.subarray(i,i+chunk));drain(p,limit,out);}p.finishInput();drain(p,limit,out);return out;}

test('pull decoder matches legacy at every UTF-8 byte boundary, blank lines, CRLF and unterminated final row',()=>{
 const records=[{id:1,name:'通信🌐\r\n测量'},{id:2,name:'北京'},{id:3,name:'é字'}];
 const text='\r\n'+records.map(JSON.stringify).join('\r\n\n')+'\n \n'+JSON.stringify({id:4,name:'尾部'});
 const bytes=encode(text),legacy=createNdjsonDecoder(),expected=[...legacy.push(bytes),...legacy.finish()];
 for(let boundary=0;boundary<=bytes.length;boundary++)for(const limit of [1,2,2048]){
  const p=createNdjsonPullDecoder(),actual=[];p.push(bytes.subarray(0,boundary));drain(p,limit,actual);p.push(bytes.subarray(boundary));drain(p,limit,actual);p.finishInput();drain(p,limit,actual);assert.deepEqual(actual,expected);
 }
 assert.deepEqual(decode(bytes,1,1),expected);
});

test('large chunk is not JSON-parsed in push and drain returns only its explicit allowance',()=>{
 const p=createNdjsonPullDecoder(),count=8192;p.push(encode(Array.from({length:count},(_,i)=>JSON.stringify({id:i})).join('\n')+'\n'));
 assert.equal(p.lineNumber,0);let n=0;for(const limit of [1,2,2048,256,4096]){const b=p.drain(limit);assert.equal(b.length,limit);assert.equal(b[0].id,n);n+=limit;assert.equal(p.lineNumber,n);}
 const rest=drain(p,128);assert.equal(rest.length,count-n);assert.equal(p.bufferedTextCodeUnits,0);p.finishInput();assert.deepEqual(drain(p,1),[]);
});

test('drain input protocol and invalid limits fail without consuming records',()=>{
 const p=createNdjsonPullDecoder();p.push(encode('{"id":1}\n'));
 assert.throws(()=>p.push(encode('{}')),/Drain/);assert.throws(()=>p.finishInput(),/Drain/);
 for(const limit of [0,-1,NaN,Infinity,1.5])assert.throws(()=>p.drain(limit),/limit/);
 assert.deepEqual(p.drain(1),[{id:1}]);p.finishInput();assert.deepEqual(drain(p,2),[]);assert.throws(()=>p.finishInput(),/already/);assert.throws(()=>p.push(encode('{}')),/finished/);
 assert.throws(()=>createNdjsonPullDecoder({maxLineLength:0}),/maxLineLength/);
});

test('malformed later row can fail after valid earlier drain; error keeps physical blank-line numbering',()=>{
 const p=createNdjsonPullDecoder();p.push(encode('\n{"id":1}\r\n \n{"id":2}\n{broken}\n'));
 assert.deepEqual(p.drain(1),[{id:1}]);assert.deepEqual(p.drain(1),[{id:2}]);assert.throws(()=>p.drain(1),/line 5/);assert.throws(()=>p.drain(1),/failed/);
 const legacy=createNdjsonDecoder();assert.throws(()=>legacy.push(encode('{"id":1}\n{broken}\n')),/line 2/);
});

test('line limits span byte chunks, finish parses tail, and fatal UTF8 errors do not complete',()=>{
 let p=createNdjsonPullDecoder({maxLineLength:8});p.push(encode('\n1234'));assert.deepEqual(drain(p,1),[]);p.push(encode('56789'));assert.throws(()=>drain(p,1),/line 2.*size limit/);
 p=createNdjsonPullDecoder({maxLineLength:8});p.push(encode('123456789\n'));assert.throws(()=>p.drain(1),/line 1.*size limit/);
 p=createNdjsonPullDecoder();p.push(encode('{broken}'));drain(p,1);p.finishInput();assert.throws(()=>p.drain(1),/line 1/);
 p=createNdjsonPullDecoder();assert.throws(()=>p.push(Uint8Array.of(255)),/encoded data/);assert.throws(()=>p.finishInput(),/failed/);
 p=createNdjsonPullDecoder();p.push(Uint8Array.of(0xe4,0xb8));drain(p,1);assert.throws(()=>p.finishInput(),/encoded data/);
 p=createNdjsonPullDecoder();p.finishInput();assert.deepEqual(drain(p,1),[]);assert.equal(p.lineNumber,0);
});

function next(w,predicate,ms=5000){return new Promise((resolve,reject)=>{const done=v=>{if(!predicate(v))return;clearTimeout(timer);w.off('message',done);resolve(v);};const timer=setTimeout(()=>{w.off('message',done);reject(new Error('Worker timeout'));},ms);w.on('message',done);});}
async function host(count,chunkBytes=Infinity,tail=''){
 const bytes=encode([...generateRecords({count,seed:97})].map(JSON.stringify).join('\n')+(tail||'\n'));
 const w=new Worker(new URL('../tools/fixtures/stream-worker-host-2.6.mjs',import.meta.url),{workerData:{bytes,chunkBytes:Math.min(chunkBytes,bytes.length),moduleURL:new URL('../public/js/stream-worker.js',import.meta.url).href}});
 await next(w,m=>m.type==='ready');return w;
}
const start=(w,runId,mode='fixed',batchSize=2048)=>w.postMessage({type:'start',runId,mode,batchSize,url:'https://reader.invalid/replay.ndjson'});

test('real Worker bounds parsed objects before ACK and applies adaptive batch changes on the next drain',async()=>{
 const w=await host(10000);try{
  let p=next(w,m=>m.type==='batch');start(w,'adaptive','adaptive');let m=await p;assert.equal(m.batch.featureCount,2048);assert.equal(m.metrics.parsed,2048);assert.equal(m.metrics.maxParsedNotDelivered,2048);
  const sizes=[256,8192];for(const size of sizes){p=next(w,m=>m.type==='batch');w.postMessage({type:'ack',runId:'adaptive',batchSize:size});m=await p;assert.equal(m.batch.featureCount,Math.min(size,10000-m.metrics.delivered+m.batch.featureCount));assert.ok(m.metrics.maxParserDrainRecords<=8192);assert.equal(m.metrics.parsed,m.metrics.delivered);}
  const done=next(w,m=>m.type==='done');w.postMessage({type:'ack',runId:'adaptive'});m=await done;assert.equal(m.metrics.parsed,10000);assert.equal(m.metrics.delivered,10000);assert.equal(m.metrics.maxPendingBatches,1);
 }finally{await w.terminate();}
});

test('real Worker publishes successful prefix batches before later JSON error, never done',async()=>{
 const w=await host(513,Infinity,'\n{broken}\n');const seen=[];w.on('message',m=>seen.push(m));try{
  const failure=next(w,m=>m.type==='error');let p=next(w,m=>m.type==='batch');start(w,'bad','fixed',256);let m=await p;assert.equal(m.batch.featureCount,256);
  p=next(w,m=>m.type==='batch');w.postMessage({type:'ack',runId:'bad'});m=await p;assert.equal(m.batch.featureCount,256);w.postMessage({type:'ack',runId:'bad'});
  assert.match((await failure).message,/line 514/);assert.equal(seen.filter(m=>m.type==='done').length,0);
 }finally{await w.terminate();}
});

test('cancel while first batch awaits ACK stops old parsing; restart isolates new run and stale ACK',async()=>{
 const w=await host(4097);const seen=[];w.on('message',m=>seen.push(m));try{
  let p=next(w,m=>m.type==='batch'&&m.runId==='old');start(w,'old');let m=await p;assert.equal(m.metrics.parsed,2048);
  w.postMessage({type:'cancel',runId:'old'});await sleep(20);w.postMessage({type:'ack',runId:'old'});await sleep(20);assert.equal(seen.filter(m=>m.runId==='old'&&m.type==='batch').length,1);assert.equal(seen.some(m=>m.runId==='old'&&['done','error'].includes(m.type)),false);
  p=next(w,m=>m.type==='batch'&&m.runId==='new');start(w,'new');m=await p;assert.equal(m.metrics.parsed,2048);w.postMessage({type:'ack',runId:'old'});await sleep(20);assert.equal(seen.filter(m=>m.runId==='new'&&m.type==='batch').length,1);
 }finally{await w.terminate();}
});
