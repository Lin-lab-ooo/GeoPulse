import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingRenderer as createProductionRecorder } from './helpers/recording-renderer.mjs';

// Preserve the existing same-frame geometry assertions using the explicit
// synchronous baseline. Production's progressive path has separate tests.
function createRecorder() {
  const fixture = createProductionRecorder();
  fixture.renderer.setOptimizationOptions({ spatialBuildExecution: 'synchronous' });
  return fixture;
}

const NORMAL = [20, 130, 220, 180];
const ALERT = [255, 70, 30, 255];
const A_VIEW = { x: 100, y: 100, scale: 6, heading: 0 };

// Strict geometry tests deliberately request eager querying. Production's
// settled policy is tested separately below with the recorder's actual default.
function createRecordingRenderer() {
  const fixture = createRecorder();
  fixture.renderer.setOptimizationOptions({ spatialPolicy: 'always', maxCandidateRatio: 1 });
  return fixture;
}

function points(count, coordinate, firstID = 1) {
  const positions = new Float32Array(count * 2);
  const colors = new Uint8Array(count * 4);
  const ids = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    positions.set(coordinate(i), i * 2);
    colors.set(NORMAL, i * 4);
    ids[i] = firstID + i;
  }
  return { kind: 'points', positions, colors, ids, featureCount: count };
}

function append(renderer, ...groups) { return renderer.append({ groups }); }

function twoClusters(count, firstID = 1) {
  return points(count, i => {
    const center = i % 2 ? 900 : 100;
    const pair = Math.floor(i / 2);
    return [center - 10 + pair % 21, center - 10 + Math.floor(pair / 21) % 21];
  }, firstID);
}

test('interleaved A/B input submits zero points in the empty middle and exactly A in its viewport', () => {
  const fixture = createRecordingRenderer();
  try {
    fixture.renderer.setAdaptive(false);
    append(fixture.renderer, twoClusters(2000));
    const empty = fixture.render({ x: 500, y: 500, scale: 6, heading: 0 });
    assert.equal(empty.drawCalls, 0);
    assert.equal(empty.submittedVertices, 0);
    const a = fixture.render(A_VIEW);
    assert.equal(a.stats.pointsSubmitted, 1000);
    const page = fixture.renderer.pages.points[0];
    assert.ok(Array.from(page.indices.subarray(0, page.indexCount)).every(index => index % 2 === 0));
    fixture.renderer.setOptimizationOptions({ spatial: false });
    assert.equal(fixture.render(A_VIEW).stats.pointsSubmitted, 2000);
  } finally { fixture.dispose(); }
});

test('two distant colors use eight bytes without position uploads; adjacent colors use one call', () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    renderer.setAdaptive(false);
    append(renderer, points(50001, () => [0, 0]));
    renderer.trackFeatures([101, 102, 50001]);
    fixture.render();
    renderer.updateFeatureColors([
      { id: 101, color: [40, 150, 240, 180] },
      { id: 50001, color: [40, 150, 240, 180] }
    ]);
    const far = fixture.render();
    assert.equal(far.colorUploadBytes, 8);
    assert.equal(far.colorUploadCalls, 2);
    assert.equal(far.uploads.filter(upload => upload.channel === 'position').length, 0);
    renderer.updateFeatureColors([
      { id: 101, color: [50, 160, 240, 180] },
      { id: 102, color: [50, 160, 240, 180] }
    ]);
    const adjacent = fixture.render();
    assert.equal(adjacent.colorUploadBytes, 8);
    assert.equal(adjacent.colorUploadCalls, 1);
    assert.equal(adjacent.uploads.find(upload => upload.channel === 'color').offset, 400);
    const unchanged = renderer.updateFeatureColors([{ id: 101, color: [50, 160, 240, 180] }]);
    assert.equal(unchanged.updated, 0);
    assert.equal(fixture.render().uploadBytes, 0);
  } finally { fixture.dispose(); }
});

