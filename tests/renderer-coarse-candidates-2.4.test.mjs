import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingRenderer } from './helpers/recording-renderer.mjs';
import { SpatialQueryClient } from '../public/js/spatial-query-client.js';
import { createSpatialQueryHandler } from '../public/js/spatial-query-worker.js';
import { generatePropertyCase, matrix, reference } from '../tools/property-acceleration-2.3.mjs';

// This records production API submissions and protocol decisions. Native WebGL
// pixel equality and elapsed GPU execution belong to the independent browser study.
const VIEW = { x: 0, y: 0, width: 800, height: 800, heading: 0 };
function group(data, { firstID = null } = {}) {
  const size = data.primitiveSize, vertices = data.count * size;
  const colors = new Uint8Array(vertices * 4), ids = new Uint32Array(vertices);
  for (let i = 0; i < data.count; i++) for (let v = 0; v < size; v++) {
    colors.set([70, 150, 230, 180], (i * size + v) * 4);
    ids[i * size + v] = firstID === null ? data.ids[i] : firstID + i;
  }
  return { kind: size === 1 ? 'points' : size === 2 ? 'lines' : 'polygons', positions: data.positions, colors, ids, featureCount: data.count };
}
function configured(coarseCandidates = true) {
  const f = createRecordingRenderer();
  f.renderer.setAdaptive(false);
  f.renderer.setOptimizationOptions({ coarseCandidates, spatialQueryWorker: false, spatialPolicy: 'always', spatialBuildExecution: 'synchronous', maxCandidateRatio: .15 });
  return f;
}
function append(f, data) {
  const source = group(data), size = data.primitiveSize;
  for (let start = 0; start < source.ids.length; start += 2048 * size) {
    const end = Math.min(source.ids.length, start + 2048 * size);
    f.renderer.append({ groups: [{ ...source, positions: source.positions.subarray(start * 2, end * 2),
      colors: source.colors.subarray(start * 4, end * 4), ids: source.ids.subarray(start, end), featureCount: (end - start) / size }] });
  }
}
function render(f, view = VIEW) {
  f.gl.resetMeasurements();
  f.renderer._render(f.gl, matrix(view), { time: 2500, unitsPerPixel: 1, pixelRatio: 1 });
  return { stats: f.renderer.getStats(), submitted: f.gl.draws.reduce((n, d) => n + d.count, 0) };
}
const selected = p => Array.from(p.indices?.subarray(0, p.indexCount) ?? []);
function assertCovered(data, view, page) {
  const actual = selected(page), set = new Set(actual);
  assert.deepEqual(actual, [...actual].sort((a, b) => a - b), 'original alpha order');
  assert.equal(set.size, actual.length, 'no duplicate vertex submissions');
  for (const start of reference(data, matrix(view)).starts) for (let v = 0; v < data.primitiveSize; v++) {
    assert.ok(set.has(start + v), `complete bbox candidate ${start}+${v} is covered`);
  }
}
function channel() {
  const queue = [], messages = [], worker = { onmessage: null, terminate() {} };
  const handler = createSpatialQueryHandler(message => queue.push(message));
  worker.postMessage = message => { messages.push(message); handler.onmessage({ data: message }); };
  return { worker, messages, flush() { while (queue.length) worker.onmessage({ data: queue.shift() }); } };
}
function installReadyWorker(f, page, view = VIEW) {
  const c = channel(), client = new SpatialQueryClient({ createWorker: () => c.worker });
  page.workerId = 'integration-page'; f.renderer._spatialQueryClient = client;
  f.renderer.setOptimizationOptions({ spatialQueryWorker: true });
  client.register(page.workerId, { primitiveSize: 1, dataVersion: page.dataVersion,
    options: { leafSize: 64, minExtent: 8, maxDepth: 16 } });
  client.append(page.workerId, page.positions, 0, page.count, { dataVersion: page.dataVersion }); page.workerMirrored = page.count;
  const query = { matrix: matrix(view), marginX: 1 + f.renderer.pointSize * 2 / f.renderer.width,
    marginY: 1 + f.renderer.pointSize * 2 / f.renderer.height, candidateBudget: page.count * f.renderer.optimization.maxCandidateRatio };
  client.query(page.workerId, query); c.flush();
  return { client, c, result: client.latest(page.workerId, query) };
}

