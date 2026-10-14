/**
 * End-to-end live-edit contract for the dynamic-update closure:
 *   stable append-only pages + spatial tree, with a change index on top.
 *
 * These run against the recording WebGL helper, so every assertion is about the
 * GL calls the renderer actually issues, not about internal bookkeeping.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingRenderer as createProductionRecorder } from './helpers/recording-renderer.mjs';

const NORMAL = [20, 130, 220, 180];
const A_VIEW = { x: 100, y: 100, scale: 6, heading: 0 };
const B_VIEW = { x: 900, y: 900, scale: 6, heading: 0 };

function createRecordingRenderer() {
  const fixture = createProductionRecorder();
  fixture.renderer.setOptimizationOptions({ spatialBuildExecution: 'synchronous', spatialPolicy: 'always', maxCandidateRatio: 1 });
  return fixture;
}

/** Two clusters: 1000 points around (100,100) and 1000 around (900,900). */
function twoClusters(count, firstID = 1) {
  const positions = new Float32Array(count * 2);
  const colors = new Uint8Array(count * 4);
  const ids = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const center = i % 2 ? 900 : 100;
    const pair = Math.floor(i / 2);
    positions.set([center - 10 + pair % 21, center - 10 + Math.floor(pair / 21) % 21], i * 2);
    colors.set(NORMAL, i * 4);
    ids[i] = firstID + i;
  }
  return { kind: 'points', positions, colors, ids, featureCount: count };
}

const indexUploadBytes = frame => frame.indexUploadBytes;
const totalUploadBytes = fixture => fixture.gl.uploads.reduce((sum, upload) => sum + upload.byteLength, 0);

test('a moved feature joins the drawn set even when the tree only knows its old slot', () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    renderer.setAdaptive(false);
    renderer.append({ groups: [twoClusters(2000)] });
    const page = renderer.pages.points[0];
    // Subscribe a feature that lives in cluster A, then move it to cluster B.
    const id = 1; // vertex 0, at (90,90)
    assert.equal(renderer.trackFeatures([id]).bound, 1);
    fixture.render(A_VIEW);
    assert.equal(page.indices[0], 0, 'the feature is drawn inside cluster A');

    fixture.gl.resetMeasurements();
    const moved = renderer.updateFeaturePositions([{ id, x: 905, y: 905 }]);
    assert.equal(moved.updated, 1);
    assert.deepEqual(renderer.getOverlay().moved, 1);

    // Render the viewport it moved into: the append-only tree would not offer
    // this vertex, so the change index has to.
    const atB = fixture.render(B_VIEW);
    assert.ok(atB.submittedVertices > 0, 'cluster B is still drawn');
    const drawn = Array.from(page.indices.subarray(0, page.indexCount));
    assert.ok(drawn.includes(0), 'the moved feature is submitted from its new viewport');
    // Its viewport in A no longer needs it, but the tree still offers the old
    // slot: over-drawing is the conservative direction and is bounded by LOD.
    const atA = fixture.render(A_VIEW);
    assert.ok(atA.submittedVertices > 0);
  } finally { fixture.dispose(); }
});

test('a move uploads eight bytes per vertex instead of the page', () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    renderer.setAdaptive(false);
    renderer.append({ groups: [twoClusters(2000)] });
    renderer.trackFeatures([1]);
    fixture.render(A_VIEW);
    fixture.gl.resetMeasurements();

    renderer.updateFeaturePositions([{ id: 1, x: 105, y: 105 }]);
    fixture.render(A_VIEW);
    const positionBytes = fixture.gl.uploads
      .filter(upload => upload.buffer === renderer.pages.points[0].gpu.position)
      .reduce((sum, upload) => sum + upload.byteLength, 0);
    assert.equal(positionBytes, 8, 'one vertex, one xy pair, one eight-byte upload');
    assert.ok(totalUploadBytes(fixture) < 64, `total upload ${totalUploadBytes(fixture)} bytes stays tiny`);
  } finally { fixture.dispose(); }
});

