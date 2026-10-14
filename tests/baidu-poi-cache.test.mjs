import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {validatePoiSnapshot,readPoiSnapshot} from '../public/js/baidu-poi-cache.js';
import {createServer} from '../server.mjs';
const sample=()=>({pois:[{title:'真实样本',lng:121.592,lat:31.189}],metadata:{coordinateSystem:'BD-09',status:'success',actualCount:1,completedAt:'2026-10-09T16:20:00Z'}});

test('browser POI cache is reused without any request and preserves retrieval provenance',async()=>{
  const value=sample();let requests=0;
  const cached=await readPoiSnapshot({storage:{getItem:()=>JSON.stringify(value)},fetcher:()=>{requests++;throw Error('must not fetch');}});
  assert.equal(requests,0);assert.deepEqual(cached.pois,value.pois);assert.equal(cached.metadata.completedAt,value.metadata.completedAt);
});
test('empty browser cache reads only the local snapshot endpoint',async()=>{
  const urls=[];
  const value=await readPoiSnapshot({storage:{getItem:()=>null},fetcher:async url=>{urls.push(url);return{ok:true,json:async()=>sample()};}});
  assert.deepEqual(urls,['/api/poi-sample']);assert.equal(value.pois.length,1);
});
test('missing or corrupt cache fails without silently searching externally',async()=>{
  let requests=0;
  await assert.rejects(readPoiSnapshot({storage:{getItem:()=>'{invalid'},fetcher:()=>{requests++;}}));
  assert.equal(requests,0);
  await assert.rejects(readPoiSnapshot({storage:{getItem:()=>null},fetcher:async()=>({ok:false})}),/不会自动重新检索/);
  assert.throws(()=>validatePoiSnapshot({...sample(),metadata:{...sample().metadata,coordinateSystem:'WGS84'}}));
  assert.throws(()=>validatePoiSnapshot({...sample(),pois:[{title:'bad',lng:Infinity,lat:31}]}));
  assert.throws(()=>validatePoiSnapshot({...sample(),pois:Array(301).fill(sample().pois[0])}));
});
test('local HTTP cache reads a fixed file, rejects mutation, and reports absence',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'geopulse-poi-cache-'));
  const server=createServer({reportsRoot:root});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  try{
    assert.equal((await fetch(origin+'/api/poi-sample')).status,404);
    await writeFile(path.join(root,'baidu-poi-cache.json'),JSON.stringify(sample()));
    const response=await fetch(origin+'/api/poi-sample?file=outside.json');
    assert.equal(response.status,200);assert.deepEqual((await response.json()).pois,sample().pois);
    assert.equal((await fetch(origin+'/api/poi-sample',{method:'POST',body:'{}'})).status,405);
  }finally{
    server.closeIdleConnections?.();await new Promise(resolve=>server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.ok(path.basename(root).startsWith('geopulse-poi-cache-'));
    await rm(root,{recursive:true,force:true});
  }
});
