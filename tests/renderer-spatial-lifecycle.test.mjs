import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingRenderer as createRecorder } from './helpers/recording-renderer.mjs';

// These 1.6 lifecycle assertions intentionally exercise the synchronous
// reference path. Progressive readiness is tested in its own suite.
function createRecordingRenderer() {
  const fixture = createRecorder();
  fixture.renderer.setOptimizationOptions({ spatialBuildExecution: 'synchronous' });
  return fixture;
}

const NORMAL = [20, 130, 220, 180], ALERT = [255, 70, 30, 255];
const VIEW = { x: 100, y: 100, scale: 6, heading: 0 };

function points(n, coordinate, firstID = 1) {
  const positions = new Float32Array(n * 2), colors = new Uint8Array(n * 4), ids = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    positions.set(coordinate(i), i * 2); colors.set(NORMAL, i * 4); ids[i] = firstID + i;
  }
  return { kind: 'points', positions, colors, ids, featureCount: n };
}

function settle(fixture, view = VIEW) {
  let frame;
  for (let i = 0; i <= fixture.renderer.optimization.settleFrames; i++) frame = fixture.render(view);
  return frame;
}

test('million dense primitives append only bounded coarse summaries and never create rejected fine trees', () => {
  const fixture = createRecordingRenderer();
  try {
    const r = fixture.renderer;
    r.setAdaptive(false);
    r.append({ groups: [points(1000000, i => i % 50 ? [100 + i % 8, 100] : [900, 900])] });
    assert.equal(r.optimization.spatialBuildPolicy, 'lazy');
    assert.equal(r.getStats().fineBuildCount, 0);
    assert.equal(r.getStats().spatialFinePages, 0);
    const frame = settle(fixture);
    assert.equal(frame.submittedVertices, 1000000);
    assert.equal(frame.stats.fineBuildCount, 0);
    assert.equal(frame.stats.spatialBuildMs, 0);
    assert.ok(frame.stats.coarseDensityGuardCount > 0);
    assert.equal(frame.stats.coarseOwnedBytes, r.pages.points.length * 256 * 52);
    assert.ok(r.pages.points.every(p => p.coarseIndexedUntil === p.count && p.spatialIndexedUntil === 0));
    const cached = fixture.render(VIEW);
    assert.equal(cached.stats.coarseBucketsTested, 0);
    assert.equal(cached.stats.coarseDensityGuardCount, frame.stats.coarseDensityGuardCount);
    assert.equal(cached.submittedVertices, 1000000);
  } finally { fixture.dispose(); }
});

test('100k sparse selection builds on demand; toggle retains identity and disabled append catches up exactly once', async () => {
  const fixture = createRecordingRenderer();
  try {
    const r = fixture.renderer;
    r.setAdaptive(false);
    r.append({ groups: [points(100000, i => i % 100 ? [900, 900] : [100, 100])] });
    assert.equal(r.getStats().fineBuildCount, 0);
    const first = settle(fixture);
    assert.equal(first.submittedVertices, 1000);
    const trees = r.pages.points.map(p => p.spatial), buildCount = first.stats.fineBuildCount;
    assert.equal(buildCount, 2);
    const bytes = first.stats.fineOwnedBytes;
    r.setOptimizationOptions({ spatial: false });
    assert.deepEqual(r.pages.points.map(p => p.spatial), trees);
    assert.equal(fixture.render(VIEW).submittedVertices, 100000);
    const tail = r.pages.points.at(-1), watermark = tail.spatialIndexedUntil;
    r.append({ groups: [points(20, () => [100, 100], 100001)] });
    assert.equal(tail.spatialIndexedUntil, watermark, 'lazy append does not pay fine-tree work on the stream path');
    assert.equal(tail.coarseIndexedUntil, tail.count);
    r.setOptimizationOptions({ spatial: true });
    const resumed = settle(fixture);
    assert.equal(resumed.submittedVertices, 1020);
    assert.equal(tail.spatialIndexedUntil, tail.count);
    assert.deepEqual(r.pages.points.map(p => p.spatial), trees);
    assert.equal(resumed.stats.fineBuildCount, buildCount);
    assert.equal(resumed.stats.fineAppendCount, 1);
    assert.equal(resumed.stats.fineOwnedBytes, bytes, 'append remains within already-owned fine blocks');
    await r.awaitCommit(r.getStats().stagingRevision);
    const cached = fixture.render(VIEW);
    assert.equal(cached.indexUploadBytes, 0);
    assert.equal(cached.stats.fineAppendCount, 1);
    assert.ok(cached.stats.fineReuseCount > 0);
  } finally { fixture.dispose(); }
});