test('alert membership invalidates only its page selection, retains promoted point, and recovers it', () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    const coordinate = i => [i % 2 ? 1000000 : 0, 0];
    append(renderer, points(65535, coordinate), points(2000, coordinate, 65536));
    renderer.trackFeatures([101]);
    const camera = { x: 0, y: 0, scale: 0.005, heading: 0 };
    fixture.render(camera);
    const [first, second] = renderer.pages.points;
    const firstSelection = first.selection;
    const secondSelection = second.selection;
    const count = first.indexCount;
    assert.equal(Array.from(first.indices.subarray(0, count)).includes(100), false);
    renderer.updateFeatureColors([{ id: 101, color: ALERT }]);
    const promoted = fixture.render(camera);
    assert.notEqual(first.selection, firstSelection);
    assert.equal(second.selection, secondSelection);
    assert.equal(promoted.stats.cacheHits, 1);
    assert.equal(first.indexCount, count + 1);
    assert.equal(promoted.stats.pointAlertsDrawn, 1);
    assert.ok(promoted.uploads.filter(upload => upload.channel === 'index')
      .every(upload => upload.buffer === first.gpu.index.id));
    renderer.updateFeatureColors([{ id: 101, color: NORMAL }]);
    const recovered = fixture.render(camera);
    assert.equal(first.indexCount, count);
    assert.equal(recovered.stats.pointAlertsDrawn, 0);
    assert.equal(recovered.stats.cacheHits, 1);
  } finally { fixture.dispose(); }
});

test('an unchanged frame reuses selection with zero index upload; in-place matrix changes query again', () => {
  const fixture = createRecordingRenderer();
  try {
    fixture.renderer.setAdaptive(false);
    append(fixture.renderer, twoClusters(2000));
    const first = fixture.render(A_VIEW);
    assert.equal(first.indexUploadBytes, 2000);
    const stationary = fixture.render(A_VIEW);
    assert.equal(stationary.stats.cacheHits, 1);
    assert.equal(stationary.stats.nodesTested, 0);
    assert.equal(stationary.indexUploadBytes, 0);
    // _localMatrix reuses renderer.matrix; the selection must own its snapshot.
    // A same-size pan exposes an unqueried strip, even when an inflated AABB
    // would have contained it. Query again; unchanged membership costs no upload.
    const nudged = fixture.render({ ...A_VIEW, x: 101 });
    assert.equal(nudged.stats.cacheHits, 0);
    assert.ok(nudged.stats.nodesTested > 0);
    assert.equal(nudged.indexUploadBytes, 0);
    // A pan that leaves the cached box must re-query, but the selected IDs are
    // unchanged so no index bytes move.
    const movedWithinA = fixture.render({ ...A_VIEW, x: 120 });
    assert.equal(movedWithinA.stats.cacheHits, 0);
    assert.ok(movedWithinA.stats.nodesTested > 0);
    assert.ok(movedWithinA.stats.selectionReuse.worldBoxMisses >= 1);
    assert.equal(movedWithinA.indexUploadBytes, 0, 'same selected IDs need no buffer upload');
    const zoomed = fixture.render({ ...A_VIEW, x: 120, scale: 8 });
    assert.equal(zoomed.stats.cacheHits, 1, 'a proved contained zoom-in still reuses');
    assert.ok(zoomed.stats.selectionReuse.incremental >= 1);
    const movedToB = fixture.render({ ...A_VIEW, x: 900, y: 900 });
    assert.equal(movedToB.indexUploadBytes, 2000);
    const page = fixture.renderer.pages.points[0];
    assert.ok(Array.from(page.indices.subarray(0, page.indexCount)).every(index => index % 2 === 1));
  } finally { fixture.dispose(); }
});

test('spatial toggles and later appends rebuild from all old geometry without missing new points', () => {  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    renderer.setAdaptive(false);
    renderer.setOptimizationOptions({ spatial: false });
    append(renderer, twoClusters(1000));
    assert.equal(fixture.render(A_VIEW).stats.pointsSubmitted, 1000);
    renderer.setOptimizationOptions({ spatial: true });
    assert.equal(fixture.render(A_VIEW).stats.pointsSubmitted, 500);
    renderer.setOptimizationOptions({ spatial: false });
    append(renderer, points(20, () => [100, 100], 1001));
    renderer.setOptimizationOptions({ spatial: true });
    assert.equal(fixture.render(A_VIEW).stats.pointsSubmitted, 520);
    append(renderer, points(20, () => [100, 100], 1021));
    assert.equal(fixture.render(A_VIEW).stats.pointsSubmitted, 540);
    const page = renderer.pages.points[0];
    const selected = Array.from(page.indices.subarray(0, page.indexCount));
    assert.ok(selected.includes(0));
    assert.ok(selected.includes(1000));
    assert.ok(selected.includes(1039));
  } finally { fixture.dispose(); }
});

