import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Worker } from 'node:worker_threads';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from '../server.mjs';
import { generateRecords, createDetector, createNdjsonParser, createNdjsonDecoder, parseNdjson, packBatch, transferablesForBatch, validateRecord } from '../public/js/data.js';

const collect = options => [...generateRecords(options)];

test('seeded spatial records repeat exactly with the documented 88/10/2 mixture', () => {
  const first = collect({ count: 10000, seed: 20261009 });
  assert.deepEqual(first, collect({ count: 10000, seed: 20261009 }));
  assert.notDeepEqual(first.slice(0, 10), collect({ count: 10, seed: 9 }));
  const counts = Object.fromEntries(['point', 'line', 'polygon'].map(kind => [kind, first.filter(r => r.kind === kind).length]));
  assert.deepEqual(counts, { point: 8800, line: 1000, polygon: 200 });
  assert.equal(new Set(first.map(r => r.region)).size, 8);
  assert.equal(new Set(first.map(r => r.id)).size, first.length);
  assert.ok(first.every(r => Math.abs(r.x) <= 6000 && Math.abs(r.y) <= 6000 && (!r.coords || r.coords.every(c => c.every(v => Math.abs(v) <= 6000)))));
  assert.throws(() => collect({ count: 1000001 }), /count/);
  assert.throws(() => collect({ count: 1, seed: -1 }), /seed/);
});

test('packing creates correct independent point/line/rectangle draw arrays and transferable buffers', () => {
  const common = { value: 50, region: 'R01', status: 'online', groundTruth: 'normal' };
  const records = [
    { ...common, id: 1, kind: 'point', x: 1, y: 2 },
    { ...common, id: 2, kind: 'line', x: 2, y: 3, coords: [[0, 0], [2, 3], [4, 2]] },
    { ...common, id: 3, kind: 'polygon', x: 5, y: 6, coords: [[0, 0], [10, 0], [10, 12], [0, 12], [0, 0]] },
  ];
  const batch = packBatch(records);
  assert.equal(batch.featureCount, 3);
  assert.deepEqual(batch.groups.map(g => g.positions.length / 2), [1, 4, 6]);
  assert.deepEqual([...batch.groups[1].positions], [0, 0, 2, 3, 2, 3, 4, 2]);
  assert.deepEqual([...batch.groups[2].positions], [0, 0, 10, 0, 10, 12, 0, 0, 10, 12, 0, 12]);
  for (const group of batch.groups) {
    assert.ok(group.positions instanceof Float32Array);
    assert.ok(group.colors instanceof Uint8Array);
    assert.ok(group.ids instanceof Uint32Array);
    assert.equal(group.colors.length, group.ids.length * 4);
    assert.equal(group.positions.length, group.ids.length * 2);
    assert.ok([...group.ids].every(id => id === records.find(r => r.kind === group.kind).id));
  }
  const buffers = transferablesForBatch(batch);
  assert.equal(buffers.length, 9);
  const clone = structuredClone(batch, { transfer: buffers });
  assert.equal(clone.groups[2].positions.length, 12);
  assert.equal(batch.groups[0].positions.byteLength, 0);
  assert.throws(() => packBatch([{ ...common, id: 1, kind: 'point', x: NaN, y: 2 }]), /finite/);
  assert.throws(() => packBatch([{ ...common, id: 1, kind: 'polygon', x: 0, y: 0, coords: [[0, 0], [1, 2], [3, 4], [0, 0]] }]), /rectangular/);
});

test('online detector learns per-region baselines and ignores simulated ground truth', () => {
  const detector = createDetector();
  for (let i = 0; i < 80; i += 1) {
    assert.equal(detector.observe({ region: 'low', value: 20 + (i % 5 - 2) }).status, 'normal');
    assert.equal(detector.observe({ region: 'high', value: 80 + (i % 5 - 2) }).status, 'normal');
  }
  assert.equal(detector.observe({ region: 'high', value: 81 }).status, 'normal');
  assert.equal(detector.observe({ region: 'low', value: 43 }).status, 'critical');
  assert.equal(detector.observe({ region: 'high', value: 104 }).status, 'critical');
  assert.equal(detector.snapshot().warmedRegions, 2);
  const records = collect({ count: 10000, seed: 20261009 });
  const expected = packBatch(records);
  const relabelled = packBatch(records.map(r => ({ ...r, groundTruth: r.groundTruth === 'normal' ? 'critical' : 'normal' })));
  assert.deepEqual(expected.anomalies, relabelled.anomalies);
  assert.deepEqual(expected.groups.map(g => [...g.colors]), relabelled.groups.map(g => [...g.colors]));
  assert.ok(expected.summary.precision > 0.85);
  assert.ok(expected.summary.recall > 0.85);
  assert.ok(expected.anomalies.length <= 100);
});

