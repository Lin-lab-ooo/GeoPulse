import test from 'node:test';
import assert from 'node:assert/strict';
import { SpatialQueryClient } from '../public/js/spatial-query-client.js';
import { createSpatialQueryHandler } from '../public/js/spatial-query-worker.js';
import { createRecordingRenderer } from './helpers/recording-renderer.mjs';

/**
 * In-process worker: the same handler the real Worker uses, wired to the client
 * through a synchronous message queue so the protocol is exercised end to end
 * without a browser. `defer` collects messages instead of delivering at once,
 * which lets tests observe the "result not ready yet" path.
 */
function makeChannel({ defer = false, holdWorker = false } = {}) {
  const toWorker = [];
  const messages = [];
  const toClient = [];
  const worker = { onmessage: null, onerror: null, terminated: false };
  let handler = null;
  let deferring = defer;
  const flush = () => {
    while (toClient.length && worker.onmessage) worker.onmessage({ data: toClient.shift() });
  };
  const processWorker = () => { while (toWorker.length) handler.onmessage({ data: toWorker.shift() }); };
  const post = message => {
    toClient.push(message);
    if (!deferring) flush();
  };
  handler = createSpatialQueryHandler(post);
  worker.postMessage = (message, transfer = []) => {
    void transfer;
    messages.push(message); toWorker.push(message);
    if (!holdWorker) processWorker();
    if (!deferring) flush();
  };
  worker.terminate = () => { worker.terminated = true; };
  return {
    worker,
    handler,
    delivered: ({ reverse = false } = {}) => { if (reverse) toClient.reverse(); deferring = false; flush(); },
    processWorker,
    setWorkerDeferred: value => { holdWorker = value; },
    messages,
    deliverOnly: predicate => {
      for (let i = 0; i < toClient.length;) {
        if (predicate(toClient[i])) worker.onmessage({ data: toClient.splice(i, 1)[0] });
        else i++;
      }
    },
    setDeferred: value => { deferring = value; },
    pending: () => toClient.length
  };
}

function localMatrix({ x = 0, y = 0, scale = 1, heading = 0, width = 800, height = 400 } = {}) {
  const m = new Float64Array(16);
  const c = Math.cos(heading), s = Math.sin(heading);
  const sx = 2 * scale / width, sy = 2 * scale / height;
  m[0] = c * sx; m[4] = -s * sx;
  m[1] = s * sy; m[5] = c * sy;
  m[10] = 1; m[15] = 1;
  m[12] = (-c * x + s * y) * sx;
  m[13] = (-s * x - c * y) * sy;
  return m;
}

/** Points on a grid, so expected candidates are easy to reason about. */
function gridPoints(nx, ny, spacing = 10) {
  const positions = new Float32Array(nx * ny * 2);
  let i = 0;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      positions[i++] = ix * spacing;
      positions[i++] = iy * spacing;
    }
  }
  return positions;
}

test('worker protocol returns candidate starts for a viewport', () => {
  const channel = makeChannel();
  const results = [];
  const client = new SpatialQueryClient({
    createWorker: () => channel.worker,
    onResult: (pageId, result) => results.push({ pageId, result })
  });
  const positions = gridPoints(10, 10, 10); // 0..90 in both axes, 100 points
  client.register('p0', { primitiveSize: 1, options: { leafSize: 8 } });
  client.append('p0', positions, 0, 100);

  const matrix = localMatrix({ width: 100, height: 100 }); // world ±50 visible
  const seq = client.query('p0', { matrix, marginX: 1, marginY: 1, candidateBudget: 1000 });
  channel.delivered();
  assert.equal(results.length, 1);
  const result = results[0].result;
  assert.equal(result.seq, seq);
  assert.equal(result.dense, false);
  assert.ok(result.starts instanceof Uint16Array);
  // Candidates are conservative: every visible point must be present, and every
  // listed start must be a real primitive start.
  const listed = new Set(result.starts);
  let visible = 0;
  for (let i = 0; i < 100; i++) {
    const x = positions[i * 2], y = positions[i * 2 + 1];
    const nx = matrix[0] * x + matrix[4] * y + matrix[12];
    const ny = matrix[1] * x + matrix[5] * y + matrix[13];
    if (Math.abs(nx) <= 1 && Math.abs(ny) <= 1) {
      visible++;
      assert.ok(listed.has(i), `visible point ${i} at ${x},${y} missing from the candidate list`);
    }
  }
  assert.ok(visible > 0, 'the viewport must contain points');
  for (const start of result.starts) assert.ok(Number.isInteger(start) && start >= 0 && start < 100);
  assert.ok(client.latest('p0').starts.length > 0);
});