test('removal tombstones the feature, drops it from the draw list, and restore brings it back', () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    renderer.setAdaptive(false);
    renderer.append({ groups: [twoClusters(2000)] });
    renderer.trackFeatures([1, 3]);
    const before = fixture.render(A_VIEW).submittedVertices;
    const page = renderer.pages.points[0];
    assert.ok(Array.from(page.indices.subarray(0, page.indexCount)).includes(0));

    const removed = renderer.removeFeatures([1]);
    assert.equal(removed.removed, 1);
    assert.equal(removed.ignored, 0);
    assert.equal(renderer.getOverlay().removed, 1);
    assert.equal(page.colors[3], 0, 'the alpha byte is tombstoned for the dense path');

    const after = fixture.render(A_VIEW);
    assert.equal(after.submittedVertices, before - 1, 'exactly one feature left the draw list');
    assert.ok(!Array.from(page.indices.subarray(0, page.indexCount)).includes(0));

    // Removing is idempotent and a removed feature rejects position edits.
    assert.equal(renderer.removeFeatures([1]).removed, 0);
    renderer.updateFeaturePositions([{ id: 1, x: 0, y: 0 }]);
    assert.equal(renderer.getOverlay().positionUpdates, 0, 'a tombstoned feature is not moved');

    assert.equal(renderer.restoreFeatures([1]).restored, 1);
    assert.equal(renderer.getOverlay().removed, 0);
    assert.equal(fixture.render(A_VIEW).submittedVertices, before, 'the feature is drawable again');
  } finally { fixture.dispose(); }
});

test('edits invalidate only the cached selection for the affected pages', () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    renderer.setAdaptive(false);
    renderer.append({ groups: [twoClusters(2000)] });
    renderer.trackFeatures([1]);
    fixture.render(A_VIEW);
    const cached = fixture.render(A_VIEW);
    assert.equal(cached.stats.cacheHits, 1, 'the steady state reuses the selection');
    const page = renderer.pages.points[0];
    const oldIndices = Array.from(page.indices.subarray(0, page.indexCount));

    renderer.updateFeaturePositions([{ id: 1, x: 110, y: 110 }]);
    const afterEdit = fixture.render(A_VIEW);
    assert.equal(afterEdit.stats.cacheHits, 0, 'the edit forced a re-query');
    assert.deepEqual(Array.from(page.indices.subarray(0, page.indexCount)), oldIndices, 'this move stays in the same selected candidate set');
    assert.equal(indexUploadBytes(afterEdit), 0, 're-querying an unchanged index does not resend it');
    const again = fixture.render(A_VIEW);
    assert.equal(again.stats.cacheHits, 1, 'and the new selection is cached again');
  } finally { fixture.dispose(); }
});

test('validation is atomic for the new edit APIs', () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    renderer.append({ groups: [twoClusters(100)] });
    renderer.trackFeatures([1]);
    assert.throws(() => renderer.updateFeaturePositions([{ id: 1, x: 1, y: 2 }, { id: 2, x: NaN, y: 0 }]), /有限/);
    assert.equal(renderer.getOverlay().positionUpdates, 0, 'nothing was applied');
    assert.throws(() => renderer.updateFeaturePositions([{ id: -1, x: 0, y: 0 }]), /uint32/);
    assert.throws(() => renderer.removeFeatures([1.5]), /uint32/);
    assert.throws(() => renderer.removeFeatures('1'), /数组/);
    assert.equal(renderer.getOverlay().removed, 0);
  } finally { fixture.dispose(); }
});

test('the update queue is reachable from the renderer and reports overload honestly', () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    renderer.append({ groups: [twoClusters(100)] });
    const queue = renderer._updateQueue;
    for (let i = 0; i < 10; i++) queue.offer({ id: i, color: [i, 0, 0, 255], at: i });
    queue.offer({ id: 3, color: [0, 255, 0, 255], at: 99, critical: true });
    assert.equal(queue.backlog, 11);
    const drained = queue.drain(4);
    assert.equal(drained[0].critical, true, 'critical work drains first');
    assert.deepEqual(drained[0].color, [0, 255, 0, 255]);
    const stats = renderer.getStats().updateQueue;
    assert.equal(stats.offered, 11);
    assert.equal(stats.coalesced, 0);
    assert.equal(stats.drained, 4);
  } finally { fixture.dispose(); }
});