test('incremental UTF-8 decoder handles every byte boundary, CRLF, and final unterminated line', () => {
  const records = [{ id: 1, note: '上海园区🌊' }, { id: 2, note: '设备异常' }, { id: 3, value: 13 }];
  const bytes = new TextEncoder().encode(records.map(r => JSON.stringify(r)).join('\r\n'));
  const decoder = createNdjsonDecoder();
  const parsed = [];
  for (const byte of bytes) parsed.push(...decoder.push(Uint8Array.of(byte)));
  parsed.push(...decoder.finish());
  assert.deepEqual(parsed, records);
  assert.deepEqual(parseNdjson('\n' + records.map(r => JSON.stringify(r)).join('\n') + '\n'), records);
  const malformed = createNdjsonDecoder();
  assert.throws(() => malformed.push(new TextEncoder().encode('{"ok":1}\nnot-json\n')), /line 2/);
  const invalidUtf8 = createNdjsonDecoder();
  assert.throws(() => invalidUtf8.push(Uint8Array.of(0xFF)), /encoded data/);
  const oversized = createNdjsonDecoder({ maxLineLength: 10 });
  assert.throws(() => oversized.push(new TextEncoder().encode('12345678901')), /size limit/);
});

test('NDJSON scanner preserves tail-only chunks, blank-line numbering, and limits across chunk boundaries', () => {
  const parser = createNdjsonParser({ maxLineLength: 32 });
  assert.deepEqual(parser.push('{"id"'), []);
  assert.deepEqual(parser.push(':1}\r\n\u00a0\n{"id":2}\n{"i'), [{ id: 1 }, { id: 2 }]);
  assert.equal(parser.lineNumber, 3);
  assert.deepEqual(parser.push('d":3}'), []);
  assert.deepEqual(parser.finish(), [{ id: 3 }]);
  assert.equal(parser.lineNumber, 4);
  assert.deepEqual(parser.finish(), []);
  const joinedOversize = createNdjsonParser({ maxLineLength: 10 });
  joinedOversize.push('{"data":');
  assert.throws(() => joinedOversize.push('1234}\n'), /line 1 exceeds/);
  const malformed = createNdjsonParser();
  malformed.push('\n{"data":');
  assert.throws(() => malformed.push('oops}\n'), /Invalid NDJSON at line 2/);
});

test('direct typed packing preserves rectangular variants, long polylines, uint32 ids and detector order', () => {
  const common = { x: 0, y: 0, value: 50, region: 'test', groundTruth: 'normal' };
  const line = [[-1.25, 0], [0, 1.5], [2, 3], [5, 7], [9, 12]];
  const rectangle = [[-2, -3], [2, -3], [2, 3], [-2, 3]];
  const records = [
    { ...common, id: 4294967295, kind: 'line', coords: line },
    { ...common, id: 2, kind: 'polygon', coords: rectangle },
    { ...common, id: 3, kind: 'point', x: 1.25, y: -0 },
    { ...common, id: 4, kind: 'polygon', coords: [...rectangle, rectangle[0]] },
  ];
  const observed = [];
  const detector = { observe(record) { observed.push(record.id); return { score: 6, status: record.id === 2 ? 'critical' : record.id === 4 ? 'warning' : 'normal' }; } };
  const batch = packBatch(records, { detector, maxAnomalies: 1 });
  assert.deepEqual(observed, records.map(record => record.id));
  assert.deepEqual(batch.groups.map(group => [group.kind, group.featureCount, group.ids.length]), [['point', 1, 1], ['line', 1, 8], ['polygon', 2, 12]]);
  assert.deepEqual([...batch.groups[1].positions], line.slice(1).flatMap((point, i) => [...line[i], ...point]));
  assert.ok([...batch.groups[1].ids].every(id => id === 4294967295));
  assert.deepEqual([...batch.groups[2].colors.slice(0, 4)], [255, 72, 80, 245]);
  assert.deepEqual([...batch.groups[2].colors.slice(24, 28)], [255, 190, 66, 238]);
  assert.equal(Object.is(batch.groups[0].positions[1], -0), true);
  assert.equal(batch.anomalies.length, 1);
  assert.deepEqual([batch.summary.normal, batch.summary.warning, batch.summary.critical, batch.summary.total], [2, 1, 1, 4]);
  assert.equal(batch.summary.falsePositive, 2);
  assert.deepEqual(packBatch([]).groups, []);
  const broken = [...records.slice(0, 2), { ...records[2], x: Infinity }];
  observed.length = 0;
  assert.throws(() => packBatch(broken, { detector }), /Invalid record 3: x, y and value must be finite numbers/);
  assert.deepEqual(observed, [4294967295, 2], 'valid prefix observations retain input-order failure semantics');
  for (const value of [NaN, Infinity, '1']) assert.throws(() => validateRecord({ ...records[0], coords: [[0, 0], [value, 1]] }), /invalid coords/);
});

let server;
let origin;
test.before(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.closeIdleConnections?.();
  await new Promise(resolve => server.close(resolve));
});