test('worker keeps the index off the main thread and reports its own timing', () => {
  const channel = makeChannel();
  const client = new SpatialQueryClient({ createWorker: () => channel.worker });
  client.register('p0', { primitiveSize: 1 });
  client.append('p0', gridPoints(40, 40, 5), 0, 1600);
  client.query('p0', { matrix: localMatrix(), marginX: 1, marginY: 1, candidateBudget: 100000 });
  channel.delivered();
  const result = client.latest('p0');
  assert.ok(result.stats.index.primitives === 1600, 'the worker owns the full index');
  assert.ok(Number.isFinite(result.stats.queryMs));
  assert.ok(result.stats.classifier.cornerTests > 0, 'the classifier ran inside the worker');
});

test('appends must continue at indexedUntil and stay ordered', () => {
  const channel = makeChannel();
  const client = new SpatialQueryClient({ createWorker: () => channel.worker });
  const positions = gridPoints(10, 10, 10);
  client.register('p0', { primitiveSize: 1 });
  client.append('p0', positions, 0, 40);
  assert.throws(() => client.append('p0', positions, 60, 80), /indexedUntil/);
  client.append('p0', positions, 40, 100);
  assert.equal(client.pages.get('p0').indexedUntil, 100);
  const errors = [];
  channel.handler.onmessage({ data: { type: 'append', pageId: 'p0', generation: client.pages.get('p0').generation,
    dataVersion: 0, positions: new Float32Array(4), start: 0, end: 2 } });
  void errors;
  assert.equal(client.stats.errors, 1, 'the worker reports protocol errors instead of throwing');});

test('dense viewports are reported without enumerating candidates', () => {
  const channel = makeChannel();
  const client = new SpatialQueryClient({ createWorker: () => channel.worker });
  client.register('p0', { primitiveSize: 1 });
  client.append('p0', gridPoints(20, 20, 5), 0, 400); // fills ±50
  client.query('p0', { matrix: localMatrix({ width: 100, height: 100 }), marginX: 1, marginY: 1, candidateBudget: 10 });
  channel.delivered();
  const result = client.latest('p0');
  assert.equal(result.dense, true);
  assert.equal(result.starts, null);
});

test('a stale response never displaces a newer query', () => {
  const channel = makeChannel({ defer: true });
  const client = new SpatialQueryClient({ createWorker: () => channel.worker });
  client.register('p0', { primitiveSize: 1 });
  client.append('p0', gridPoints(10, 10, 10), 0, 100);
  const first = client.query('p0', { matrix: localMatrix({ width: 100, height: 100 }), marginX: 1, marginY: 1, candidateBudget: 1000 });
  const second = client.query('p0', { matrix: localMatrix({ x: 20, width: 100, height: 100 }), marginX: 1, marginY: 1, candidateBudget: 1000 });
  channel.delivered();
  assert.equal(client.stats.responses, 2);
  assert.equal(client.stats.staleResponses, 1, 'the first response is superseded');
  assert.equal(client.latest('p0').seq, second);
  assert.ok(second > first);
});

test('a retained receipt is flagged stale while a newer query is still in flight', () => {
  const channel = makeChannel();
  const client = new SpatialQueryClient({ createWorker: () => channel.worker });
  client.register('p0', { primitiveSize: 1 });
  client.append('p0', gridPoints(10, 10, 10), 0, 100);
  client.query('p0', { matrix: localMatrix({ width: 100, height: 100 }), marginX: 1, marginY: 1, candidateBudget: 1000 });
  const settled = client.latest('p0');
  assert.equal(settled.stale, false);
  channel.setDeferred(true);
  client.query('p0', { matrix: localMatrix({ width: 100, height: 100 }), marginX: 1, marginY: 1, candidateBudget: 1000 });
  const stillUsable = client.latest('p0');
  assert.equal(stillUsable.seq, settled.seq, 'the previous result stays available');
  assert.equal(stillUsable.stale, true, 'but is flagged as stale');
  channel.setDeferred(false);
  channel.delivered();
  assert.equal(client.latest('p0').stale, false);
});