test('partial spatial selection and contained-page LOD can alternate without stale memberships', () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    const group = points(60000, i => [i % 2 ? 1000000 : 0, 0]);
    group.colors.set(ALERT, 4); // Offscreen alert is retained by LOD only when its page is contained.
    append(renderer, group);
    const partial = { x: 0, y: 0, scale: 0.001, heading: 0 };
    assert.equal(fixture.render(partial).stats.pointsSubmitted, 3750);
    assert.equal(fixture.render({ ...partial, scale: 0.0001 }).stats.pointsSubmitted, 3751);
    const returned = fixture.render(partial);
    assert.equal(returned.stats.pointsSubmitted, 3750);
    assert.equal(returned.stats.pointAlertsDrawn, 0);
    assert.ok(returned.indexUploadBytes > 0);
  } finally { fixture.dispose(); }
});

function primitiveGroup(kind, size) {
  const vertices = [];
  // Nine visible primitives with equal centers prevent a split before the first
  // distant primitive arrives. A later visible primitive tests sorted draw order.
  const visible = size === 2 ? [-100, 0, 100, 0] : [-100, -20, 100, -20, 0, 100];
  for (let i = 0; i < 9; i++) vertices.push(...visible);
  for (let i = 0; i < 10; i++) {
    if (size === 2) vertices.push(1000 + i, 0, 1010 + i, 0);
    else vertices.push(1000 + i, 0, 1010 + i, 0, 1005 + i, 10);
  }
  vertices.push(...visible);
  const count = vertices.length / 2;
  const colors = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) colors.set(NORMAL, i * 4);
  return { kind, positions: new Float32Array(vertices), colors,
    ids: Uint32Array.from({ length: count }, (_, i) => 1 + Math.floor(i / size)) };
}

test('lines crossing the viewport keep both endpoints; triangles stay whole and preserve transparency order', () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    renderer.setOptimizationOptions({ leafSize: 8 });
    append(renderer, primitiveGroup('lines', 2), primitiveGroup('polygons', 3));
    const result = fixture.render({ x: 0, y: 0, scale: 6, heading: 0 });
    assert.equal(result.drawCalls, 2);
    for (const [kind, size] of [['lines', 2], ['polygons', 3]]) {
      const page = renderer.pages[kind][0];
      const selected = Array.from(page.indices.subarray(0, page.indexCount));
      assert.equal(page.indexCount, 10 * size);
      for (let i = 0; i < selected.length; i++) {
        if (i) assert.ok(selected[i] > selected[i - 1]);
        if (i % size) assert.equal(selected[i], selected[i - 1] + 1);
        else assert.equal(selected[i] % size, 0);
      }
      assert.equal(selected.at(-1), 20 * size - 1);
    }
    assert.equal(fixture.gl.draws[0].mode, fixture.gl.TRIANGLES);
    assert.equal(fixture.gl.draws[1].mode, fixture.gl.LINES);
  } finally { fixture.dispose(); }
});

test('context restoration uploads selected indices again and permits commit acknowledgement', async () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    renderer.setAdaptive(false);
    append(renderer, twoClusters(2000));
    fixture.render(A_VIEW);
    let prevented = false;
    renderer.canvas.events.webglcontextlost({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(renderer.contextLost, true);
    assert.equal(renderer.pages.points[0].selection, null);
    renderer.canvas.events.webglcontextrestored();
    const restored = fixture.render(A_VIEW);
    assert.equal(restored.stats.pointsSubmitted, 1000);
    assert.equal(restored.indexUploadBytes, 2000);
    assert.equal(restored.uploads.filter(upload => upload.channel === 'position')
      .reduce((sum, upload) => sum + upload.byteLength, 0), 16000);
    await renderer.awaitCommit(renderer.getStats().stagingRevision);
  } finally { fixture.dispose(); }
});

test('WebGL2 page tail 65534 remains drawable and no uint16 selection uses restart index 65535', () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    fixture.gl.createVertexArray = () => ({});
    fixture.gl.bindVertexArray = () => {};
    fixture.gl.deleteVertexArray = () => {};
    renderer.setAdaptive(false);
    append(renderer, points(65536, i => [i >= 65534 ? 0 : 1000000, 0]));
    const result = fixture.render({ x: 0, y: 0, scale: 6, heading: 0 });
    assert.equal(renderer._pipeline.webgl2, true);
    assert.equal(result.stats.pointsSubmitted, 2);
    assert.deepEqual(renderer.pages.points.map(page => page.count), [65535, 1]);
    const first = renderer.pages.points[0];
    assert.equal(first.indexCount, 1);
    assert.equal(first.indices[0], 65534);
    for (const page of renderer.pages.points) {
      assert.ok(Array.from(page.indices.subarray(0, page.indexCount)).every(index => index < 65535));
    }
  } finally { fixture.dispose(); }
});

