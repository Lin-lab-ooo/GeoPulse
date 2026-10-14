import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingRenderer } from './helpers/recording-renderer.mjs';

const NORMAL = [20, 130, 220, 180], ALERT = [255, 70, 30, 255];
const VIEW = { x: 100, y: 100, scale: 6, heading: 0 };
function points(n, coordinate = i => i % 100 ? [900, 900] : [100, 100], id = 1) {
  const positions = new Float32Array(n * 2), colors = new Uint8Array(n * 4), ids = new Uint32Array(n);
  for (let i = 0; i < n; i++) { positions.set(coordinate(i), i * 2); colors.set(NORMAL, i * 4); ids[i] = id + i; }
  return { kind: 'points', positions, colors, ids, featureCount: n };
}

// Deterministically make each complete-primitive chunk cost 1 ms. This tests
// sharing and overruns without asserting unstable host-clock timings.
function fixtureWithClock(run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  let now = 0;
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
  const fixture = createRecordingRenderer();
  fixture.renderer.setAdaptive(false);
  fixture.renderer.setOptimizationOptions({ spatialPolicy: 'always', spatialBuildBudgetMs: .5, spatialBuildChunkPrimitives: 128 });
  const patchTrees = () => {
    for (const page of Object.values(fixture.renderer.pages).flat()) if (page.spatial && !page.spatial.clockPatched) {
      const append = page.spatial.append.bind(page.spatial);
      page.spatial.append = (...args) => { const result = append(...args); now += 1; return result; };
      page.spatial.clockPatched = true;
    }
  };
  const pump = (view = VIEW, limit = 2000) => {
    let frame;
    for (let i = 0; i < limit; i++) {
      patchTrees(); frame = fixture.render(view);
      if (!frame.stats.spatialPendingPages && frame.stats.spatialSettled) return fixture.render(view);
    }
    assert.fail('progressive index did not become ready');
  };
  try { return run({ ...fixture, patchTrees, pump, advance: value => { now += value; } }); }
  finally { fixture.dispose(); Object.defineProperty(globalThis, 'performance', descriptor); }
}

test('first paint draws every point before ready; one shared budget serves pages round robin, then refines', () => fixtureWithClock(f => {
  const r = f.renderer;
  assert.equal(r.optimization.spatialBuildExecution, 'progressive');
  r.append({ groups: [points(100000)] });
  const first = f.render(VIEW);
  assert.equal(first.submittedVertices, 100000);
  assert.equal(first.stats.spatialPendingPages, 2);
  assert.equal(first.stats.spatialIndexedPrimitives, 0);
  assert.equal(first.stats.spatialBuildCpuMs, 0, 'changing camera pauses background work');
  assert.equal(first.stats.committedRevision, first.stats.stagingRevision, 'GL ACK covers geometry independently of fine index');
  f.patchTrees(); f.render(VIEW); f.render(VIEW);
  const sliced = f.render(VIEW);
  assert.equal(sliced.submittedVertices, 100000, 'a partial tree is never used for filtering');
  assert.equal(sliced.stats.spatialBuildChunks, 1, 'budget is global, not multiplied by page count');
  assert.equal(sliced.stats.spatialBuildCpuMs, 1);
  assert.equal(sliced.stats.spatialBuildSliceMaxMs, 1);
  assert.ok(sliced.stats.spatialBuildCpuMs > r.optimization.spatialBuildBudgetMs, 'atomic chunk may exceed best effort budget');
  assert.deepEqual(r.pages.points.map(p => p.spatialIndexedUntil), [128, 0]);
  f.render(VIEW);
  assert.deepEqual(r.pages.points.map(p => p.spatialIndexedUntil), [128, 128]);
  const complete = f.pump();
  assert.equal(complete.submittedVertices, 1000);
  assert.equal(complete.stats.spatialBuildProgress, 1);
  assert.equal(complete.stats.spatialReadyPages, 2);
  assert.equal(complete.stats.spatialBuildCompletedCount, 2);
  assert.equal(complete.stats.spatialBuildSynchronousCount, 0);
  assert.equal(complete.stats.fineBuildCount, 2);
  assert.equal(complete.stats.spatialBuildMaxSliceMs, 1);
  assert.ok(complete.stats.spatialBuildMaxReadyWallMs > 1);
  assert.equal(f.render(VIEW).stats.spatialBuildCpuMs, 0);
}));