test('unregistering a page drops its results and stops the worker', () => {
  const channel = makeChannel();
  const client = new SpatialQueryClient({ createWorker: () => channel.worker });
  client.register('p0', { primitiveSize: 1 });
  client.append('p0', gridPoints(4, 4, 10), 0, 16);
  client.query('p0', { matrix: localMatrix(), marginX: 1, marginY: 1, candidateBudget: 1000 });
  channel.delivered();
  assert.ok(client.latest('p0'));
  client.clear('p0');
  assert.equal(client.latest('p0'), null);
  client.dispose();
  assert.equal(channel.worker.terminated, true);
});

test('a failing worker degrades instead of throwing', () => {
  const worker = { onmessage: null, onerror: null, postMessage: () => {}, terminate: () => {} };
  const errors = [];
  const client = new SpatialQueryClient({ createWorker: () => worker, onError: error => errors.push(error) });
  client.register('p0', { primitiveSize: 1 });
  // The worker reports a protocol error (unregistered page).
  client.query('p1', { matrix: localMatrix(), marginX: 1, marginY: 1, candidateBudget: 10 });
  assert.equal(client.latest('p1'), null);
  worker.onerror(new Error('worker crashed'));
  assert.equal(errors.length, 1);
  assert.equal(client.stats.errors, 1);
});

test('sent geometry and actually indexed geometry use separate cursors', () => {
  const channel = makeChannel({ defer: true, holdWorker: true });
  const client = new SpatialQueryClient({ createWorker: () => channel.worker });
  client.register('p', { primitiveSize: 1 });
  const xy = gridPoints(10, 10);
  client.append('p', xy, 0, 40, { dataVersion: 1 });
  client.append('p', xy, 40, 100, { dataVersion: 2 });
  const entry = client.pages.get('p');
  assert.equal(entry.sentUntil, 100);
  assert.equal(entry.indexedUntil, 0, 'sending a slice is not a Worker ACK');
  client.query('p', { matrix: localMatrix(), marginX: 1, marginY: 1, candidateBudget: 1000 });
  assert.equal(client.latest('p'), null);
  channel.processWorker(); channel.delivered({ reverse: true });
  assert.equal(entry.indexedUntil, 100, 'a late prefix ACK cannot regress the cursor');
  assert.equal(client.latest('p').indexedUntil, 100);
  assert.equal(client.latest('p').dataVersion, 2);
});

test('results are bound to the queried matrix, margins and primitive budget', () => {
  const channel = makeChannel(), client = new SpatialQueryClient({ createWorker: () => channel.worker });
  client.register('p', { primitiveSize: 1 }); client.append('p', gridPoints(10, 10), 0, 100);
  const query = { matrix: localMatrix(), marginX: 1, marginY: 1, candidateBudget: 1000 };
  client.query('p', query);
  assert.ok(client.latest('p', query));
  assert.equal(client.latest('p', { ...query, matrix: localMatrix({ x: 1000 }) }), null);
  assert.equal(client.latest('p', { ...query, marginX: 1.2 }), null);
  assert.equal(client.latest('p', { ...query, candidateBudget: 5 }), null);
});

test('identical in-flight queries are deduplicated rather than starving their results', () => {
  const channel = makeChannel({ defer: true }), client = new SpatialQueryClient({ createWorker: () => channel.worker });
  client.register('p', { primitiveSize: 1 }); client.append('p', gridPoints(4, 4), 0, 16);
  const query = { matrix: localMatrix(), marginX: 1, marginY: 1, candidateBudget: 1000 };
  const seq = client.query('p', query);
  for (let i = 0; i < 20; i++) assert.equal(client.query('p', query), seq);
  assert.equal(client.stats.issuedRequests, 1);
  channel.delivered(); assert.equal(client.latest('p', query).seq, seq);
});

test('out-of-order results cannot overwrite the newest query', () => {
  const channel = makeChannel({ defer: true }), client = new SpatialQueryClient({ createWorker: () => channel.worker });
  client.register('p', { primitiveSize: 1 }); client.append('p', gridPoints(10, 10), 0, 100);
  const q = { matrix: localMatrix(), marginX: 1, marginY: 1, candidateBudget: 1000 };
  client.query('p', q);
  const newer = { ...q, matrix: localMatrix({ x: 50 }) }, seq = client.query('p', newer);
  channel.delivered({ reverse: true });
  assert.equal(client.latest('p', newer).seq, seq);
  assert.equal(client.stats.staleResponses, 1);
});