test('cold corridor references reduce actual submission without constructing fine/Worker copies', () => {
  const data = generatePropertyCase('narrow-corridor', 19, 12000, 'far-alternating-arrival');
  let baseline;
  for (const enabled of [false, true]) {
    const f = configured(enabled);
    try {
      append(f, data); const frame = render(f), page = f.renderer.pages.points[0];
      if (!enabled) { baseline = frame.submitted; assert.equal(baseline, 12000); }
      else {
        assert.ok(frame.submitted > 0 && frame.submitted < baseline * .15);
        assert.equal(frame.stats.coarseCandidatePages, 1); assert.equal(page.selection.coarseCandidates, true);
        assert.equal(page.spatial, null); assert.equal(f.renderer._spatialQueryClient, null);
        assertCovered(data, VIEW, page);
      }
    } finally { f.dispose(); }
  }
});

test('retained dense main tree can use coarse references while a selective main tree stays preferred', () => {
  for (const order of ['far-alternating-arrival', 'shuffled-arrival']) {
    const f = configured(true), data = generatePropertyCase('narrow-corridor', 19, 12000, order);
    try {
      append(f, data); f.renderer.setOptimizationOptions({ coarseCandidates: false });
      render(f); const page = f.renderer.pages.points[0], tree = page.spatial;
      assert.ok(tree); const before = selected(page);
      f.renderer.setOptimizationOptions({ coarseCandidates: true }); const frame = render(f);
      assert.equal(page.spatial, tree, 'switch does not rebuild the retained fine tree');
      if (order === 'far-alternating-arrival') {
        assert.equal(page.selection.coarseCandidates, true); assert.equal(frame.stats.coarseCandidatePages, 1); assertCovered(data, VIEW, page);
      } else {
        assert.notEqual(page.selection.coarseCandidates, true); assert.equal(frame.stats.coarseCandidatePages, 0);
        assert.deepEqual(selected(page), before); assertCovered(data, VIEW, page);
      }
    } finally { f.dispose(); }
  }
});

test('matching ready dense Worker falls back to coarse; matching selective Worker remains preferred', () => {
  for (const order of ['far-alternating-arrival', 'shuffled-arrival']) {
    const f = configured(), data = generatePropertyCase('narrow-corridor', 19, 12000, order);
    try {
      append(f, data); const page = f.renderer.pages.points[0];
      const { result } = installReadyWorker(f, page); assert.ok(result && !result.stale);
      render(f); assertCovered(data, VIEW, page);
      if (order === 'far-alternating-arrival') { assert.equal(result.dense, true); assert.equal(page.selection.coarseCandidates, true); }
      else { assert.equal(result.dense, false); assert.equal(page.selection.worker, true); assert.deepEqual(selected(page), [...result.starts]); }
    } finally { f.dispose(); }
  }
});

test('position edits and tombstones bypass stale coarse; restore retains movement overlay', () => {
  const f = configured(), data = generatePropertyCase('narrow-corridor', 19, 12000, 'far-alternating-arrival');
  try {
    append(f, data); render(f); const page = f.renderer.pages.points[0];
    const movedVertex = 0, id = page.ids[movedVertex]; f.renderer.trackFeatures([id]);
    f.renderer.updateFeaturePositions([{ id, x: 0, y: 0 }]); render(f);
    assert.ok(page.overlayMoved.has(movedVertex)); assert.notEqual(page.selection?.coarseCandidates, true);
    f.renderer.removeFeatures([id]); render(f); assert.ok(page.overlayRemoved.has(movedVertex)); assert.notEqual(page.selection?.coarseCandidates, true);
    assert.equal(page.colors[3], 0);
    f.renderer.restoreFeatures([id]); const frame = render(f);
    assert.ok(page.overlayMoved.has(movedVertex)); assert.notEqual(page.selection?.coarseCandidates, true);
    assert.equal(page.positions[0], 0); assert.equal(page.positions[1], 0); assert.equal(page.colors[3], 180);
    assert.ok(frame.submitted > 0); // Conservative dense fallback is acceptable.
  } finally { f.dispose(); }
});