test('camera motion and disabling pause partial work, while resume preserves tree identity and progress', () => fixtureWithClock(f => {
  const r = f.renderer;
  r.append({ groups: [points(4000)] });
  f.render(VIEW); f.patchTrees(); f.render(VIEW); f.render(VIEW); f.render(VIEW);
  const page = r.pages.points[0], tree = page.spatial, watermark = page.spatialIndexedUntil;
  assert.equal(watermark, 128);
  for (let i = 0; i < 5; i++) {
    const frame = f.render({ ...VIEW, x: 101 + i });
    assert.equal(frame.stats.spatialBuildCpuMs, 0);
    assert.equal(page.spatialIndexedUntil, watermark);
  }
  r.setOptimizationOptions({ spatial: false });
  f.advance(50);
  for (let i = 0; i < 6; i++) assert.equal(f.render(VIEW).submittedVertices, 4000);
  assert.equal(page.spatialIndexedUntil, watermark);
  assert.equal(page.spatial, tree);
  r.setOptimizationOptions({ spatial: true });
  const ready = f.pump();
  assert.equal(page.spatial, tree);
  assert.equal(ready.submittedVertices, 40);
  assert.ok(ready.stats.spatialBuildLastReadyWallMs >= 50, 'ready wall time includes deliberate pauses');
}));

test('append during construction and append to a retained tree include the entire new tail before filtering', () => fixtureWithClock(f => {
  const r = f.renderer;
  r.setOptimizationOptions({ maxCandidateRatio: 1 });
  r.append({ groups: [points(1000)] });
  f.render(VIEW); f.patchTrees(); f.render(VIEW); f.render(VIEW); f.render(VIEW);
  const page = r.pages.points[0], tree = page.spatial;
  r.append({ groups: [points(20, () => [100, 100], 1001)] });
  assert.equal(f.render(VIEW).submittedVertices, 1020);
  assert.equal(f.pump().submittedVertices, 30);
  assert.equal(page.spatial, tree);
  const builds = r.getStats().fineBuildCount;
  r.setOptimizationOptions({ spatial: false });
  r.append({ groups: [points(300, () => [100, 100], 1021)] });
  const oldWatermark = page.spatialIndexedUntil;
  assert.equal(oldWatermark, 1020);
  r.setOptimizationOptions({ spatial: true });
  const fallback = f.render(VIEW);
  assert.equal(fallback.submittedVertices, 1320);
  assert.ok(page.spatialIndexedUntil < page.count);
  const ready = f.pump();
  assert.equal(ready.submittedVertices, 330);
  assert.equal(ready.stats.fineBuildCount, builds);
  assert.equal(ready.stats.fineAppendCount, 1);
  assert.equal(page.spatial, tree);
  assert.equal(page.spatialIndexedUntil, page.count);
}));