test('ordinary and alert updates retain the same fine tree, while structural changes invalidate only fine data', () => {
  const fixture = createRecordingRenderer();
  try {
    const r = fixture.renderer;
    r.setAdaptive(false);
    r.setOptimizationOptions({ spatialPolicy: 'always' });
    r.append({ groups: [points(10000, i => i % 100 ? [900, 900] : [100, 100])] });
    r.trackFeatures([1, 2]);
    fixture.render(VIEW);
    const page = r.pages.points[0], tree = page.spatial, coarse = page.coarse;
    const buildCount = r.getStats().fineBuildCount;
    r.updateFeatureColors([{ id: 1, color: [40, 150, 220, 180] }]);
    const ordinary = fixture.render(VIEW);
    assert.equal(ordinary.colorUploadBytes, 4);
    assert.equal(ordinary.indexUploadBytes, 0);
    assert.equal(ordinary.stats.cacheHits, 1);
    r.updateFeatureColors([{ id: 1, color: ALERT }, { id: 2, color: ALERT }]);
    const alert = fixture.render(VIEW);
    assert.equal(alert.stats.pointAlertsDrawn, 1, 'offscreen alerts do not become visible through fine geometry');
    assert.equal(alert.stats.pointAlertsTotal, 2);
    assert.equal(page.spatial, tree);
    assert.equal(alert.stats.fineBuildCount, buildCount);
    r.setOptimizationOptions({ maxCandidateRatio: 1, dirtyMode: 'envelope', settleFrames: 4 });
    assert.equal(page.spatial, tree);
    r.setOptimizationOptions({ leafSize: 128 });
    assert.equal(page.spatial, null);
    assert.equal(page.spatialIndexedUntil, 0);
    assert.equal(page.coarse, coarse);
    fixture.render(VIEW);
    assert.notEqual(page.spatial, tree);
    assert.equal(r.getStats().fineBuildCount, buildCount + 1);
  } finally { fixture.dispose(); }
});

test('retained fine trees bypass loose coarse upper bounds and still use their better candidate count', () => {
  const fixture = createRecordingRenderer();
  try {
    const r = fixture.renderer;
    r.setAdaptive(false);
    r.setOptimizationOptions({ spatialBuildPolicy: 'eager', spatialPolicy: 'always', leafSize: 8, minExtent: 0 });
    r.append({ groups: [points(10000, i => i < 10 ? [130, 100] : i % 2 ? [145, 100] : [900, 900])] });
    const page = r.pages.points[0], tree = page.spatial;
    // x=130 and x=145 share a coarse cell, but only x=130 is in the viewport.
    const view = { ...VIEW, scale: 10 };
    Object.assign(r.camera, view);
    const coarseCount = page.coarse.count(b => r._classifyBounds(b, r._localMatrix()));
    assert.ok(coarseCount.primitivesSelected > page.count * r.optimization.maxCandidateRatio);
    r.setOptimizationOptions({ spatialBuildPolicy: 'lazy' });
    const frame = fixture.render(view);
    assert.equal(page.spatial, tree);
    assert.equal(frame.submittedVertices, 10);
    assert.equal(frame.stats.coarseBucketsTested, 0, 'fine count is used directly, independent of coarse looseness');
    assert.equal(frame.stats.fineBuildCount, 1);
  } finally { fixture.dispose(); }
});