test('page boundaries contain complete line pairs and triangle triples', () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    renderer.setOptimizationOptions({ spatial: false });
    const groups = [['lines', 65536], ['polygons', 65538]].map(([kind, count]) => ({
      kind, positions: new Float32Array(count * 2), colors: new Uint8Array(count * 4),
      ids: new Uint32Array(count)
    }));
    append(renderer, ...groups);
    fixture.render();
    assert.deepEqual(renderer.pages.lines.map(page => page.count), [65534, 2]);
    assert.deepEqual(renderer.pages.polygons.map(page => page.count), [65535, 3]);
    assert.ok(renderer.pages.lines.every(page => page.count % 2 === 0));
    assert.ok(renderer.pages.polygons.every(page => page.count % 3 === 0));
  } finally { fixture.dispose(); }
});

test('settled policy draws whole partial pages while moving, refines after three unchanged frames, and caches', () => {
  const fixture = createRecorder();
  try {
    const renderer = fixture.renderer;
    assert.equal(renderer.optimization.spatialPolicy, 'settled');
    assert.equal(renderer.optimization.settleFrames, 3);
    renderer.setOptimizationOptions({ maxCandidateRatio: 1 });
    renderer.setAdaptive(false);
    append(renderer, twoClusters(2000));
    renderer.trackFeatures([1]);
    for (let i = 0; i < 3; i++) {
      const settling = fixture.render(A_VIEW);
      assert.equal(settling.stats.pointsSubmitted, 2000);
      assert.equal(settling.stats.nodesTested, 0);
      assert.equal(settling.indexUploadBytes, 0);
      assert.equal(fixture.gl.draws[0].indexed, false);
    }
    const refined = fixture.render(A_VIEW);
    assert.equal(refined.stats.pointsSubmitted, 1000);
    assert.ok(refined.stats.nodesTested > 0);
    assert.equal(refined.indexUploadBytes, 2000);
    const cached = fixture.render(A_VIEW);
    assert.equal(cached.stats.pointsSubmitted, 1000);
    assert.equal(cached.stats.cacheHits, 1);
    assert.equal(cached.indexUploadBytes, 0);
    renderer.updateFeatureColors([{ id: 1, color: ALERT }]);
    const alarm = fixture.render(A_VIEW);
    assert.equal(alarm.stats.pointsSubmitted, 1000);
    assert.equal(alarm.stats.pointAlertsDrawn, 1);
    assert.equal(alarm.colorUploadBytes, 4);
    assert.equal(alarm.uploads.filter(upload => upload.channel === 'position').length, 0);
    assert.deepEqual(Array.from(renderer.pages.points[0].positions.subarray(0, 2)), [90, 90]);
    append(renderer, points(1, () => [100, 100], 2001));
    const appended = fixture.render(A_VIEW);
    assert.equal(appended.stats.pointsSubmitted, 2001, 'changed data falls back to the full current page');
    assert.equal(appended.stats.pointAlertsDrawn, 1);
    assert.equal(fixture.gl.draws[0].indexed, false);
    fixture.render(A_VIEW);
    fixture.render(A_VIEW);
    const resettled = fixture.render(A_VIEW);
    assert.equal(resettled.stats.pointsSubmitted, 1001);
    assert.ok(Array.from(renderer.pages.points[0].indices.subarray(0, 1001)).includes(2000));
    const moving = fixture.render({ ...A_VIEW, x: 900, y: 900 });
    assert.equal(moving.stats.pointsSubmitted, 2001);
    assert.equal(moving.stats.nodesTested, 0);
    assert.equal(fixture.gl.draws[0].indexed, false);
    fixture.render({ ...A_VIEW, x: 900, y: 900 });
    fixture.render({ ...A_VIEW, x: 900, y: 900 });
    const settledB = fixture.render({ ...A_VIEW, x: 900, y: 900 });
    assert.equal(settledB.stats.pointsSubmitted, 1000);
    assert.equal(settledB.stats.pointAlertsDrawn, 0);
  } finally { fixture.dispose(); }
});