test('partial fallback and ready LOD retain nonsampled visible alerts through color changes and append', () => fixtureWithClock(f => {
  const r = f.renderer;
  r.setAdaptive(true);
  r.setOptimizationOptions({ spatialBuildChunkPrimitives: 1024 });
  const view = { x: 0, y: 0, scale: .005, heading: 0 };
  r.append({ groups: [points(60000, i => i % 100 ? [1000000, 0] : [0, 0])] });
  r.trackFeatures([2]);
  f.render(view); f.patchTrees();
  const tail = points(2, () => [0, 0], 60001); tail.colors.set(ALERT, 4);
  r.append({ groups: [tail] });
  const initial = f.render(view);
  assert.equal(initial.stats.lodStride, 16);
  assert.equal(initial.stats.pointAlertsDrawn, 1);
  assert.ok(Array.from(r.pages.points[0].indices.subarray(0, r.pages.points[0].indexCount)).includes(60001));
  r.updateFeatureColors([{ id: 2, color: ALERT }]);
  const promotedDuringBuild = f.render(view);
  assert.equal(promotedDuringBuild.stats.pointAlertsDrawn, 2, 'partial-tree fallback retains both sampled and nonsampled alerts');
  assert.equal(promotedDuringBuild.colorUploadBytes, 4);
  const stillPending = f.render(view);
  assert.ok(stillPending.stats.spatialPendingPages > 0);
  assert.equal(stillPending.indexUploadBytes, 0, 'partial builds reuse unchanged ordinary LOD rather than rebuilding its index every frame');
  const ready = f.pump(view);
  assert.equal(ready.stats.pointAlertsDrawn, 1);
  assert.ok(Array.from(r.pages.points[0].indices.subarray(0, r.pages.points[0].indexCount)).includes(60001));
  r.updateFeatureColors([{ id: 2, color: [255, 71, 30, 255] }]);
  const changed = f.render(view);
  assert.equal(changed.stats.pointAlertsTotal, 2);
  assert.equal(changed.stats.pointAlertsDrawn, 1, 'offscreen alert never alters exact geometry visibility');
  assert.equal(changed.colorUploadBytes, 4);
  assert.equal(changed.stats.spatialBuildChunks, ready.stats.spatialBuildChunks);
}));

test('complete line and triangle chunks preserve crossing primitives and alpha input order', () => fixtureWithClock(f => {
  const r = f.renderer;
  r.setOptimizationOptions({ maxCandidateRatio: 1, spatialBuildChunkPrimitives: 1, leafSize: 8 });
  const groups = [];
  for (const [kind, size] of [['lines', 2], ['polygons', 3]]) {
    const positions = new Float32Array(12 * size * 2), colors = new Uint8Array(12 * size * 4), ids = new Uint32Array(12 * size);
    for (let i = 0; i < 12; i++) for (let j = 0; j < size; j++) {
      const xy = i === 0 ? j === 0 ? [-100, 100] : j === 1 ? [300, 100] : [100, 120] : [900, 900];
      positions.set(xy, (i * size + j) * 2); colors.set(NORMAL, (i * size + j) * 4); ids[i * size + j] = 200000 + i;
    }
    groups.push({ kind, positions, colors, ids });
  }
  r.append({ groups });
  assert.equal(f.render(VIEW).submittedVertices, 60);
  f.patchTrees(); f.render(VIEW); f.render(VIEW); f.render(VIEW);
  for (const page of Object.values(r.pages).flat()) assert.equal(page.spatialIndexedUntil % (page.kind === 'lines' ? 2 : 3), 0);
  const ready = f.pump();
  assert.equal(ready.submittedVertices, 5);
  assert.deepEqual(Array.from(r.pages.lines[0].indices.subarray(0, 2)), [0, 1]);
  assert.deepEqual(Array.from(r.pages.polygons[0].indices.subarray(0, 3)), [0, 1, 2]);
}));

