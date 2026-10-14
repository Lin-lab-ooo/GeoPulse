import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingRenderer } from './helpers/recording-renderer.mjs';

const NORMAL = [20, 130, 220, 255];
function points(count, x = 0, firstID = 1) {
  const positions = new Float32Array(count * 2), colors = new Uint8Array(count * 4), ids = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    positions.set([x + i % 20, Math.floor(i / 20) % 20], i * 2);
    colors.set(NORMAL, i * 4); ids[i] = firstID + i;
  }
  return { groups: [{ kind: 'points', positions, colors, ids, featureCount: count }] };
}

test('dirty queue visits touched pages only and append bursts deduplicate by page', () => {
  const f = createRecordingRenderer();
  try {
    const r = f.renderer; r.setOptimizationOptions({ spatial: false }); r.setAdaptive(false);
    r.append(points(65535 * 3)); f.render();
    r.trackFeatures([1]);
    const before = r.getStats().geometrySubmission;
    for (let i = 0; i < 20; i++) r.updateFeatureColors([{ id: 1, color: [i, 20, 30, 255] }]);
    assert.equal(r.getCommitStats().pendingGeometryPages, 1);
    const next = f.render();
    assert.equal(next.stats.geometrySubmission.queuedPagesVisited - before.queuedPagesVisited, 1);
    assert.equal(next.stats.geometrySubmission.pagesSubmitted - before.pagesSubmitted, 1);
    assert.equal(next.colorUploadBytes, 4);
    assert.equal(next.stats.geometrySubmission.pendingPages, 0);
    const idle = f.render();
    assert.equal(idle.stats.geometrySubmission.queuedPagesVisited, next.stats.geometrySubmission.queuedPagesVisited);
    assert.equal(idle.uploadBytes, 0);
    assert.equal(idle.submittedVertices, 65535 * 3);
  } finally { f.dispose(); }
});

test('hidden position edits are submitted before awaitCommit resolves', async () => {
  const f = createRecordingRenderer();
  try {
    const r = f.renderer; r.append(points(4)); r.trackFeatures([1]); f.render();
    r.setLayers({ points: false });
    const update = r.updateFeaturePositions([{ id: 1, x: 999999, y: 999999 }]);
    let resolved = false;
    const pending = r.awaitCommit(update.revision).then(stats => { resolved = true; return stats; });
    await Promise.resolve(); assert.equal(resolved, false);
    const frame = f.render();
    assert.equal(frame.uploads.filter(u => u.channel === 'position').reduce((s, u) => s + u.byteLength, 0), 8);
    assert.equal(frame.drawCalls, 0);
    assert.equal((await pending).committedRevision, update.revision);
    assert.equal(r.pages.points[0].positionDirtyRanges.length, 0);
  } finally { f.dispose(); }
});

test('offscreen tombstone and restoration each issue their four-byte upload before ACK', async () => {
  const f = createRecordingRenderer();
  try {
    const r = f.renderer; r.setOptimizationOptions({ spatial: false });
    r.append(points(4, 999999)); r.trackFeatures([1]); f.render();
    for (const change of [() => r.removeFeatures([1]), () => r.restoreFeatures([1])]) {
      const update = change(), pending = r.awaitCommit(update.revision);
      const frame = f.render();
      assert.equal(frame.colorUploadBytes, 4); assert.equal(frame.drawCalls, 0);
      assert.equal((await pending).committedRevision, update.revision);
    }
  } finally { f.dispose(); }
});

test('every shared SDK callback still draws stable geometry without new uploads', () => {
  const f = createRecordingRenderer();
  try {
    const r = f.renderer; r.setOptimizationOptions({ spatial: false }); r.append(points(4)); f.render();
    const before = r.getStats().geometrySubmission;
    for (let i = 0; i < 4; i++) {
      f.gl.resetMeasurements();
      r._render(f.gl, r._localMatrix(), { time: 2000 + i * 16, unitsPerPixel: 1 / r.camera.scale, pixelRatio: 1, shared: true });
      assert.equal(f.gl.draws.length, 1); assert.equal(f.gl.draws[0].count, 4);
      assert.equal(f.gl.uploads.length, 0);
    }
    assert.equal(r.getStats().geometrySubmission.queuedPagesVisited, before.queuedPagesVisited);
  } finally { f.dispose(); }
});