test('settled policy preserves alert LOD membership through color updates and append fallback', () => {
  const fixture = createRecorder();
  try {
    const renderer = fixture.renderer;
    renderer.setOptimizationOptions({ maxCandidateRatio: 1 });
    const group = points(60000, i => [i % 2 ? 1000000 : 0, 0]);
    group.colors.set(ALERT, 4); // Offscreen, nonsampled point still survives the coarse LOD payload.
    append(renderer, group);
    renderer.trackFeatures([101]);
    const camera = { x: 0, y: 0, scale: 0.005, heading: 0 };
    assert.equal(fixture.render(camera).stats.pointAlertsDrawn, 1);
    fixture.render(camera);
    fixture.render(camera);
    assert.equal(fixture.render(camera).stats.pointAlertsDrawn, 0);
    renderer.updateFeatureColors([{ id: 101, color: ALERT }]);
    const promoted = fixture.render(camera);
    assert.equal(promoted.stats.pointAlertsDrawn, 1);
    assert.equal(promoted.colorUploadBytes, 4);
    assert.equal(promoted.uploads.filter(upload => upload.channel === 'position').length, 0);
    const page = renderer.pages.points[0];
    assert.ok(Array.from(page.indices.subarray(0, page.indexCount)).includes(100));
    const appendedAlert = points(1, () => [0, 0], 60001);
    appendedAlert.colors.set(ALERT);
    append(renderer, appendedAlert);
    const fallback = fixture.render(camera);
    assert.equal(fallback.stats.pointAlertsDrawn, 3);
    assert.equal(fallback.stats.nodesTested, 0);
    const fallbackIndices = Array.from(page.indices.subarray(0, page.indexCount));
    assert.ok(fallbackIndices.includes(1));
    assert.ok(fallbackIndices.includes(100));
    assert.ok(fallbackIndices.includes(60000));
    fixture.render(camera);
    fixture.render(camera);
    const resettled = fixture.render(camera);
    assert.equal(resettled.stats.pointAlertsDrawn, 2);
    const selected = Array.from(page.indices.subarray(0, page.indexCount));
    assert.equal(selected.includes(1), false);
    assert.ok(selected.includes(100));
    assert.ok(selected.includes(60000));
  } finally { fixture.dispose(); }
});

test('nondegenerate clustered leaves conservatively include every visible point with no duplicate indices', () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    renderer.setAdaptive(false);
    append(renderer, points(2000, i => {
      const center = i % 2 ? 900 : 100;
      const pair = Math.floor(i / 2);
      return [center - 10 + pair % 21, center - 10 + Math.floor(pair / 21) % 21];
    }));
    const result = fixture.render(A_VIEW);
    const page = renderer.pages.points[0];
    const selected = Array.from(page.indices.subarray(0, page.indexCount));
    const selectedSet = new Set(selected);
    assert.equal(selectedSet.size, selected.length);
    for (let index = 0; index < 2000; index += 2) assert.ok(selectedSet.has(index));
    assert.ok(result.stats.pointsSubmitted >= 1000);
    assert.ok(result.stats.pointsSubmitted <= 2000);
    assert.ok(selected.every((index, i) => i === 0 || index > selected[i - 1]));
  } finally { fixture.dispose(); }
});

test('default candidate ratio rejects expensive dense selections without new indices or missing alert payloads', () => {
  const fixture = createRecorder();
  try {
    const renderer = fixture.renderer;
    assert.equal(renderer.optimization.maxCandidateRatio, 0.15);
    renderer.setAdaptive(false);
    const group = twoClusters(2000);
    group.colors.set(ALERT, 0);
    group.colors.set(ALERT, 4);
    append(renderer, group);
    renderer.trackFeatures([101]);
    for (let i = 0; i < 5; i++) {
      const frame = fixture.render(A_VIEW);
      assert.equal(frame.stats.pointsSubmitted, 2000);
      assert.equal(frame.stats.pointAlertsDrawn, 2);
      assert.equal(frame.indexUploadBytes, 0);
      assert.equal(fixture.gl.draws[0].indexed, false);
    }
    renderer.updateFeatureColors([{ id: 101, color: ALERT }]);
    const alarm = fixture.render(A_VIEW);
    assert.equal(alarm.stats.pointsSubmitted, 2000);
    assert.equal(alarm.stats.pointAlertsDrawn, 3);
    assert.equal(alarm.indexUploadBytes, 0);
    assert.equal(alarm.colorUploadBytes, 4);
    assert.equal(alarm.uploads.filter(upload => upload.channel === 'position').length, 0);
  } finally { fixture.dispose(); }
});

