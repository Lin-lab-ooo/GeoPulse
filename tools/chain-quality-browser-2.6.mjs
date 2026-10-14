/** Full production HTTP/Worker/app/GL/export chain. Exclusive native browser execution. */
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {createServer,computeSourceFingerprint,computeRuntimeFingerprint} from '../server.mjs';
import {makeChainRecords,ChainOracle,runChainOracleSelfCheck} from './fixtures/chain-oracle-2.6.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const args=Object.fromEntries(process.argv.slice(2).map(x=>{const [k,...v]=x.replace(/^--/,'').split('=');return[k,v.length?v.join('='):true];}));
const phase=args.phase||'quality',sdk=!!args.sdk,repeats=Number(args.repeats||3);
assert.ok(['quality','performance'].includes(phase));assert.ok(!sdk||phase==='performance');assert.ok(repeats>=1&&repeats<=5);
const stem=String(args.stem||`chain-${phase}-2.6-${Date.now()}`);assert.match(stem,/^[a-zA-Z0-9.-]+$/);
const dir=path.join(root,'reports',stem+'-exports'),output=path.join(root,'reports',stem+'.json');
await assert.rejects(readFile(output),{code:'ENOENT'});await mkdir(dir,{recursive:false});
const sha=x=>createHash('sha256').update(x).digest('hex');
const ak=process.env.GEOPULSE_BAIDU_AK?.trim()||'';if(sdk)assert.ok(ak);
const clean=x=>String(x).replaceAll(ak||'__NO_KEY__','[REDACTED]').replace(/https?:\/\/[^\s"'<>]+/g,s=>{try{const u=new URL(s);return u.hostname==='127.0.0.1'?s:u.origin+u.pathname;}catch{return'[URL]';}});
const variants=(args.variants||'reference,current,hybrid,large,hybridBounds').split(',');
const sizes=(args.sizes||'100000,1000000').split(',').map(Number);
const compressionPolicy=args.compression||'alternate',delay=Number(args.delay||0),qualityCount=Number(args['quality-count']||18000);
assert.ok(['identity','gzip','alternate'].includes(compressionPolicy));assert.ok(delay>=0&&delay<=1000);assert.ok(qualityCount>=18000&&qualityCount<=100000);
const original=await readFile(path.join(root,'public/js/app.js')),hook=await readFile(path.join(root,'tools/fixtures/chain-app-hook-2.6.js'));
const served=Buffer.concat([original,Buffer.from('\n'),hook]);
for(const [name,bytes] of [['tool.mjs',await readFile(fileURLToPath(import.meta.url))],['hook.js',hook],['oracle.mjs',await readFile(path.join(root,'tools/fixtures/chain-oracle-2.6.mjs'))]])await writeFile(path.join(dir,name),bytes,{flag:'wx'});
const report={schema:'geo-pulse/full-chain-combinations-2.6',createdAt:new Date().toISOString(),phase,sdk,passed:false,
  sourceBefore:await computeSourceFingerprint(root),runtimeBefore:await computeRuntimeFingerprint(root),
  bindings:{tool:sha(await readFile(fileURLToPath(import.meta.url))),app:sha(original),hook:sha(hook),served:sha(served),oracle:sha(await readFile(path.join(root,'tools/fixtures/chain-oracle-2.6.mjs')))},
  configuration:{variants,sizes,repeats,compressionPolicy,delay,qualityCount,viewport:{width:1366,height:768},quality:{adaptive:false,riskPreservation:true,layers:'all',lod:1}},
  scope:'Equal-quality combinations. Reference disables spatial/picking and uses ranges/continuous; current retains production options; hybrid changes Worker batch after first ACK; large uses 8192; hybridBounds additionally enables liveBounds/movedFilter. Combination differences cannot identify a single component causal effect.',
  limitations:['Synthetic business records; real SDK only when sdk=true. No POI queries.','Independent CPU geometry oracle and full RGBA are quality-phase only; pixel oracle reuses current shader with spatial selection disabled.','Performance-phase hashes compare all CPU geometry across combinations, not GPU readback. AwaitCommit measures upload submission, not GPU completion or display.','LOD1 is explicitly locked to compare identical quality; default adaptive LOD is covered only by prior evidence.','Three serial repeats on one machine; cold first run retained. No universal winner or statistical significance claim.','Move/color only affect existing subscribed slots; late same-ID append keeps input xy/RGBA; tombstones persist.','Known SDK context-loss reload is unresolved; ordinary chains do not certify forced context recovery.'],
  checks:[],trials:[],pixelChecks:[],pageErrors:[],blockedRequests:[],requestFailures:[],fixtureRequests:[],exports:[],events:[],localSearchAttempts:0};
const check=(name,pass,details={})=>{report.checks.push({name,pass,...details});assert.ok(pass,name);};
let browser,context,page,server;const fixtures=new Map();let nextSeed=4000000000;
const fixture=(records,options={})=>{const seed=nextSeed++;let release;const gate=new Promise(r=>release=r);fixtures.set(seed,{records,...options,gate,release,closed:false});return {seed,release};};
const serialSnapshot=o=>{const s=o.snapshot();return {...s,groups:s.groups.map(g=>({...g,positions:Array.from(g.positions),colors:Array.from(g.colors),ids:Array.from(g.ids)}))};};
const state=()=>page.evaluate(()=>__chain.state());
const until=async(predicate,label,timeout=120000)=>{const deadline=performance.now()+timeout;let s;while(performance.now()<deadline){s=await state();if(predicate(s))return s;await sleep(25);}throw Error(`${label} timeout ${JSON.stringify({id:s?.id,status:s?.status,shown:s?.shown})}`);};
const begin=(config,variant)=>page.evaluate(({config,variant})=>__chain.begin(config,variant),{config:{mode:'fixed',compression:'identity',chunk:1024,delay:0,...config},variant});
const complete=async(id,count)=>{const s=await until(s=>s.id===id&&s.status!=='running','complete');check(`${id}: completed exact acknowledged counts`,s.status==='completed'&&s.shown===count&&s.features===count&&s.staged===s.totalVertices&&s.confirmed===s.staged&&s.acknowledged===s.confirmed&&!s.worker&&s.pendingGeometryPages===0&&s.committedRevision===s.stagingRevision,{state:{id:s.id,status:s.status,shown:s.shown,vertices:s.totalVertices}});return s;};
const compare=async(label,oracle,{pixels=false}={})=>{const expected=serialSnapshot(oracle);const checks=await page.evaluate(e=>__chain.exact(e),expected);check(`${label}: every geometry slot and complete primitive matches independent oracle`,checks.every(c=>c.pass),{attributes:checks});
  if(pixels)for(const view of [{x:0,y:0,heading:0,scale:.05},{x:400,y:200,heading:.49,scale:1}]){const result=await page.evaluate(({expected,view})=>__chain.pixels(expected,view),{expected,view});report.pixelChecks.push({label,...result});check(`${label}: full RGBA matches unculled canonical state scale ${view.scale} heading ${view.heading} radians`,result.differingBytes===0&&result.nonzeroBytes>0,{bytes:result.bytes,actualSHA:result.actualSHA,oracleSHA:result.oracleSHA});}
};
try{
  check('independent oracle self-check',runChainOracleSelfCheck().passed===true);
  server=createServer({reportsRoot:dir});const handler=server.listeners('request')[0];server.removeAllListeners('request');
  server.on('request',async(req,res)=>{try{const u=new URL(req.url,'http://localhost');
    if(u.pathname==='/js/app.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(served);return;}
    const f=u.pathname==='/api/stream'?fixtures.get(Number(u.searchParams.get('seed'))):null;
    if(!f){handler(req,res);return;}
    const observation={seed:Number(u.searchParams.get('seed')),startedAt:Date.now(),written:0,closed:false,ended:false};report.fixtureRequests.push(observation);
    res.once('close',()=>{f.closed=true;observation.closed=true;});
    if(f.httpError){res.writeHead(503,{'Content-Type':'text/plain'});res.end('Injected chain test service failure');return;}
    res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','X-Stream-Count':String(f.expected??f.records.length),'Cache-Control':'no-store'});res.flushHeaders();
    const write=async(bytes)=>{if(res.destroyed)return;if(!res.write(bytes))await new Promise(r=>{res.once('drain',r);res.once('close',r);});};
    const send=async records=>{const text=records.map(r=>JSON.stringify(r)).join('\r\n')+'\r\n';const b=Buffer.from(text);const chinese=b.indexOf(Buffer.from('区'));const cut=chinese<0?13:chinese+1;await write(b.subarray(0,cut));await sleep(2);await write(b.subarray(cut));observation.written+=records.length;};
    if(f.prefix){await send(f.records.slice(0,f.prefix));await f.gate;}
    if(!res.destroyed){await send(f.records.slice(f.prefix||0));if(f.badTail)await write(Buffer.from(f.badTail));res.end();observation.ended=true;}
  }catch(e){if(!res.destroyed)res.destroy(e);}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  const playwrightModule=args.playwright||process.env.PLAYWRIGHT_MODULE;
  const {chromium}=await import(playwrightModule?pathToFileURL(path.resolve(playwrightModule)).href:'playwright');
  browser=await chromium.launch({headless:true,...((args.browser||process.env.BROWSER_EXECUTABLE)?{executablePath:args.browser||process.env.BROWSER_EXECUTABLE}:{})});report.browserVersion=browser.version();
  context=await browser.newContext({viewport:report.configuration.viewport,deviceScaleFactor:1,serviceWorkers:'block'});
  await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin===origin)return route.continue();
    if(/\/(place|geosearch)(\/|$)/i.test(u.pathname)||['s','sug','con'].includes(u.searchParams.get('qt'))){report.localSearchAttempts++;return route.abort();}
    if(sdk&&/(^|\.)(baidu\.com|bdimg\.com|bdstatic\.com)$/.test(u.hostname))return route.continue();
    report.blockedRequests.push(u.origin+u.pathname);return route.abort();});
  page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(clean(e.message)));page.on('requestfailed',r=>report.requestFailures.push({url:clean(r.url()),error:r.failure()?.errorText}));
  report.requests=[];page.on('request',r=>{if(report.requests.length<100)report.requests.push(clean(r.url()));});
  check('HTTP server responds before browser navigation',(await fetch(origin+'/api/health')).ok);
  await page.goto(origin,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForFunction(()=>!!window.__chain&&!document.getElementById('start-button').disabled);
  if(sdk){await page.locator('#settings-button').click();await page.locator('#ak-input').fill(ak);await page.locator('#remember-ak').uncheck();await page.locator('#connect-button').click();await until(s=>s.mode==='baidu','SDK connect',60000);await page.locator('#settings-dialog').waitFor({state:'hidden'});await page.locator('#ak-input').evaluate(e=>e.value='');}
  const initial=await state(),realm=await page.evaluate(()=>performance.timeOrigin);report.graphics=initial.graphics;
  check('native GPU available',initial.graphics.available&&!/SwiftShader|llvmpipe/i.test(initial.graphics.unmaskedRenderer||''));
  if(phase==='quality'){
    for(const variant of variants){
      const records=makeChainRecords(qualityCount,42),prefix=variant==='large'?8192:2048,material=fixture(records,{prefix});
      const started=await begin({count:records.length,seed:material.seed},variant);await until(s=>s.id===started.id&&s.shown===prefix,'first ACK');
      const oracle=new ChainOracle(records.slice(0,prefix));await page.evaluate(()=>__chain.track([1,89,99]));
      const ops=[['updateFeaturePositions',[{id:1,x:51,y:72},{id:1,x:90.25,y:70.5}],'applyMove'],['updateFeatureColors',[{id:1,color:[25,90,240,153]}],'applyColor'],['removeFeatures',[1],'applyRemove'],['updateFeaturePositions',[{id:1,x:999,y:999}],'applyMove']];
      for(const [op,data,method] of ops){await page.evaluate(({op,data})=>__chain.change(op,data),{op,data});oracle[method](data);}
      await compare(`${variant}/prefix-edits`,oracle,{pixels:true});
      await page.locator('#layer-lines').uncheck();material.release();await complete(started.id,records.length);oracle.append(records.slice(prefix));
      await compare(`${variant}/tail-with-tombstones-hidden-lines`,oracle,{pixels:true});await page.locator('#layer-lines').check();
      await page.evaluate(()=>__chain.change('restoreFeatures',[1]));oracle.applyRestore([1]);
      const mixed=[{id:89,x:-120.5,y:140.25},{id:99,x:220.5,y:-180.75}];await page.evaluate(x=>__chain.change('updateFeaturePositions',x),mixed);oracle.applyMove(mixed);
      await compare(`${variant}/restored-and-complete-primitives`,oracle,{pixels:true});
      const cancelled=fixture(records,{prefix});const old=await begin({count:records.length,seed:cancelled.seed},variant);await until(s=>s.id===old.id&&s.shown===prefix,'cancel prefix');
      await page.locator('#stop-button').click();const freshRecords=makeChainRecords(10000,75),fresh=fixture(freshRecords);const next=await begin({count:10000,seed:fresh.seed},variant);cancelled.release();await complete(next.id,10000);await compare(`${variant}/cancel-immediate-restart`,new ChainOracle(freshRecords),{pixels:true});
      const oldRows=await page.evaluate(id=>__chain.records().filter(r=>r.id===id||r.runId===id),old.id);
      check(`${variant}: cancelled run is recorded once with acknowledged prefix`,oldRows.length===1&&oldRows[0].status==='cancelled'&&oldRows[0].metrics.features===prefix,{oldId:old.id,rows:oldRows.length,status:oldRows[0]?.status,features:oldRows[0]?.metrics.features});
      for(const failure of ['503','short','invalidRecord','malformedJSON']){const count=variant==='large'?8192:2048,badRecords=failure==='503'?[]:makeChainRecords(count,77),bad=fixture(badRecords,{httpError:failure==='503',expected:count+1,badTail:failure==='invalidRecord'?'null\n':failure==='malformedJSON'?'{"id":\n':null});const badRun=await begin({count:count+1,seed:bad.seed},variant);const failed=await until(s=>s.id===badRun.id&&s.status!=='running','fault terminal');check(`${variant}/${failure}: fails and releases Worker with exact prefix`,failed.status==='failed'&&!failed.worker&&failed.activeWorkers===0&&failed.shown===badRecords.length,{status:failed.status,shown:failed.shown});await compare(`${variant}/${failure}-prefix`,new ChainOracle(badRecords));
        const row=await page.evaluate(()=>__chain.records().at(-1));check(`${variant}/${failure}: failure reason identifies injected cause`,failure==='503'?/503/.test(row.failureReason):failure==='short'?/count|expected|record/i.test(row.failureReason):failure==='invalidRecord'?/Invalid record|object/.test(row.failureReason):/Invalid NDJSON/.test(row.failureReason),{reason:row.failureReason});}
    }
  }else{
    let ordinal=0;const hashes=new Map();
    for(const count of sizes)for(let repeat=0;repeat<repeats;repeat++){
      const order=[...variants.slice(repeat%variants.length),...variants.slice(0,repeat%variants.length)];
      for(const variant of order){const seed=20261014+repeat,compression=compressionPolicy==='alternate'?(repeat%2?'gzip':'identity'):compressionPolicy,started=await begin({count,seed,chunk:1024,delay,compression},variant);const final=await complete(started.id,count);
        await sleep(220);const records=await page.evaluate(()=>__chain.records());const record=records.at(-1),digest=await page.evaluate(()=>__chain.digest());const key=count+':'+seed;
        if(hashes.has(key))check(`${variant}/${key}: full CPU geometry equals other combinations`,JSON.stringify(digest)===hashes.get(key));else hashes.set(key,JSON.stringify(digest));
        const update=await page.evaluate(()=>__chain.workload());
        const before=await page.evaluate(()=>__chain.renderStats());await page.locator('#rotate-view').click();await page.locator('#zoom-in').click();await page.locator('#zoom-out').click();await sleep(250);const after=await page.evaluate(()=>__chain.renderStats());
        report.trials.push({ordinal:ordinal++,cold:ordinal===1,variant,count,repeat,seed,compression,runId:started.id,metrics:record.metrics,protocol:record.protocol,frameSamples:record.frameSamples,countSamples:record.countSamples,digest,update,beforeInteraction:before,afterInteraction:after,final:{batches:final.batches,vertices:final.totalVertices}});
        check(`${variant}/${key}: document and quality preserved`,await page.evaluate(t=>performance.timeOrigin===t,realm)&&after.adaptive===false&&after.lodStride===1);
        console.log(JSON.stringify({variant,count,repeat,first:record.metrics.firstVisibleMs,total:record.metrics.totalMs,checks:report.checks.length}));
      }
    }
  }
  const expected=await page.evaluate(()=>__chain.records());
  await page.locator('[data-view="bench"]').click();await page.locator('#export-button').click();await page.waitForFunction(()=>!document.getElementById('export-button').disabled);
  const saved=[];for(const name of await readdir(dir)){if(!name.endsWith('.json'))continue;const raw=await readFile(path.join(dir,name));const data=JSON.parse(raw);report.exports.push({path:path.relative(root,path.join(dir,name)),sha256:sha(raw),bytes:raw.length});saved.push(...(data.runs||[]));}
  check('actual server-saved export preserves every run in exact order and detail',JSON.stringify(saved)===JSON.stringify(expected),{expectedRuns:expected.length,savedRuns:saved.length});
  const final=await state();report.events=await page.evaluate(()=>__chain.events());report.finalState=final;
  check('one outstanding batch and no invalid/stale ACK',final.peakPending===1&&final.errors.length===0,{peak:final.peakPending,errors:final.errors});
  check('all stream Workers released',final.activeWorkers===0);
  if(phase==='quality'){await sleep(100);check('all fixture HTTP responses closed',report.fixtureRequests.every(r=>r.closed));}
  check('no uncaught page errors',report.pageErrors.length===0,{errors:report.pageErrors});
  check('no location search requests',report.localSearchAttempts===0);
  report.screenshot=path.join(root,'reports',stem+'.png');await page.screenshot({path:report.screenshot});report.passed=true;
}catch(e){report.error={message:clean(e.message),stack:clean(e.stack)};console.error(clean(e.stack));}
finally{
  for(const f of fixtures.values())f.release();
  if(browser)await browser.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));report.serverCounters=server.streamCounters;}
  report.sourceAfter=await computeSourceFingerprint(root);report.runtimeAfter=await computeRuntimeFingerprint(root);
  if(report.sourceAfter!==report.sourceBefore||report.runtimeAfter!==report.runtimeBefore){report.passed=false;report.sourceMutation=true;}
  report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,(_k,v)=>typeof v==='string'?clean(v):v,2),{flag:'wx'});console.log(JSON.stringify({output,passed:report.passed,checks:report.checks.length,pixels:report.pixelChecks.length,trials:report.trials.length}));
}
if(!report.passed)process.exitCode=1;
