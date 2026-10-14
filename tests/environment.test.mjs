import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computeSourceFingerprint, computeRuntimeFingerprint, createServer } from '../server.mjs';

test('implementation fingerprint is deterministic, changes with source bytes, and excludes reports and keys', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geopulse-fingerprint-'));
  try {
    await mkdir(path.join(root, 'public/js/nested'), { recursive: true });
    const sources = {
      'server.mjs': 'export const server = 1;\n',
      'public/index.html': '<main>GeoPulse</main>',
      'public/styles.css': 'main { display: grid }',
      'public/enhancements.css': '[hidden] { display: none }',
      'public/js/z.js': 'export const z = 1;',
      'public/js/nested/a.js': 'export const a = 1;',
    };
    for (const [name, bytes] of Object.entries(sources)) await writeFile(path.join(root, name), bytes);
    const first = await computeSourceFingerprint(root);
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(await computeSourceFingerprint(root), first);
    await mkdir(path.join(root, 'reports'));
    await writeFile(path.join(root, 'reports/test.json'), '{"runs":[]}');
    await writeFile(path.join(root, '.env'), 'BAIDU_AK=test-only-placeholder');
    await writeFile(path.join(root, 'public/js/readme.txt'), 'Non-code metadata');
    assert.equal(await computeSourceFingerprint(root), first);
    await writeFile(path.join(root, 'public/js/nested/a.js'), 'export const a = 2;');
    assert.notEqual(await computeSourceFingerprint(root), first);
    const beforeModel=await computeSourceFingerprint(root);
    await mkdir(path.join(root,'public/ai'));
    await writeFile(path.join(root,'public/ai/model.json'),'{"weights":[1]}');
    const afterModel=await computeSourceFingerprint(root);
    assert.notEqual(afterModel,beforeModel);
    await writeFile(path.join(root,'public/ai/model.json'),'{"weights":[2]}');
    assert.notEqual(await computeSourceFingerprint(root),afterModel);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('environment reports version and fresh legacy and complete runtime digests without file destination metadata', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const first = await (await fetch(`${origin}/api/environment`)).json();
    const second = await (await fetch(`${origin}/api/environment`)).json();
    assert.equal(first.implementationVersion, '2.6');
    assert.equal(first.sourceFingerprintAlgorithm, 'SHA-256');
    assert.match(first.sourceFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(first.sourceFingerprint, second.sourceFingerprint);
    assert.equal(first.sourceFingerprintSchema, 'legacy-v1');
    assert.equal(first.runtimeFingerprintSchema, 'geopulse-runtime-v2');
    assert.match(first.runtimeFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(first.runtimeFingerprint, second.runtimeFingerprint);
    const forbidden = ['path', 'filename', 'fileName', 'absolutePath', 'relativePath', 'reportsRoot'];
    assert.ok(forbidden.every(key => !Object.hasOwn(first, key)));
  } finally {
    server.closeIdleConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});


test('runtime identity covers added CSS, alternate HTML and public assets while legacy evidence remains reproducible', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'geopulse-runtime-'));
  try {
    await mkdir(path.join(root,'public/js'),{recursive:true});
    const files={'server.mjs':'export const server=1;','package.json':'{"name":"fixture"}','public/index.html':'<main/>','public/styles.css':'main{}','public/enhancements.css':'div{}','public/js/app.js':'export const app=1;'};
    for(const [name,bytes] of Object.entries(files))await writeFile(path.join(root,name),bytes);
    const legacy=await computeSourceFingerprint(root),initial=await computeRuntimeFingerprint(root);
    for(const [name,bytes] of [['public/workspace.css','aside{width:264px}'],['public/optimization.html','<h1>Experiment</h1>'],['public/icon.svg','<svg/>']]){
      const before=await computeRuntimeFingerprint(root);await writeFile(path.join(root,name),bytes);
      assert.notEqual(await computeRuntimeFingerprint(root),before);
      assert.equal(await computeSourceFingerprint(root),legacy);
    }
    const withAssets=await computeRuntimeFingerprint(root);
    assert.notEqual(initial,withAssets);
    await mkdir(path.join(root,'reports'));
    await writeFile(path.join(root,'reports/raw.json'),'{}');
    await writeFile(path.join(root,'.env'),'LOCAL_TEST_ONLY=1');
    assert.equal(await computeRuntimeFingerprint(root),withAssets);
    await writeFile(path.join(root,'package.json'),'{"name":"changed"}');
    assert.notEqual(await computeRuntimeFingerprint(root),withAssets);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('environment runtime digest follows served public bytes changed after server startup', async () => {
  const publicRoot=await mkdtemp(path.join(os.tmpdir(),'geopulse-served-runtime-'));
  const server=createServer({publicRoot});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    await writeFile(path.join(publicRoot,'workspace.css'),'main{color:red}');
    const url='http://127.0.0.1:'+server.address().port+'/api/environment';
    const first=await(await fetch(url)).json();
    await writeFile(path.join(publicRoot,'workspace.css'),'main{color:blue}');
    const second=await(await fetch(url)).json();
    assert.match(first.runtimeFingerprint,/^[a-f0-9]{64}$/);
    assert.notEqual(first.runtimeFingerprint,second.runtimeFingerprint);
    assert.equal(first.sourceFingerprint,second.sourceFingerprint);
  } finally {
    server.closeIdleConnections?.();await new Promise(r=>server.close(r));
    await rm(publicRoot,{recursive:true,force:true});
  }
});
