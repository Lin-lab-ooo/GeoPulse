import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer, REPORT_MAX_BYTES } from '../server.mjs';

const fixture = () => ({
  project: 'GeoPulse', schemaVersion: '1.0', generatedAt: '2026-10-09T10:00:00.000Z',
  note: '上海园区实验', metadata: {},
  runs: [{ id: 'tiny-fixture', config: { count: 1000, seed: 20261009, mode: 'adaptive' }, metrics: { features: 1000, fpsMean: 59.5, firstVisibleMs: 32.125 } }],
});
let server;
let origin;
let temporaryRoot;
let reportsRoot;

async function files() {
  try { return await readdir(reportsRoot); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function post(body, headers = {}) {
  return fetch(`${origin}/api/reports`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) });
}
function rawPost(body, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${origin}/api/reports`, { method: 'POST', headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

test.before(async () => {
  temporaryRoot = await mkdtemp(path.join(tmpdir(), 'geopulse-report-test-'));
  reportsRoot = path.resolve(temporaryRoot, 'nested', 'reports');
  server = createServer({ reportsRoot });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.closeIdleConnections?.();
  await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(temporaryRoot);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
  assert.ok(path.basename(resolved).startsWith('geopulse-report-test-'));
  await rm(resolved, { recursive: true, force: true });
});

test('report saves preserve original JSON, use unique server filenames, and stay in the fixed root', async () => {
  const first = fixture();
  const second = fixture();
  second.runs[0].id = 'zero-feature-cli';
  second.runs[0].metrics.features = 0;
  const firstText = JSON.stringify(first, null, 2);
  const secondText = JSON.stringify(second);
  const responses = await Promise.all([post(firstText, { Origin: origin }), post(secondText)]);
  const saved = [];
  for (const [index, response] of responses.entries()) {
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.match(result.fileName, /^verified-browser-\d+-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/);
    assert.equal(result.relativePath, `reports/${result.fileName}`);
    assert.equal(path.dirname(result.absolutePath), reportsRoot);
    assert.equal(path.basename(result.absolutePath), result.fileName);
    const expectedText = index ? secondText : firstText;
    const actual = await readFile(result.absolutePath, 'utf8');
    assert.equal(actual, expectedText, 'saved file should preserve the original validated JSON bytes');
    assert.deepEqual(JSON.parse(actual), index ? second : first);
    assert.equal(result.bytes, Buffer.byteLength(expectedText));
    saved.push(result.fileName);
  }
  assert.notEqual(saved[0], saved[1]);
  assert.equal((await files()).length, 2);
  assert.equal((await fetch(`${origin}/api/reports`)).status, 404);
  assert.equal((await fetch(`${origin}/reports/${saved[0]}`)).status, 404);
  assert.equal((await fetch(`${origin}/api/reports`, { method: 'PUT' })).status, 405);
  assert.equal((await fetch(`${origin}/api/health`, { method: 'POST' })).status, 405);
});

test('MIME, JSON, schema, and destination errors never create report files', async () => {
  const before = await files();
  const badReports = [
    null, {}, { ...fixture(), project: 'OtherProject' }, { ...fixture(), schemaVersion: '2.0' },
    { ...fixture(), runs: [] }, { ...fixture(), runs: Array.from({ length: 101 }, () => fixture().runs[0]) },
    { ...fixture(), runs: [{ config: null, metrics: { features: 1 } }] },
    { ...fixture(), runs: [{ config: {}, metrics: [] }] },
    { ...fixture(), runs: [{ config: [], metrics: { features: 1 } }] },
    ...[undefined, null, -1, '1000'].map(features => ({ ...fixture(), runs: [{ config: {}, metrics: { features } }] })),
    { ...fixture(), path: '../outside.json' }, { ...fixture(), filename: 'chosen.json' },
    { ...fixture(), runs: [{ config: { path: path.join(temporaryRoot, 'outside.json') }, metrics: { features: 1 } }] },
    { ...fixture(), metadata: [{ absolutePath: '../outside.json' }] },
  ];
  for (const report of badReports) {
    const response = await post(report);
    assert.equal(response.status, 400, JSON.stringify(report));
    assert.equal(typeof (await response.json()).error, 'string');
  }
  for (const body of ['', '{"project":', JSON.stringify(fixture()).replace('"features":1000', '"features":1e400')]) {
    const response = await post(body);
    assert.equal(response.status, 400);
    await response.json();
  }
  const invalidUtf8 = await post(Uint8Array.of(0x7B, 0x22, 0xFF, 0x22, 0x3A, 0x31, 0x7D));
  assert.equal(invalidUtf8.status, 400);
  for (const mime of ['text/plain', 'application/problem+json']) {
    const response = await post(fixture(), { 'Content-Type': mime });
    assert.equal(response.status, 415);
    await response.json();
  }
  const missingMime = await rawPost(JSON.stringify(fixture()), { 'Content-Length': Buffer.byteLength(JSON.stringify(fixture())) });
  assert.equal(missingMime.status, 415);
  assert.equal(typeof JSON.parse(missingMime.body).error, 'string');
  assert.deepEqual(await files(), before);
});

test('browser Origin must match the exact HTTP host and port', async () => {
  const before = await files();
  for (const foreign of ['https://example.com', origin.replace('http:', 'https:'), 'http://127.0.0.1:1', 'null', 'malformed-origin']) {
    const response = await post(fixture(), { Origin: foreign });
    assert.equal(response.status, 403, foreign);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.deepEqual(await files(), before);
});

test('the 160 MiB raw-experiment limit accepts its boundary and rejects advertised and chunked overflow with complete JSON', async () => {
  assert.equal(REPORT_MAX_BYTES, 160 * 1024 * 1024);
  const report = fixture();
  report.padding = '';
  const empty = JSON.stringify(report);
  report.padding = 'x'.repeat(REPORT_MAX_BYTES - Buffer.byteLength(empty));
  const exactBody = JSON.stringify(report);
  assert.equal(Buffer.byteLength(exactBody), REPORT_MAX_BYTES);
  const accepted = await post(exactBody);
  assert.equal(accepted.status, 201);
  const saved = await accepted.json();
  assert.equal((await stat(saved.absolutePath)).size, REPORT_MAX_BYTES);
  assert.equal((await readFile(saved.absolutePath, 'utf8')), exactBody);
  const before = await files();
  const advertised = await rawPost('{}', { 'Content-Type': 'application/json', 'Content-Length': REPORT_MAX_BYTES + 1 });
  assert.equal(advertised.status, 413);
  assert.match(JSON.parse(advertised.body).error, /160 MiB/);
  const chunked = await rawPost(Buffer.alloc(REPORT_MAX_BYTES + 1, 120), { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
  assert.equal(chunked.status, 413);
  assert.match(JSON.parse(chunked.body).error, /160 MiB/);
  assert.deepEqual(await files(), before);
});

test('100 runs and JSON MIME parameters are accepted without exposing custom destinations', async () => {
  const report = fixture();
  report.runs = Array.from({ length: 100 }, (_, index) => ({ config: { index }, metrics: { features: 0.5 } }));
  const response = await post(report, { 'Content-Type': 'Application/JSON; charset=utf-8', Origin: origin });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.deepEqual(JSON.parse(await readFile(result.absolutePath, 'utf8')), report);
});

test('deep valid metadata can be checked without recursive destination validation', async () => {
  const text = JSON.stringify(fixture()).replace('"metadata":{}', '"metadata":' + '{"child":'.repeat(6000) + '0' + '}'.repeat(6000));
  const response = await post(text);
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(await readFile(result.absolutePath, 'utf8'), text);
});

test('cancelled loading preparation exports attempts without inventing measured runs', async () => {
  const report=fixture();report.runs=[];
  report.loadingProtocols=[{kind:'loading-interaction-comparison',status:'cancelled',attempts:[{status:'cancelled',count:100000,mode:'baseline',error:'Camera preparation cancelled'}]}];
  const response=await post(report);assert.equal(response.status,201);
  const saved=await response.json();const exact=JSON.parse(await readFile(saved.absolutePath,'utf8'));
  assert.deepEqual(exact.runs,[]);assert.equal(exact.loadingProtocols[0].attempts[0].status,'cancelled');
  const bad=structuredClone(report);bad.loadingProtocols[0].status='completed';assert.equal((await post(bad)).status,400);
});