test('clear and re-register reject late ACKs and results from the old generation', () => {
  const channel = makeChannel({ defer: true }), client = new SpatialQueryClient({ createWorker: () => channel.worker });
  const q = { matrix: localMatrix(), marginX: 1, marginY: 1, candidateBudget: 1000 };
  client.register('p', { primitiveSize: 1 }); client.append('p', gridPoints(10, 10), 0, 100); client.query('p', q);
  const oldGeneration = client.pages.get('p').generation;
  client.clear('p'); client.register('p', { primitiveSize: 1 });
  client.append('p', gridPoints(2, 2), 0, 4); const seq = client.query('p', q);
  channel.handler.onmessage({ data: { type: 'clear', pageId: 'p', generation: oldGeneration } });
  channel.delivered({ reverse: true });
  assert.equal(client.pages.get('p').indexedUntil, 4);
  assert.equal(client.latest('p', q).seq, seq);
  assert.equal(client.latest('p', q).count, 4);
  assert.equal(client.stats.errors, 0);
});

test('appending a tail invalidates the previous query until the actual tail is indexed', () => {
  const channel = makeChannel(), client = new SpatialQueryClient({ createWorker: () => channel.worker });
  const q = { matrix: localMatrix(), marginX: 1, marginY: 1, candidateBudget: 1000 };
  const xy = gridPoints(2, 2);
  client.register('p', { primitiveSize: 1 }); client.append('p', xy, 0, 2, { dataVersion: 1 }); client.query('p', q);
  assert.equal(client.latest('p').count, 2);
  channel.setWorkerDeferred(true);
  client.append('p', xy, 2, 4, { dataVersion: 2 }); client.query('p', q);
  assert.equal(client.pages.get('p').sentUntil, 4);
  assert.equal(client.pages.get('p').indexedUntil, 2);
  assert.equal(client.latest('p', q), null);
  channel.processWorker(); assert.equal(client.latest('p', q).count, 4);
});

for (const primitiveSize of [2, 3]) test(`density budget counts ${primitiveSize}-vertex primitives without a second multiplication`, () => {
  const channel = makeChannel(), client = new SpatialQueryClient({ createWorker: () => channel.worker });
  const xy = new Float32Array(3 * primitiveSize * 2);
  for (let i = 0; i < xy.length; i += 2) xy[i] = i / 2;
  client.register('p', { primitiveSize }); client.append('p', xy, 0, 3 * primitiveSize);
  const q = { matrix: localMatrix(), marginX: 1, marginY: 1, candidateBudget: 3 };
  client.query('p', q);
  assert.equal(client.latest('p').dense, false, 'exactly three primitives fit the budget');
  assert.deepEqual([...client.latest('p').starts], [0, primitiveSize, primitiveSize * 2]);
  client.query('p', { ...q, candidateBudget: 2 }); assert.equal(client.latest('p').dense, true);
});

const NORMAL = [20, 130, 220, 180];
const clusters = (...points) => points.flatMap(p => Array.from({ length: 8 }, () => p));
const firstCluster = Array.from({ length: 8 }, (_, i) => i);
const secondCluster = Array.from({ length: 8 }, (_, i) => 8 + i);
function group(coords, firstID = 1) {
  const positions = Float32Array.from(coords.flat()), n = coords.length;
  const colors = new Uint8Array(n * 4), ids = new Uint32Array(n);
  for (let i = 0; i < n; i++) { colors.set(NORMAL, i * 4); ids[i] = firstID + i; }
  return { kind: 'points', positions, colors, ids, featureCount: n };
}
function rendererWithWorker() {
  const fixture = createRecordingRenderer(), channel = makeChannel();
  const client = new SpatialQueryClient({ createWorker: () => channel.worker });
  const r = fixture.renderer; r._spatialQueryClient = client;
  r.setAdaptive(false); r.setOptimizationOptions({ spatialPolicy: 'always', spatialBuildExecution: 'synchronous', leafSize: 8, minExtent: 0, maxCandidateRatio: 1 });
  return { fixture, channel, client, r };
}