test('context replacement requeues all pages including hidden layers', () => {
  const f = createRecordingRenderer();
  try {
    const r = f.renderer; r.setLayers({ points: false }); r.append(points(65536)); f.render();
    r._deleteGPU();
    assert.equal(r.getCommitStats().pendingGeometryPages, 2);
    const frame = f.render();
    assert.equal(frame.uploadBytes, 65536 * 12); assert.equal(frame.drawCalls, 0);
    assert.equal(r.getCommitStats().pendingGeometryPages, 0);
  } finally { f.dispose(); }
});

test('reset clears queued old pages and cancels pending revision without submitting stale geometry', async () => {
  const f = createRecordingRenderer();
  try {
    const r = f.renderer, old = r.append(points(8));
    const waiting = assert.rejects(r.awaitCommit(old.revision), { name: 'AbortError' });
    r.reset(); await waiting;
    assert.equal(r.getCommitStats().pendingGeometryPages, 0);
    const frame = f.render(); assert.equal(frame.uploadBytes, 0); assert.equal(frame.submittedVertices, 0);
    const fresh = r.append(points(2)); const done = r.awaitCommit(fresh.revision); f.render();
    assert.equal((await done).committedRevision, fresh.revision);
  } finally { f.dispose(); }
});

test('summaryOnly append and getCommitStats do not scan spatial telemetry', () => {
  const f = createRecordingRenderer();
  try {
    const r = f.renderer; r.append(points(2));
    r.pages.points[0].coarse.getStats = () => { throw new Error('full spatial scan'); };
    const receipt = r.append(points(2, 0, 3), { summaryOnly: true });
    assert.equal(receipt.totalVertices, 4); assert.equal(receipt.pendingGeometryPages, 1);
    assert.equal(r.getCommitStats().stagingRevision, receipt.revision);
    assert.throws(() => r.append(points(2), { summaryOnly: 1 }), /summaryOnly/);
    assert.throws(() => r.getStats(), /full spatial scan/);
  } finally { f.dispose(); }
});

test('GL submission failure cannot acknowledge a revision or drop the dirty page', async () => {
  const f = createRecordingRenderer();
  try {
    const r = f.renderer, receipt = r.append(points(2));
    const pending = assert.rejects(r.awaitCommit(receipt.revision), /injected/);
    f.gl.bufferSubData = () => { throw new Error('injected GL submission failure'); };
    assert.throws(() => f.render(), /injected/); await pending;
    assert.ok(r.getCommitStats().committedRevision < receipt.revision);
    assert.equal(r.getCommitStats().pendingGeometryPages, 1);
  } finally { f.dispose(); }
});

test('a move that changes selected membership still uploads the changed index', () => {
  const f = createRecordingRenderer();
  try {
    const r = f.renderer; r.setAdaptive(false);
    r.setOptimizationOptions({ spatialBuildExecution: 'synchronous', spatialPolicy: 'always', maxCandidateRatio: 1, spatialQueryWorker: false });
    const a = points(100, 100), b = points(100, 900, 101);
    r.append({ groups: [...a.groups, ...b.groups] }); r.trackFeatures([1]);
    const view = { x: 900, y: 10, scale: 6, heading: 0 };
    f.render(view); f.render(view);
    const page = r.pages.points[0];
    assert.ok(!Array.from(page.indices.subarray(0, page.indexCount)).includes(0));
    r.updateFeaturePositions([{ id: 1, x: 905, y: 10 }]);
    const after = f.render(view);
    assert.ok(Array.from(page.indices.subarray(0, page.indexCount)).includes(0));
    assert.ok(after.indexUploadBytes > 0);
  } finally { f.dispose(); }
});