test('HTTP stream delivers an early chunk and all deterministic NDJSON records', async () => {
  const response = await fetch(`${origin}/api/stream?count=300&seed=77&chunk=100&delay=40`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /ndjson/);
  const reader = response.body.getReader();
  const decoder = createNdjsonDecoder();
  const first = await reader.read();
  assert.equal(first.done, false);
  const records = decoder.push(first.value);
  assert.ok(records.length > 0 && records.length < 300, 'first response chunk must precede full stream completion');
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    records.push(...decoder.push(part.value));
  }
  records.push(...decoder.finish());
  assert.deepEqual(records, collect({ count: 300, seed: 77 }));
});

test('HTTP parameter errors, static MIME, path traversal, and process metrics are explicit', async () => {
  for (const query of ['count=0', 'count=1000001', 'count=2.5', 'seed=-1', 'seed=4294967296', 'chunk=0', 'chunk=8193', 'delay=1001']) {
    const response = await fetch(`${origin}/api/stream?${query}`);
    assert.equal(response.status, 400, query);
    assert.match((await response.json()).error, /integer/);
  }
  const script = await fetch(`${origin}/js/data.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  const health = await (await fetch(`${origin}/api/health`)).json();
  assert.equal(health.ok, true);
  const environment = await (await fetch(`${origin}/api/environment`)).json();
  assert.ok(environment.logicalCores >= 1 && environment.memoryTotalBytes > 0);
  assert.match(environment.node, /^v\d/);
  const metrics = await (await fetch(`${origin}/api/metrics`)).json();
  assert.equal(metrics.scope, 'node-server-process');
  assert.ok(metrics.memoryBytes.rss > 0);
  const traversalStatus = await new Promise((resolve, reject) => {
    const request = http.get(`${origin}/%2e%2e%2fpackage.json`, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(traversalStatus, 403);
});

test('HTTP cancellation releases the active stream and pending delay', async () => {
  const before = server.streamCounters.cancelledStreams;
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/stream?count=100000&chunk=100&delay=1000`, { signal: controller.signal });
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.ok(first.value.byteLength > 0);
  controller.abort();
  await reader.cancel().catch(() => {});
  const deadline = Date.now() + 1500;
  while (server.streamCounters.activeStreams !== 0 && Date.now() < deadline) await sleep(10);
  assert.equal(server.streamCounters.activeStreams, 0);
  assert.equal(server.streamCounters.cancelledStreams, before + 1);
  assert.ok(server.streamCounters.streamedFeatures < 100300, 'cancelled stream must stop generating records');
});


function waitForWorkerMessage(worker, predicate, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for Worker message')); }, timeout);
    const message = value => { if (predicate(value)) { cleanup(); resolve(value); } };
    const failure = error => { cleanup(); reject(error); };
    const cleanup = () => { clearTimeout(timer); worker.off('message', message); worker.off('error', failure); };
    worker.on('message', message);
    worker.on('error', failure);
  });
}

test('Worker transfers one batch, waits for ACK, adapts size, and reports complete totals', async () => {
  const moduleUrl = new URL('../public/js/stream-worker.js', import.meta.url).href;
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    global.self = {
      postMessage: (message, transfer) => parentPort.postMessage(message, transfer),
      addEventListener: (type, handler) => parentPort.on('message', data => handler({ data }))
    };
    import(${JSON.stringify(moduleUrl)}).then(() => parentPort.postMessage({ type: 'ready' }));
  `, { eval: true });
  try {
    await waitForWorkerMessage(worker, m => m.type === 'ready');
    const messages = [];
    worker.on('message', message => messages.push(message));
    const firstPromise = waitForWorkerMessage(worker, m => m.type === 'batch');
    worker.postMessage({ type: 'start', runId: 'ack-test', url: `${origin}/api/stream?count=1000&chunk=100&delay=0`, batchSize: 256, mode: 'adaptive' });
    const first = await firstPromise;
    assert.equal(first.batch.featureCount, 256);
    assert.ok(first.batch.groups[0].positions instanceof Float32Array);
    assert.ok(first.batch.groups[0].positions.byteLength > 0);
    await sleep(80);
    assert.equal(messages.filter(m => m.type === 'batch').length, 1, 'Worker must not send a second unacknowledged batch');
    const secondPromise = waitForWorkerMessage(worker, m => m.type === 'batch');
    worker.postMessage({ type: 'ack', runId: 'ack-test', batchSize: 512 });
    const second = await secondPromise;
    assert.equal(second.batch.featureCount, 512);
    const thirdPromise = waitForWorkerMessage(worker, m => m.type === 'batch');
    worker.postMessage({ type: 'ack', runId: 'ack-test' });
    const third = await thirdPromise;
    assert.equal(third.batch.featureCount, 232);
    const donePromise = waitForWorkerMessage(worker, m => m.type === 'done');
    worker.postMessage({ type: 'ack', runId: 'ack-test' });
    const done = await donePromise;
    assert.equal(done.summary.total, 1000);
    assert.equal(done.metrics.delivered, 1000);
    assert.equal(done.metrics.parsed, 1000);
    assert.equal(done.metrics.batches, 3);
    assert.equal(done.metrics.maxPendingBatches, 1);
    assert.ok(done.metrics.bytes > 0 && done.metrics.parseMs > 0 && done.metrics.packMs > 0);
  } finally {
    await worker.terminate();
  }
});