test('default candidate ratio still refines a sparse viewport after settling and reuses its indices', () => {
  const fixture = createRecorder();
  try {
    const renderer = fixture.renderer;
    renderer.setAdaptive(false);
    append(renderer, points(2000, i => i < 20 ? [90 + i, 100] : [900 + i % 20, 900]));
    for (let i = 0; i < 3; i++) assert.equal(fixture.render(A_VIEW).stats.pointsSubmitted, 2000);
    const refined = fixture.render(A_VIEW);
    assert.equal(refined.stats.pointsSubmitted, 20);
    assert.equal(refined.indexUploadBytes, 40);
    assert.equal(fixture.gl.draws[0].indexed, true);
    const page = renderer.pages.points[0];
    assert.deepEqual(Array.from(page.indices.subarray(0, page.indexCount)), Array.from({ length: 20 }, (_, i) => i));
    const cached = fixture.render(A_VIEW);
    assert.equal(cached.stats.pointsSubmitted, 20);
    assert.equal(cached.indexUploadBytes, 0);
    assert.equal(cached.stats.cacheHits, 1);
  } finally { fixture.dispose(); }
});

test('runtime candidate ratio and LOD switches preserve memberships, including both context restoration paths', async () => {
  const fixture = createRecorder();
  try {
    const renderer = fixture.renderer;
    renderer.setOptimizationOptions({ spatialPolicy: 'always' });
    const group = points(50000, i => [i % 2 ? 1000000 : 0, 0]);
    group.colors.set(ALERT, 4);
    append(renderer, group);
    const camera = { x: 0, y: 0, scale: 0.005, heading: 0 };
    const coarseLOD = fixture.render(camera);
    assert.equal(coarseLOD.stats.pointsSubmitted, 3126);
    assert.equal(coarseLOD.stats.pointAlertsDrawn, 1);
    const page = renderer.pages.points[0];
    assert.ok(Array.from(page.indices.subarray(0, page.indexCount)).includes(1));
    renderer.setOptimizationOptions({ maxCandidateRatio: 1 });
    const spatialLOD = fixture.render(camera);
    assert.equal(spatialLOD.stats.pointsSubmitted, 3125);
    assert.equal(spatialLOD.stats.pointAlertsDrawn, 0);
    assert.equal(Array.from(page.indices.subarray(0, page.indexCount)).includes(1), false);
    assert.equal(spatialLOD.uploads.filter(upload => upload.channel === 'position').length, 0);
    renderer.setOptimizationOptions({ maxCandidateRatio: 0.15 });
    const returned = fixture.render(camera);
    assert.equal(returned.stats.pointsSubmitted, 3126);
    assert.equal(returned.stats.pointAlertsDrawn, 1);
    assert.ok(Array.from(page.indices.subarray(0, page.indexCount)).includes(1));
    renderer.canvas.events.webglcontextlost({ preventDefault() {} });
    renderer.canvas.events.webglcontextrestored();
    const restoredCoarse = fixture.render(camera);
    assert.equal(restoredCoarse.stats.pointsSubmitted, 3126);
    assert.equal(restoredCoarse.stats.pointAlertsDrawn, 1);
    assert.equal(restoredCoarse.indexUploadBytes, 3126 * 2);
    await renderer.awaitCommit(renderer.getStats().stagingRevision);
    renderer.setAdaptive(false);
    const full = fixture.render(camera);
    assert.equal(full.stats.pointsSubmitted, 50000);
    assert.equal(full.stats.pointAlertsDrawn, 1);
    assert.equal(full.indexUploadBytes, 0);
    assert.equal(fixture.gl.draws[0].indexed, false);
    renderer.setOptimizationOptions({ maxCandidateRatio: 1 });
    assert.equal(fixture.render(camera).stats.pointsSubmitted, 25000);
    renderer.setAdaptive(true);
    const resampled = fixture.render(camera);
    assert.equal(resampled.stats.pointsSubmitted, 3125);
    assert.equal(resampled.stats.pointAlertsDrawn, 0);
    assert.equal(resampled.uploads.filter(upload => upload.channel === 'position').length, 0);
    renderer.canvas.events.webglcontextlost({ preventDefault() {} });
    renderer.canvas.events.webglcontextrestored();
    const restoredSpatial = fixture.render(camera);
    assert.equal(restoredSpatial.stats.pointsSubmitted, 3125);
    assert.equal(restoredSpatial.stats.pointAlertsDrawn, 0);
    assert.equal(restoredSpatial.indexUploadBytes, 3125 * 2);
    await renderer.awaitCommit(renderer.getStats().stagingRevision);
  } finally { fixture.dispose(); }
});