test('experimental eager/clear lifecycle is explicit and cold resets preserve geometry and commit revisions', async () => {
  const fixture = createRecordingRenderer();
  try {
    const r = fixture.renderer;
    r.setOptimizationOptions({ spatialBuildPolicy: 'eager', spatialRetainOnDisable: false, spatialPolicy: 'always' });
    r.setAdaptive(false);
    r.append({ groups: [points(1000, i => i < 10 ? [100, 100] : [900, 900])] });
    assert.equal(r.getStats().fineBuildCount, 1);
    fixture.render(VIEW);
    const page = r.pages.points[0], coarse = page.coarse, revision = r.getStats().stagingRevision;
    r.setOptimizationOptions({ spatial: false });
    assert.equal(page.spatial, null);
    r.setOptimizationOptions({ spatial: true });
    assert.equal(fixture.render(VIEW).submittedVertices, 10);
    assert.equal(r.getStats().fineBuildCount, 2);
    r.clearSpatialIndexes({ fineOnly: true });
    assert.equal(page.coarse, coarse);
    assert.equal(r.getStats().stagingRevision, revision);
    assert.equal(r.getStats().totalVertices, 1000);
    assert.equal(fixture.render(VIEW).submittedVertices, 10);
    await r.awaitCommit(revision);
    assert.throws(() => r.setOptimizationOptions({ spatialBuildPolicy: 'unknown' }));
    assert.throws(() => r.setOptimizationOptions({ spatialRetainOnDisable: 1 }));
    r.reset();
    assert.equal(r.getStats().fineBuildCount, 0);
    assert.equal(r.getStats().coarseDensityGuardCount, 0);
    assert.equal(r.getStats().coarseOwnedBytes, 0);
    assert.equal(r.getStats().fineOwnedBytes, 0);
  } finally { fixture.dispose(); }
});

test('coarse empty selection can switch through full-page LOD and accept a new visible alert without stale indices', async () => {
  const fixture = createRecordingRenderer();
  try {
    const r = fixture.renderer;
    r.setAdaptive(false);
    r.setOptimizationOptions({ spatialPolicy: 'always' });
    r.append({ groups: [points(60000, i => i % 2 ? [900, 900] : [100, 100])] });
    const emptyView = { x: 500, y: 500, scale: 6, heading: 0 };
    assert.equal(fixture.render(emptyView).submittedVertices, 0);
    assert.equal(r.getStats().fineBuildCount, 0);
    assert.equal(r.pages.points[0].selection.coarseEmpty, true);
    r.setAdaptive(true);
    const zoomedOut = fixture.render({ x: 500, y: 500, scale: .001, heading: 0 });
    assert.equal(zoomedOut.stats.lodStride, 16);
    assert.equal(zoomedOut.submittedVertices, 3750);
    assert.equal(fixture.render(emptyView).submittedVertices, 0);
    const visible = points(1, () => [500, 500], 60001);
    visible.colors.set(ALERT);
    const added = r.append({ groups: [visible] });
    const withAlert = fixture.render(emptyView);
    assert.equal(withAlert.submittedVertices, 1);
    assert.equal(withAlert.stats.pointAlertsDrawn, 1);
    assert.equal(r.pages.points[0].indices[0], 60000);
    await r.awaitCommit(added.revision);
    const cached = fixture.render(emptyView);
    assert.equal(cached.submittedVertices, 1);
    assert.equal(cached.indexUploadBytes, 0);
  } finally { fixture.dispose(); }
});

test('structural changes while disabled discard fine state but retain current coarse geometry; full clear rebuilds summaries', () => {
  const fixture = createRecordingRenderer();
  try {
    const r = fixture.renderer;
    r.setAdaptive(false);
    r.setOptimizationOptions({ spatialPolicy: 'always' });
    r.append({ groups: [points(1000, i => i < 10 ? [100, 100] : [900, 900])] });
    fixture.render(VIEW);
    const page = r.pages.points[0], tree = page.spatial, coarse = page.coarse;
    r.setOptimizationOptions({ spatial: false });
    r.append({ groups: [points(5, () => [100, 100], 1001)] });
    assert.equal(page.spatial, tree);
    r.setOptimizationOptions({ minExtent: 0, maxDepth: 20 });
    assert.equal(page.spatial, null);
    assert.equal(page.coarse, coarse);
    assert.equal(page.coarse.getStats().primitives, 1005);
    r.setOptimizationOptions({ spatial: true });
    assert.equal(fixture.render(VIEW).submittedVertices, 15);
    assert.notEqual(page.spatial, tree);
    r.clearSpatialIndexes({ fineOnly: false });
    assert.equal(page.spatial, null);
    assert.notEqual(page.coarse, coarse);
    assert.equal(page.coarseIndexedUntil, 1005);
    assert.equal(page.coarse.getStats().primitives, 1005);
    assert.equal(fixture.render(VIEW).submittedVertices, 15);
  } finally { fixture.dispose(); }
});
