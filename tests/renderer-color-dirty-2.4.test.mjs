import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingRenderer } from './helpers/recording-renderer.mjs';

const BASE = [20, 130, 220, 173], A = [40, 150, 230, 191], B = [41, 151, 231, 127];
function points(count, firstID = 1) {
  const positions = new Float32Array(count * 2), colors = new Uint8Array(count * 4), ids = new Uint32Array(count);
  for (let i = 0; i < count; i++) { positions.set([i % 64, Math.floor(i / 64)], i * 2); colors.set(BASE, i * 4); ids[i] = firstID + i; }
  return { groups: [{ kind: 'points', positions, colors, ids, featureCount: count }] };
}
function fixture(count = 2048, policy = 'accumulator') {
  const f = createRecordingRenderer(); f.renderer.setAdaptive(false);
  f.renderer.setOptimizationOptions({ spatial: false, colorUploadPolicy: policy });
  f.renderer.append(points(count)); f.render(); return f;
}
const covered = (frame, byte) => frame.uploads.some(u => u.channel === 'color' && u.offset <= byte && u.offset + u.byteLength >= byte + 4);

test('pending RGBA changes survive density/accumulator/legacy policy migration in both directions', () => {
  for (const sequence of [['density', 'accumulator'], ['accumulator', 'density'], ['accumulator', 'legacy'], ['density', 'accumulator', 'legacy', 'accumulator']]) {
    const f = fixture(2048, sequence[0]);
    try {
      const r = f.renderer; r.trackFeatures([1, 1500]); r.updateFeatureColors([{ id: 1, color: A }, { id: 1500, color: B }]);
      for (const colorUploadPolicy of sequence.slice(1)) r.setOptimizationOptions({ colorUploadPolicy });
      const frame = f.render(); assert.equal(frame.colorUploadBytes, 8); assert.equal(frame.colorUploadCalls, 2);
      assert.ok(covered(frame, 0)); assert.ok(covered(frame, 1499 * 4));
      assert.deepEqual([...r.pages.points[0].colors.subarray(0, 4)], A);
      assert.deepEqual([...r.pages.points[0].colors.subarray(1499 * 4, 1500 * 4)], B);
      assert.equal(f.render().colorUploadBytes, 0);
    } finally { f.dispose(); }
  }
});
test('color updated during GL submission invalidates token and stays queued until next upload', () => {
  const f = fixture(2048);
  try {
    const r = f.renderer, page = r.pages.points[0], submit = f.gl.bufferSubData.bind(f.gl); r.trackFeatures([1]);
    r.updateFeatureColors([{ id: 1, color: A }]); const captured = []; let injected = false;
    f.gl.bufferSubData = (target, offset, data) => {
      const color = f.gl.bindings[target] === page.gpu.color;
      if (color) captured.push([...data]);
      const result = submit(target, offset, data);
      if (color && !injected) { injected = true; r.updateFeatureColors([{ id: 1, color: B }]); }
      return result;
    };
    f.gl.resetMeasurements(); r._upload(page);
    assert.deepEqual(captured[0], A); assert.equal(page.colorDirtyState.pendingUniqueVertices, 1);
    assert.equal(r.getCommitStats().pendingGeometryPages, 1); r._upload(page);
    assert.deepEqual(captured.at(-1), B); assert.equal(page.colorDirtyState.pendingUniqueVertices, 0);
    assert.equal(r.getCommitStats().pendingGeometryPages, 0);
  } finally { f.dispose(); }
});
test('position GL failure after color submission keeps accumulator marks and both channels retry', () => {
  const f = fixture(2048);
  try {
    const r = f.renderer, page = r.pages.points[0], submit = f.gl.bufferSubData.bind(f.gl); r.trackFeatures([1]);
    r.updateFeatureColors([{ id: 1, color: A }]); r.updateFeaturePositions([{ id: 1, x: 123, y: 456 }]);
    let fail = true;
    f.gl.bufferSubData = (target, offset, data) => {
      if (fail && f.gl.bindings[target] === page.gpu.position) { fail = false; throw new Error('injected position upload failure'); }
      return submit(target, offset, data);
    };
    assert.throws(() => r._upload(page), /position upload failure/);
    assert.equal(page.colorDirtyState.pendingUniqueVertices, 1); assert.equal(page.positionDirtyRanges.length, 1);
    assert.equal(r.getCommitStats().pendingGeometryPages, 1); f.gl.resetMeasurements(); r._upload(page);
    assert.equal(page.colorDirtyState.pendingUniqueVertices, 0); assert.equal(page.positionDirtyRanges.length, 0);
    assert.equal(r.getCommitStats().pendingGeometryPages, 0);
    assert.ok(f.gl.uploads.some(u => u.buffer === page.gpu.color && u.byteLength === 4));
    assert.ok(f.gl.uploads.some(u => u.buffer === page.gpu.position && u.byteLength === 8));
  } finally { f.dispose(); }
});
test('old prefix dirty colors and same-frame append tail preserve nonopaque RGBA and watermark', () => {
  const f = fixture(1024);
  try {
    const r = f.renderer; r.trackFeatures(Array.from({ length: 768 }, (_, i) => 513 + i));
    r.updateFeatureColors(Array.from({ length: 512 }, (_, i) => ({ id: 513 + i, color: A })));
    r.append(points(256, 1025)); r.updateFeatureColors(Array.from({ length: 256 }, (_, i) => ({ id: 1025 + i, color: B })));
    const frame = f.render(), page = r.pages.points[0];
    assert.equal(page.uploaded, 1280); assert.equal(page.colorDirtyState.pendingUniqueVertices, 0);
    assert.ok(covered(frame, 512 * 4)); assert.ok(covered(frame, 1024 * 4)); assert.ok(covered(frame, 1279 * 4));
    for (let slot = 512; slot < 1024; slot++) assert.deepEqual([...page.colors.subarray(slot * 4, slot * 4 + 4)], A);
    for (let slot = 1024; slot < 1280; slot++) assert.deepEqual([...page.colors.subarray(slot * 4, slot * 4 + 4)], B);
    assert.equal(f.render().uploadBytes, 0);
  } finally { f.dispose(); }
});
test('GPU context replacement fully reloads latest CPU colors and clears obsolete prefix marks', () => {
  const f = fixture(2048);
  try {
    const r = f.renderer; r.trackFeatures([1, 2000]); r.updateFeatureColors([{ id: 1, color: A }, { id: 2000, color: B }]);
    r._deleteGPU(); const frame = f.render(), page = r.pages.points[0];
    assert.equal(frame.colorUploadBytes, 2048 * 4); assert.equal(page.uploaded, 2048);
    assert.equal(page.colorDirtyState.pendingUniqueVertices, 0);
    assert.deepEqual([...page.colors.subarray(0, 4)], A); assert.deepEqual([...page.colors.subarray(1999 * 4, 2000 * 4)], B);
    assert.equal(f.render().uploadBytes, 0);
  } finally { f.dispose(); }
});
test('dense remove/restore uses accumulator markers and restores saved nonopaque RGBA exactly', () => {
  const f = fixture(2048);
  try {
    const r = f.renderer, ids = Array.from({ length: 1024 }, (_, i) => i + 1); r.trackFeatures(ids);
    r.updateFeatureColors(ids.map(id => ({ id, color: id % 2 ? A : B }))); f.render();
    const before = r.pages.points[0].colors.slice(0, 1024 * 4);
    r.removeFeatures(ids); let frame = f.render(); assert.ok(frame.colorUploadBytes > 0);
    for (let slot = 0; slot < 1024; slot++) assert.equal(r.pages.points[0].colors[slot * 4 + 3], 0);
    r.restoreFeatures(ids); frame = f.render(); assert.ok(frame.colorUploadBytes > 0);
    assert.deepEqual(r.pages.points[0].colors.slice(0, 1024 * 4), before);
    assert.equal(r.pages.points[0].colorDirtyState.pendingUniqueVertices, 0);
  } finally { f.dispose(); }
});