for (const size of [2, 3]) test(`coarse candidates retain complete ${size}-vertex crossings with centroid outside`, () => {
  const f = configured();
  try {
    f.renderer.setOptimizationOptions({ maxCandidateRatio: 1 });
    const coords = [-1200, 0, 4000, 20]; if (size === 3) coords.push(4000, 800);
    for (let i = 1; i < 128; i++) { const x = i % 2 ? -3500 : 3500, y = i * 20;
      coords.push(x, y, x + 20, y); if (size === 3) coords.push(x + 20, y + 20); }
    const data = { primitiveSize: size, count: 128, positions: Float32Array.from(coords), ids: Uint32Array.from({ length: 128 }, (_, i) => i + 1) };
    f.renderer.append({ groups: [group(data)] }); render(f); const page = f.renderer.pages[size === 2 ? 'lines' : 'polygons'][0];
    assert.equal(page.selection.coarseCandidates, true); assertCovered(data, VIEW, page);
    assert.deepEqual(selected(page).slice(0, size), Array.from({ length: size }, (_, i) => i));
  } finally { f.dispose(); }
});

test('a cached coarse query includes a later visible tail at the new complete append watermark', () => {
  const f = configured(), data = generatePropertyCase('narrow-corridor', 19, 12000, 'far-alternating-arrival');
  try {
    append(f, data); render(f); const page = f.renderer.pages.points[0];
    const tail = { primitiveSize: 1, count: 1, positions: new Float32Array([0, 0]), ids: new Uint32Array([900000]) };
    f.renderer.append({ groups: [group(tail)] }); render(f);
    assert.equal(page.coarseIndexedUntil, 12001); assert.equal(page.coarse.indexedUntil, 12001);
    assert.ok(selected(page).includes(12000)); assert.equal(page.selection.coarseCandidates, true);
    assert.deepEqual(selected(page), [...selected(page)].sort((a, b) => a - b));
  } finally { f.dispose(); }
});

test('on/off/on toggles build references once, invalidate selection and preserve geometry', () => {
  const f = configured(false), data = generatePropertyCase('narrow-corridor', 19, 12000, 'far-alternating-arrival');
  try {
    // Enabling on an existing page rebuilds the summary in one append, whose
    // seed scale differs from the original streamed summary. A .2 budget here
    // permits that conservative U, explicitly without changing production .15.
    f.renderer.setOptimizationOptions({ maxCandidateRatio: .2 });
    append(f, data); const page = f.renderer.pages.points[0], positions = page.positions.slice(), ids = page.ids.slice();
    assert.equal(page.coarse.referenceCapacity, null);
    f.renderer.setOptimizationOptions({ coarseCandidates: true }); const coarse = page.coarse;
    render(f); assert.equal(page.selection.coarseCandidates, true); assert.equal(page.coarseIndexedUntil, page.count);
    const cached = render(f); assert.equal(cached.stats.cacheHits, 1);
    f.renderer.setOptimizationOptions({ coarseCandidates: false }); assert.equal(page.selection, null); assert.equal(page.coarse, coarse);
    render(f); assert.notEqual(page.selection?.coarseCandidates, true);
    f.renderer.setOptimizationOptions({ coarseCandidates: true }); assert.equal(page.coarse, coarse); assert.equal(page.selection, null);
    render(f); assert.equal(page.selection.coarseCandidates, true);
    assert.deepEqual(page.positions, positions); assert.deepEqual(page.ids, ids);
  } finally { f.dispose(); }
});

test('coarse shared writer preserves risk points through LOD and sorts by original start', () => {
  const f = configured(), data = generatePropertyCase('narrow-corridor', 19, 12000, 'far-alternating-arrival');
  try {
    append(f, data); render(f); const page = f.renderer.pages.points[0], candidates = selected(page);
    const riskVertex = candidates.find(v => v % 16); assert.notEqual(riskVertex, undefined);
    f.renderer.trackFeatures([page.ids[riskVertex]]); f.renderer.updateFeatureColors([{ id: page.ids[riskVertex], color: [230, 80, 40, 220] }]);
    f.renderer._lod = () => 16; render(f);
    const riskAware = selected(page); assert.ok(riskAware.includes(riskVertex));
    assert.ok(riskAware.every(v => v % 16 === 0 || v === riskVertex)); assert.deepEqual(riskAware, [...riskAware].sort((a, b) => a - b));
    f.renderer.setRiskPreservation(false); render(f);
    assert.ok(!selected(page).includes(riskVertex)); assert.ok(selected(page).every(v => v % 16 === 0));
  } finally { f.dispose(); }
});
