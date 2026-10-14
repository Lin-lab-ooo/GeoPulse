import {parentPort,workerData} from 'node:worker_threads';
const realFetch=globalThis.fetch;
const monitor=reader=>{
 let maxReaderChunkBytes=0,readerReads=0;
 return {async read(){const result=await reader.read();readerReads++;maxReaderChunkBytes=Math.max(maxReaderChunkBytes,result.value?.byteLength??0);return result;},
  async cancel(){return reader.cancel();},releaseLock(){reader.releaseLock();parentPort.postMessage({type:'host-reader-released',maxReaderChunkBytes,readerReads});}};
};
if(workerData.mode!=='http') globalThis.fetch=async()=>{
  let offset=0,cancelled=false;
  const bytes=workerData.bytes,chunk=workerData.chunkBytes??bytes.length;
  return {ok:true,headers:{get:name=>name==='content-type'?'application/x-ndjson':null},body:{getReader:()=>monitor({
    async read(){if(cancelled||offset>=bytes.length)return {done:true};const value=bytes.subarray(offset,Math.min(bytes.length,offset+chunk));offset+=value.length;return {done:false,value};},
    async cancel(){cancelled=true;},releaseLock(){}
  })}};
};
else globalThis.fetch=async(...args)=>{const response=await realFetch(...args);return {ok:response.ok,status:response.status,url:response.url,headers:response.headers,text:()=>response.text(),body:{getReader:()=>monitor(response.body.getReader())}};};
globalThis.self={postMessage:(message,transfer)=>parentPort.postMessage(message,transfer),
  addEventListener:(_type,handler)=>parentPort.on('message',message=>handler({data:message}))};
await import(workerData.moduleURL);
parentPort.postMessage({type:'ready'});