test('renderer rejects a previous-camera Worker result even if the client returns it', () => {
  const { fixture, client, r } = rendererWithWorker();
  try {
    r.append({ groups: [group(clusters([-500, 0], [500, 0]))] });
    fixture.render({ x: -500, y: 0, scale: 4, heading: 0 });
    const page = r.pages.points[0], old = client.latest(page.workerId);
    assert.deepEqual([...old.starts].sort((a,b)=>a-b), firstCluster);
    client.latest = () => old; // The renderer boundary must verify independently.
    fixture.render({ x: 500, y: 0, scale: 4, heading: 0 });
    assert.deepEqual([...page.indices.subarray(0, page.indexCount)], secondCluster);
    assert.equal(r._spatialQueryApplied.pages, 0, 'old MVP is rejected, exact fallback supplies the new viewport');
  } finally { fixture.dispose(); }
});

test('renderer draws a newly appended visible tail while Worker processing is delayed', () => {
  const { fixture, channel, client, r } = rendererWithWorker();
  try {
    const view = { x: -500, y: 0, scale: 4, heading: 0 };
    r.append({ groups: [group(clusters([-500, 0], [500, 0]))] }); fixture.render(view);
    const page = r.pages.points[0], old = client.latest(page.workerId);
    channel.setWorkerDeferred(true);
    r.append({ groups: [group([[-495, 0]], 17)] });
    client.latest = () => old;
    fixture.render(view);
    assert.deepEqual([...page.indices.subarray(0, page.indexCount)], [...firstCluster, 16]);
    assert.equal(client.pages.get(page.workerId).indexedUntil, 16);
    assert.equal(client.pages.get(page.workerId).sentUntil, 17);
    assert.equal(r._spatialQueryApplied.pages, 0, 'the old result does not cover the append');
  } finally { fixture.dispose(); }
});

test('a small pan never reuses an unqueried slack strip', () => {
  const fixture = createRecordingRenderer(), r = fixture.renderer;
  try {
    r.setAdaptive(false); r.setOptimizationOptions({ spatialQueryWorker: false, spatialPolicy: 'always', spatialBuildExecution: 'synchronous', leafSize: 8, minExtent: 0, maxCandidateRatio: 1 });
    r.append({ groups: [group(clusters([-100, 0], [405, 0], [1000, 0]))] });
    fixture.render({ x: 0, y: 0, scale: 1, heading: 0 });
    const page = r.pages.points[0]; assert.deepEqual([...page.indices.subarray(0, page.indexCount)], firstCluster);
    const pan = fixture.render({ x: 10, y: 0, scale: 1, heading: 0 });
    assert.deepEqual([...page.indices.subarray(0, page.indexCount)], [...firstCluster, ...secondCluster]);
    assert.equal(pan.stats.cacheHits, 0);
  } finally { fixture.dispose(); }
});

test('rotation cannot reuse unqueried corners inside the previous viewport AABB', () => {
  const fixture = createRecordingRenderer(), r = fixture.renderer;
  try {
    r.setAdaptive(false); r.setOptimizationOptions({ spatialQueryWorker: false, spatialPolicy: 'always', spatialBuildExecution: 'synchronous', leafSize: 8, minExtent: 0, maxCandidateRatio: 1 });
    r.append({ groups: [group(clusters([-50, 0], [350, 250], [1000, 0]))] });
    fixture.render({ x: 0, y: 0, scale: 1, heading: Math.PI / 4 });
    const page = r.pages.points[0]; assert.deepEqual([...page.indices.subarray(0, page.indexCount)], firstCluster);
    const changed = fixture.render({ x: 0, y: 0, scale: 1, heading: 0 });
    assert.deepEqual([...page.indices.subarray(0, page.indexCount)], [...firstCluster, ...secondCluster]);
    assert.equal(changed.stats.cacheHits, 0);
  } finally { fixture.dispose(); }
});

test('synchronous selection indexMs is a duration inside the recorded frame', () => {
  const fixture = createRecordingRenderer(), r = fixture.renderer;
  try {
    r.setAdaptive(false); r.setOptimizationOptions({ spatialQueryWorker: false, spatialPolicy: 'always', spatialBuildExecution: 'synchronous', leafSize: 8, minExtent: 0, maxCandidateRatio: 1 });
    r.append({ groups: [group(clusters([-100, 0], [1000, 0]))] });
    const frame = fixture.render({ x: 0, y: 0, scale: 1, heading: 0 });
    assert.ok(frame.stats.indexMs >= 0 && frame.stats.indexMs <= frame.cpuMs + .01,
      `index duration ${frame.stats.indexMs} cannot exceed its enclosing CPU frame ${frame.cpuMs}`);
  } finally { fixture.dispose(); }
});