test('clear, structural rebuild, reset and destroy cancel stale tasks without pretending GL commitment', () => fixtureWithClock(f => {
  const r = f.renderer;
  r.append({ groups: [points(1000)] });
  f.render(VIEW); f.patchTrees(); f.render(VIEW); f.render(VIEW); f.render(VIEW);
  const page = r.pages.points[0], oldTree = page.spatial;
  const revision = r.getStats().committedRevision;
  r.clearSpatialIndexes();
  assert.equal(page.spatialTask, null); assert.equal(r.getStats().spatialPendingPages, 0);
  assert.equal(r.getStats().committedRevision, revision);
  f.render(VIEW);
  assert.notEqual(page.spatial, oldTree);
  const replacement = page.spatial;
  r.setOptimizationOptions({ leafSize: 128 });
  assert.equal(page.spatial, null); assert.equal(page.spatialTask, null);
  f.render(VIEW);
  assert.notEqual(page.spatial, replacement);
  r.reset();
  assert.equal(page.spatialTask, null, 'reset must cancel external old page handles too');
  assert.equal(r.getStats().spatialPendingPages, 0);
  assert.equal(r.getStats().spatialBuildChunks, 0);
  r.append({ groups: [points(1000)] }); f.render(VIEW);
  const doomed = r.pages.points[0];
  r.destroy();
  assert.equal(doomed.spatialTask, null);
  assert.equal(r._spatialBuildQueue.length, 0);
}));

test('synchronous baseline stays explicit, validates knobs, and can complete a progressive partial tree', () => fixtureWithClock(f => {
  const r = f.renderer;
  for (const options of [{ spatialBuildExecution: 'worker' }, { spatialBuildBudgetMs: 0 },
    { spatialBuildBudgetMs: Infinity }, { spatialBuildBudgetMs: 21 },
    { spatialBuildChunkPrimitives: 0 }, { spatialBuildChunkPrimitives: 4097 }, { spatialBuildChunkPrimitives: 1.5 }]) {
    assert.throws(() => r.setOptimizationOptions(options));
  }
  r.append({ groups: [points(1000)] }); f.render(VIEW); f.patchTrees();
  const tree = r.pages.points[0].spatial;
  r.setOptimizationOptions({ spatialBuildExecution: 'synchronous' });
  const frame = f.render(VIEW);
  assert.equal(frame.submittedVertices, 10);
  assert.equal(frame.stats.spatialPendingPages, 0);
  assert.equal(frame.stats.spatialBuildSynchronousCount, 1);
  assert.equal(frame.stats.spatialBuildCpuMs, 1);
  assert.equal(r.pages.points[0].spatial, tree);
}));

test('late distant geometry after a huge coincident cluster stays covered with bounded split work', () => fixtureWithClock(f => {
  const r = f.renderer;
  r.setOptimizationOptions({ spatialBuildChunkPrimitives: 128 });
  const group = points(10001, i => i === 10000 ? [100, 100] : [900, 900]);
  group.colors.set(ALERT, 10000 * 4);
  r.append({ groups: [group] });
  assert.equal(f.render(VIEW).submittedVertices, 10001);
  f.patchTrees();
  const ready = f.pump();
  assert.equal(ready.stats.spatialPendingPages, 0);
  assert.equal(r.pages.points[0].spatialIndexedUntil, 10001);
  assert.equal(ready.stats.pointAlertsDrawn, 1);
  assert.ok(ready.submittedVertices >= 1, 'conservative large leaves may draw extra geometry but never omit the late visible alert');
  assert.equal(r.pages.points[0].spatial.maxSplitEntries, 256);
  assert.ok(r.pages.points[0].spatial.splitLimitedLeaves > 0);
}));

test('frame observer tail cost is separate, and no-waiter commit resolution does not repeat getStats', () => fixtureWithClock(f => {
  const r = f.renderer;
  r.onFrame = () => { f.advance(2); };
  let reads = 0;
  const getStats = r.getStats.bind(r);
  r.getStats = () => { reads++; return getStats(); };
  const one = f.render(VIEW);
  assert.equal(reads, 2, 'one observer snapshot plus recorder snapshot, no redundant waiter snapshot');
  assert.equal(one.stats.frameTelemetryCpuMs, 2);
  assert.equal(one.stats.frameTotalCpuMs, 2);
  const two = f.render(VIEW);
  assert.equal(two.stats.previousFrameTelemetryCpuMs, 2);
  assert.equal(two.stats.previousFrameTotalCpuMs, 2);
}));
