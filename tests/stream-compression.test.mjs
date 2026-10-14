import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createServer, parseStreamCompression } from '../server.mjs';
import { generateRecords, createNdjsonDecoder } from '../public/js/data.js';

const hash = b => createHash('sha256').update(b).digest('hex');
let server, origin;
test.before(async () => {
  server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); });
const rawGet = (url, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request(url, { method }, response => {
    const chunks = []; response.on('data', b => chunks.push(b));
    response.on('error', reject); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
  }); req.on('error', reject); req.end();
});
const settle = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.ok(predicate(), 'Stream lifecycle did not settle');
};

test('compression defaults to identity and rejects unsupported values before streaming', async () => {
  assert.equal(parseStreamCompression(new URLSearchParams()), 'identity');
  assert.equal(parseStreamCompression(new URLSearchParams('compression=gzip')), 'gzip');
  for (const value of ['', 'br', 'GZIP', 'gzip,identity', 'undefined']) {
    assert.throws(() => parseStreamCompression(new URLSearchParams({ compression: value })), /identity or gzip/);
    const r = await fetch(origin + '/api/stream?count=1&compression=' + encodeURIComponent(value));
    assert.equal(r.status, 400); assert.equal(r.headers.get('content-encoding'), null);
  }
  assert.equal(server.streamCounters.activeStreams, 0);
});

test('gzip is a complete lossless entity with the same deterministic NDJSON bytes', async () => {
  const q = '/api/stream?count=5000&seed=73&chunk=257&delay=0';
  const expected = Buffer.from([...generateRecords({ count: 5000, seed: 73 })].map(r => JSON.stringify(r) + '\n').join(''));
  const before = { ...server.streamCounters };
  const plain = await rawGet(origin + q);
  const zipped = await rawGet(origin + q + '&compression=gzip');
  assert.equal(plain.status, 200); assert.equal(zipped.status, 200);
  assert.equal(plain.headers['content-encoding'], undefined); assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.equal(zipped.headers['x-stream-compression'], 'gzip');
  assert.equal(zipped.headers['content-length'], undefined, 'No full-payload buffering to determine length');
  assert.equal(hash(plain.body), hash(expected)); assert.equal(hash(gunzipSync(zipped.body)), hash(expected));
  assert.ok(zipped.body.length < plain.body.length);
  assert.throws(() => gunzipSync(zipped.body.subarray(0, -8)), /unexpected end|buffer error/i);
  await settle(() => server.streamCounters.activeStreams === 0);
  assert.equal(server.streamCounters.compressedStreams - before.compressedStreams, 1);
  assert.equal(server.streamCounters.completedStreams - before.completedStreams, 2);
  assert.equal(server.streamCounters.streamedBytes - before.streamedBytes, expected.length * 2);
  assert.equal(server.streamCounters.encodedEntityBytes - before.encodedEntityBytes, plain.body.length + zipped.body.length);
});

test('browser-compatible fetch decoding supplies early NDJSON before gzip EOF', async () => {
  const response = await fetch(origin + '/api/stream?count=600&seed=7&chunk=100&delay=30&compression=gzip');
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  const reader = response.body.getReader(), decoder = createNdjsonDecoder();
  const first = await reader.read();
  const records = decoder.push(first.value);
  assert.ok(records.length > 0 && records.length < 600);
  assert.ok(server.streamCounters.activeStreams > 0, 'First decoded records precede completed response');
  while (true) { const next = await reader.read(); if (next.done) break; records.push(...decoder.push(next.value)); }
  records.push(...decoder.finish());
  assert.deepEqual(records, [...generateRecords({ count: 600, seed: 7 })]);
  await settle(() => server.streamCounters.activeStreams === 0);
});

test('compressed HEAD publishes encoding without producing records or changing counters', async () => {
  const before = { ...server.streamCounters };
  const r = await rawGet(origin + '/api/stream?count=1000000&compression=gzip', 'HEAD');
  assert.equal(r.status, 200); assert.equal(r.headers['content-encoding'], 'gzip'); assert.equal(r.body.length, 0);
  assert.deepEqual(server.streamCounters, before);
});

test('cancelling a compressed response stops generation and permits a clean subsequent stream', async () => {
  const before = { ...server.streamCounters };
  const controller = new AbortController();
  const response = await fetch(origin + '/api/stream?count=100000&seed=19&chunk=128&delay=20&compression=gzip', { signal: controller.signal });
  const reader = response.body.getReader(); assert.ok((await reader.read()).value.length > 0);
  controller.abort(); await reader.cancel().catch(() => {});
  await settle(() => server.streamCounters.activeStreams === 0);
  assert.equal(server.streamCounters.cancelledStreams - before.cancelledStreams, 1);
  assert.ok(server.streamCounters.streamedFeatures - before.streamedFeatures < 100000);
  const next = await rawGet(origin + '/api/stream?count=10&seed=41&chunk=10&delay=0&compression=gzip');
  assert.equal(gunzipSync(next.body).toString().trim().split('\n').length, 10);
  await settle(() => server.streamCounters.activeStreams === 0);
});

test('slow compressed consumers cannot cause unbounded producer read-ahead', async () => {
  const before = server.streamCounters.streamedFeatures;
  await new Promise((resolve, reject) => {
    const req = http.get(origin + '/api/stream?count=1000000&seed=7&chunk=8192&delay=0&compression=gzip', response => {
      response.on('error', () => {}); response.pause();
      setTimeout(() => {
        try { assert.ok(server.streamCounters.streamedFeatures - before < 1000000, 'Backpressure must stop full-input production'); }
        catch (e) { response.destroy(); return reject(e); }
        response.destroy(); resolve();
      }, 40);
    }); req.on('error', reject);
  });
  await settle(() => server.streamCounters.activeStreams === 0);
});
