import test from 'node:test';
import assert from 'node:assert/strict';
import { GeoRenderer } from '../public/js/renderer.js';

// A recording WebGL contract double, not a software renderer.
// Browser QA is still required to verify real shader compilation/GPU output.
class Element {
  constructor(tag) {
    this.tagName = tag;
    this.style = {};
    this.children = [];
    this.events = {};
    this.isConnected = false;
    this.width = 0;
    this.height = 0;
  }
  appendChild(element) {
    if (element.parent) element.remove();
    this.children.push(element);
    element.parent = this;
    element.isConnected = true;
    return element;
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
    this.isConnected = false;
  }
  setAttribute() {}
  addEventListener(type, listener) { this.events[type] = listener; }
  removeEventListener(type) { delete this.events[type]; }
  getBoundingClientRect() { return { width: 800, height: 600, left: 0, top: 0 }; }
  getContext() { return this.gl ||= new RecordingGL(this); }
  setPointerCapture() {}
  hasPointerCapture() { return false; }
  releasePointerCapture() {}
}

class RecordingGL {
  constructor(canvas) {
    this.canvas = canvas;
    this.calls = [];
    this.uploads = [];
    this.bindings = {};
    this.attributes = {};
    this.draws = [];
    const constants = [
      'VERTEX_SHADER', 'FRAGMENT_SHADER', 'COMPILE_STATUS', 'LINK_STATUS',
      'ALIASED_POINT_SIZE_RANGE', 'ARRAY_BUFFER', 'ELEMENT_ARRAY_BUFFER',
      'DYNAMIC_DRAW', 'DEPTH_TEST', 'CULL_FACE', 'BLEND', 'SRC_ALPHA',
      'ONE_MINUS_SRC_ALPHA', 'COLOR_BUFFER_BIT', 'FLOAT', 'UNSIGNED_BYTE',
      'POINTS', 'LINES', 'TRIANGLES', 'UNSIGNED_SHORT'
    ];
    constants.forEach((name, index) => { this[name] = index + 1; });
  }
  createShader(type) { return { type }; }
  shaderSource(shader, source) { shader.source = source; }
  compileShader() {}
  getShaderParameter() { return true; }
  getShaderInfoLog() { return ''; }
  deleteShader() {}
  createProgram() { return {}; }
  attachShader() {}
  linkProgram() {}
  getProgramParameter() { return true; }
  getProgramInfoLog() { return ''; }
  deleteProgram() {}
  getUniformLocation(_program, name) { return name; }
  getAttribLocation(_program, name) { return name === 'a_position' ? 0 : 1; }
  getParameter() { return [1, 64]; }
  getExtension() { return null; }
  isContextLost() { return false; }
  createBuffer() { return {}; }
  deleteBuffer(buffer) { this.calls.push(['deleteBuffer', buffer]); }
  bindBuffer(target, buffer) { this.bindings[target] = buffer; }
  bufferData(target, size) {
    assert.equal(typeof size, 'number', 'GPU page allocation uses a fixed byte size');
    this.bindings[target].bytes = new Uint8Array(size);
    this.calls.push(['bufferData', target, size]);
  }
  bufferSubData(target, offset, data) {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.bindings[target].bytes.set(bytes, offset);
    this.calls.push(['bufferSubData', target, offset, data.byteLength]);
    this.uploads.push({ target, buffer: this.bindings[target], offset, bytes: bytes.slice() });
  }
  viewport(...args) { this.calls.push(['viewport', ...args]); }
  disable(...args) { this.calls.push(['disable', ...args]); }
  enable(...args) { this.calls.push(['enable', ...args]); }
  blendFunc(...args) { this.calls.push(['blendFunc', ...args]); }
  clearColor(...args) { this.calls.push(['clearColor', ...args]); }
  clear(...args) { this.calls.push(['clear', ...args]); }
  useProgram() {}
  uniformMatrix4fv(location, transpose, matrix) { this.calls.push(['uniformMatrix4fv', location, transpose, Array.from(matrix)]); }
  uniform1f() {}
  enableVertexAttribArray() {}
  vertexAttribPointer(location, size, type) {
    this.attributes[location] = { buffer: this.bindings[this.ARRAY_BUFFER], size, type };
  }
  drawArrays(mode, first, count) {
    this.calls.push(['drawArrays', mode, first, count]);
    this.draws.push({ mode, count, first, position: this.attributes[0].buffer });
  }
  drawElements(mode, count, type, offset) {
    this.calls.push(['drawElements', mode, count, type, offset]);
    this.draws.push({
      mode, count, position: this.attributes[0].buffer,
      indices: new Uint16Array(this.bindings[this.ELEMENT_ARRAY_BUFFER].bytes.buffer, offset, count).slice()
    });
  }
}

function fixture(t) {
  let nextRAF = 0;
  let time = performance.now();
  const raf = new Map();
  const globals = ['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver'];
  const previous = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = { createElement: (tag) => new Element(tag), head: new Element('head') };
  globalThis.requestAnimationFrame = (callback) => { raf.set(++nextRAF, callback); return nextRAF; };
  globalThis.cancelAnimationFrame = (id) => raf.delete(id);
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  const container = new Element('div');
  const frames = [];
  const interactions = [];
  const renderer = new GeoRenderer(container, {
    onFrame: (frame) => frames.push(frame),
    onInteraction: (event) => interactions.push(event)
  });
  const canvas = container.children[0];
  const gl = canvas.gl;
  const tick = () => {
    const callbacks = [...raf.values()];
    raf.clear();
    time += 16.667;
    callbacks.forEach((callback) => callback(time));
    return frames.at(-1);
  };
  t.after(() => {
    renderer.destroy();
    for (const name of globals) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return { renderer, container, canvas, gl, raf, tick, frames, interactions };
}

function batch(count, kind = 'points', idOffset = 0) {
  const positions = new Float32Array(count * 2);
  const colors = new Uint8Array(count * 4);
  const ids = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 2] = (i % 100) * 2;
    positions[i * 2 + 1] = (i % 80) * 2;
    colors.set([82, 212, 200, 255], i * 4);
    ids[i] = idOffset + i;
  }
  return { groups: [{ kind, positions, colors, ids, featureCount: count }], featureCount: count };
}

test('append uploads only the new vertex range and reuses allocated pages', (t) => {
  const { renderer, gl, tick } = fixture(t);
  renderer.append(batch(1000, 'point'));
  assert.equal(tick().vertices, 1000);
  const allocations = gl.calls.filter((call) => call[0] === 'bufferData').length;
  const marker = gl.calls.length;
  const fragment = batch(2, 'point', 1000);
  fragment.groups[0].featureCount = 0;
  fragment.featureCount = 0;
  renderer.append(fragment);
  const frame = tick();
  assert.equal(frame.totalVertices, 1002);
  assert.equal(frame.features, 1000, 'zero featureCount still uploads drawable vertices');
  assert.equal(gl.calls.filter((call) => call[0] === 'bufferData').length, allocations);
  assert.deepEqual(
    gl.calls.slice(marker).filter((call) => call[0] === 'bufferSubData').map((call) => call.slice(2)),
    [[8000, 16], [4000, 8]]
  );
});

test('subscribed color updates commit only RGBA bytes without adding geometry', async (t) => {
  const { renderer, gl, tick } = fixture(t);
  renderer.append(batch(10, 'point', 1));
  tick();
  assert.equal(renderer._featureBindings.size, 0, 'ordinary loading creates no feature index');
  assert.deepEqual(renderer.trackFeatures([4, 999]), { tracked: 2, bound: 1 });
  const page = renderer.pages.points[0];
  const positions = page.gpu.position.bytes.slice();
  const colors = page.gpu.color.bytes.slice();
  const before = renderer.getStats();
  const marker = gl.uploads.length;
  const allocations = gl.calls.filter(call => call[0] === 'bufferData').length;
  const result = renderer.updateFeatureColors([
    { id: 4, color: [255, 214, 82, 238] },
    { id: 999, color: [255, 70, 90, 245] },
    { id: 5, color: [255, 70, 90, 245] }
  ]);
  assert.equal(result.updated, 1);
  assert.equal(result.updatedVertices, 1);
  assert.equal(result.ignored, 2, 'missing and unsubscribed IDs are safely ignored');
  assert.equal(result.revision, before.stagingRevision + 1);
  for (const field of ['features', 'totalVertices', 'pointVertices', 'cpuBytes', 'gpuBytes', 'pages']) {
    assert.equal(result[field], before[field], `${field} is unchanged by recoloring`);
  }
  let settled = false;
  const committing = renderer.awaitCommit(result.revision).then(stats => { settled = true; return stats; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(gl.uploads.length, marker, 'CPU color staging does not acknowledge GL submission');
  tick();
  assert.equal((await committing).committedRevision, result.revision);
  const uploads = gl.uploads.slice(marker);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].buffer, page.gpu.color);
  assert.equal(uploads[0].offset, 12);
  assert.deepEqual([...uploads[0].bytes], [255, 214, 82, 238]);
  assert.deepEqual(page.gpu.position.bytes, positions, 'the position buffer is untouched');
  colors.set([255, 214, 82, 238], 12);
  assert.deepEqual(page.gpu.color.bytes, colors, 'only the subscribed vertex color changes');
  assert.equal(renderer.getStats().uploadedBytes, before.uploadedBytes + 4);
  assert.equal(gl.calls.filter(call => call[0] === 'bufferData').length, allocations);
  const unchanged = renderer.updateFeatureColors([{ id: 4, color: [255, 214, 82, 238] }]);
  assert.equal(unchanged.updated, 0);
  assert.equal(unchanged.unchanged, 1);
  assert.equal(unchanged.revision, result.revision);
  tick();
  assert.equal(gl.uploads.length, marker + 1, 'identical colors do not generate another upload');
});

test('subscription limits and invalid colors reject atomically without harming pending commits', async (t) => {
  const { renderer, tick } = fixture(t);
  const appended = renderer.append(batch(3, 'point', 1));
  renderer.trackFeatures([1, 2]);
  const colors = renderer.pages.points[0].colors.slice();
  assert.throws(() => renderer.trackFeatures(Array.from({ length: 4097 }, (_, index) => index)), /4096/);
  assert.throws(() => renderer.trackFeatures([1, -1]), /uint32/);
  assert.equal(renderer._trackedFeatureIds.size, 2, 'invalid subscriptions preserve the previous set');
  for (const color of [[NaN, 2, 3, 4], [Infinity, 2, 3, 4], [-1, 2, 3, 4], [256, 2, 3, 4], [1.5, 2, 3, 4], [1, 2, 3]]) {
    assert.throws(() => renderer.updateFeatureColors([
      { id: 1, color: [255, 70, 90, 245] }, { id: 2, color }
    ]), /RGBA/);
    assert.deepEqual(renderer.pages.points[0].colors, colors);
    assert.equal(renderer.getStats().stagingRevision, appended.revision);
  }
  const committing = renderer.awaitCommit(appended.revision);
  tick();
  assert.equal((await committing).committedRevision, appended.revision);
  assert.deepEqual(renderer.trackFeatures([]), { tracked: 0, bound: 0 });
  assert.equal(renderer.updateFeatureColors([{ id: 1, color: [255, 70, 90, 245] }]).ignored, 1);
});

test('subscriptions bind future multi-vertex features across pages and survive reset without stale bindings', async (t) => {
  const { renderer, gl, tick } = fixture(t);
  assert.deepEqual(renderer.trackFeatures([7, 11]), { tracked: 2, bound: 0 });
  const first = batch(65532, 'line');
  first.groups[0].ids.fill(100);
  renderer.append(first);
  tick();
  const crossing = batch(4, 'line');
  crossing.groups[0].ids.fill(7);
  renderer.append(crossing);
  tick();
  const before = renderer.getStats();
  const marker = gl.uploads.length;
  const result = renderer.updateFeatureColors([{ id: 7, color: [255, 70, 90, 245] }]);
  assert.equal(result.updated, 1);
  assert.equal(result.updatedVertices, 4);
  const committing = renderer.awaitCommit(result.revision);
  tick();
  await committing;
  assert.deepEqual(gl.uploads.slice(marker).map(upload => [upload.offset, upload.bytes.length]), [[65532 * 4, 8], [0, 8]]);
  assert.ok(gl.uploads.slice(marker).every(upload => renderer.pages.lines.some(page => upload.buffer === page.gpu.color)));
  for (const [page, start] of [[renderer.pages.lines[0], 65532], [renderer.pages.lines[1], 0]]) {
    assert.deepEqual([...page.gpu.color.bytes.subarray(start * 4, (start + 2) * 4)], [255, 70, 90, 245, 255, 70, 90, 245]);
  }
  assert.equal(renderer.getStats().uploadedBytes, before.uploadedBytes + 16);
  assert.equal(renderer.getStats().totalVertices, before.totalVertices);
  renderer.reset();
  assert.equal(renderer._featureBindings.size, 0);
  assert.equal(renderer._trackedFeatureIds.size, 2);
  assert.equal(renderer.updateFeatureColors([{ id: 7, color: [1, 2, 3, 4] }]).ignored, 1);
  const fresh = batch(2, 'line');
  fresh.groups[0].ids.fill(7);
  renderer.append(fresh);
  const freshUpdate = renderer.updateFeatureColors([{ id: 7, color: [1, 2, 3, 4] }]);
  assert.equal(freshUpdate.updatedVertices, 2);
  const freshCommit = renderer.awaitCommit(freshUpdate.revision);
  tick();
  await freshCommit;
  assert.deepEqual([...renderer.pages.lines[0].gpu.color.bytes.subarray(0, 8)], [1, 2, 3, 4, 1, 2, 3, 4]);
  renderer.destroy();
  assert.equal(renderer._featureBindings.size, 0);
  assert.equal(renderer._trackedFeatureIds.size, 0);
  assert.throws(() => renderer.trackFeatures([7]), /已销毁/);
  assert.throws(() => renderer.updateFeatureColors([]), /已销毁/);
});

test('color changes during append reuse new color uploads and submit only the old dirty range', async (t) => {
  const { renderer, gl, tick } = fixture(t);
  renderer.trackFeatures([1, 3]);
  renderer.append(batch(2, 'point', 1));
  tick();
  const page = renderer.pages.points[0];
  const before = renderer.getStats();
  const marker = gl.uploads.length;
  renderer.append(batch(2, 'point', 3));
  const update = renderer.updateFeatureColors([{ id: 1, color: [1, 2, 3, 4] }, { id: 3, color: [5, 6, 7, 8] }]);
  const committing = renderer.awaitCommit(update.revision);
  tick();
  await committing;
  assert.deepEqual(gl.uploads.slice(marker).map(upload => [upload.buffer === page.gpu.color ? 'color' : 'position', upload.offset, upload.bytes.length]), [
    ['position', 16, 16], ['color', 8, 8], ['color', 0, 4]
  ]);
  assert.deepEqual([...page.gpu.color.bytes.subarray(0, 4)], [1, 2, 3, 4]);
  assert.deepEqual([...page.gpu.color.bytes.subarray(8, 12)], [5, 6, 7, 8]);
  assert.equal(renderer.getStats().uploadedBytes, before.uploadedBytes + 28);
  assert.equal(renderer.getStats().totalVertices, 4);
});

test('tracking existing polygon pages recolors every triangle vertex across a page boundary', (t) => {
  const { renderer, gl, tick } = fixture(t);
  const input = batch(65538, 'polygon');
  input.groups[0].ids.fill(100);
  input.groups[0].ids.fill(11, 65532);
  renderer.append(input);
  tick();
  assert.deepEqual(renderer.trackFeatures([11]), { tracked: 1, bound: 1 });
  const before = renderer.getStats();
  const marker = gl.uploads.length;
  const update = renderer.updateFeatureColors([{ id: 11, color: new Uint8Array([255, 214, 82, 238]) }]);
  assert.equal(update.updatedVertices, 6);
  tick();
  assert.deepEqual(gl.uploads.slice(marker).map(upload => [upload.offset, upload.bytes.length]), [[65532 * 4, 12], [0, 12]]);
  assert.ok(gl.uploads.slice(marker).every(upload => renderer.pages.polygons.some(page => upload.buffer === page.gpu.color)));
  for (const [page, start] of [[renderer.pages.polygons[0], 65532], [renderer.pages.polygons[1], 0]]) {
    assert.deepEqual([...page.gpu.color.bytes.subarray(start * 4, (start + 3) * 4)], [255, 214, 82, 238, 255, 214, 82, 238, 255, 214, 82, 238]);
  }
  assert.equal(renderer.getStats().totalVertices, before.totalVertices);
  assert.equal(renderer.getStats().features, before.features);
  assert.equal(renderer.getStats().uploadedBytes, before.uploadedBytes + 24);
});

test('hidden and culled layers still commit color changes without extra draws', async (t) => {
  const { renderer, gl, tick } = fixture(t);
  renderer.append(batch(20, 'point', 1));
  tick();
  renderer.trackFeatures([5]);
  renderer.setLayers({ points: false });
  renderer.focus(1e9, 1e9);
  const draws = gl.draws.length;
  const marker = gl.uploads.length;
  const update = renderer.updateFeatureColors([{ id: 5, color: [255, 70, 90, 245] }]);
  const committing = renderer.awaitCommit(update.revision);
  assert.equal(tick().vertices, 0);
  assert.equal((await committing).committedRevision, update.revision);
  assert.equal(gl.draws.length, draws);
  assert.equal(gl.uploads.length, marker + 1);
  assert.equal(gl.uploads.at(-1).buffer, renderer.pages.points[0].gpu.color);
  assert.equal(gl.uploads.at(-1).offset, 16);
  assert.equal(gl.uploads.at(-1).bytes.length, 4);
});

test('page boundaries preserve complete lines and triangles and report actual draw calls', (t) => {
  const { renderer, gl, tick } = fixture(t);
  renderer.setAdaptive(false);
  renderer.append(batch(70000, 'points'));
  renderer.append(batch(4, 'line'));
  renderer.append(batch(12, 'polygon'));
  const frame = tick();
  assert.equal(frame.pages, 4);
  assert.equal(frame.vertices, 70016);
  assert.equal(frame.drawCalls, 4);
  assert.equal(frame.geometryDrawCalls, gl.draws.length);
  assert.deepEqual(gl.draws.filter((draw) => draw.mode === gl.POINTS).map((draw) => draw.count), [65535, 4465]);
  assert.ok(gl.draws.every((draw) => draw.count <= 65535));
  assert.ok(gl.draws.filter((draw) => draw.mode === gl.LINES).every((draw) => draw.count % 2 === 0));
  assert.ok(gl.draws.filter((draw) => draw.mode === gl.TRIANGLES).every((draw) => draw.count % 3 === 0));
  const total = renderer.getStats().totalVertices;
  assert.throws(() => renderer.append(batch(4, 'polygon')), /几何完整性/);
  assert.equal(renderer.getStats().totalVertices, total, 'rejected batches cannot partially mutate pages');
});

test('explicit low zoom point LOD keeps red alerts and yellow warnings outside the sampling stride', (t) => {
  const { renderer, gl, tick } = fixture(t);
  // Drive a known low zoom using the public camera API, regardless of the
  // renderer's initial framing or viewport size.
  const initialView = tick();
  renderer.zoomBy(initialView.unitsPerPixel / 80);
  const input = batch(50000);
  const alertIndex = 49999;
  const warningIndex = 49997;
  input.groups[0].positions.set([9999, 9999], alertIndex * 2);
  input.groups[0].colors.set([255, 70, 100, 255], alertIndex * 4);
  input.groups[0].positions.set([-9999, 9999], warningIndex * 2);
  input.groups[0].colors.set([255, 214, 82, 255], warningIndex * 4);
  renderer.append(input);
  const frame = tick();
  assert.equal(frame.lodStride, 4);
  assert.equal(frame.pointLodStride, 4);
  assert.equal(frame.riskPreservation, true);
  assert.equal(frame.pointAlertsTotal, 2);
  assert.equal(frame.pointAlertsDrawn, 2);
  assert.equal(frame.pointsSubmitted, frame.vertices);
  assert.ok(frame.vertices < frame.totalVertices);
  assert.notEqual(alertIndex % frame.lodStride, 0, 'red alert is outside the ordinary sampling stride');
  assert.notEqual(warningIndex % frame.lodStride, 0, 'yellow warning is outside the ordinary sampling stride');
  const draws = gl.draws.filter((draw) => draw.mode === gl.POINTS);
  const submitted = (x, y) => draws.some((draw) => {
    const positions = new Float32Array(draw.position.bytes.buffer);
    return draw.indices?.some((index) => positions[index * 2] === x && positions[index * 2 + 1] === y);
  });
  assert.ok(submitted(9999, 9999), 'the drawElements payload includes the red alert position');
  assert.ok(submitted(-9999, 9999), 'the drawElements payload includes the yellow warning position');
  renderer.setAdaptive(false);
  assert.equal(tick().vertices, 50000);
});

test('the same 100 point payload distinguishes full, uniform and risk-preserving LOD with cached quality counts', (t) => {
  const { renderer, gl, tick } = fixture(t);
  const initialView = tick();
  renderer.zoomBy(initialView.unitsPerPixel / 80);
  // Fix a four-vertex stride for this compact contract fixture. The production
  // 50,000-point activation threshold is covered by the public-camera test above.
  renderer._lod = unitsPerPixel => renderer.adaptive && unitsPerPixel > 45 ? 4 : 1;
  const input = batch(100);
  for (const id of [1, 4]) input.groups[0].colors.set([255, 70, 100, 255], id * 4);
  input.groups[0].colors.set([255, 214, 82, 238], 7 * 4);
  renderer.append(input);
  renderer.trackFeatures([1, 4, 7, 8, 9]);
  assert.equal(renderer.getStats().pointAlertsTotal, 3, 'append updates the all-data alert count without a render scan');
  const render = (points, alerts, total, stride) => {
    const marker = gl.calls.length;
    const frame = tick();
    assert.equal(frame.pointsSubmitted, points);
    assert.equal(frame.pointAlertsDrawn, alerts);
    assert.equal(frame.pointAlertsTotal, total);
    assert.equal(frame.pointLodStride, stride);
    assert.equal(frame.drawCalls, points ? 1 : 0);
    assert.equal(gl.calls.slice(marker).filter(call => call[0] === 'drawArrays' || call[0] === 'drawElements').length, points ? 1 : 0);
    return frame;
  };
  renderer.setAdaptive(false);
  render(100, 3, 3, 1);
  renderer.setAdaptive(true);
  renderer.setRiskPreservation(false);
  render(25, 1, 3, 4);
  assert.deepEqual([...gl.draws.at(-1).indices], Array.from({ length: 25 }, (_, index) => index * 4));
  renderer.setRiskPreservation(true);
  render(27, 3, 3, 4);
  assert.ok([1, 4, 7].every(id => gl.draws.at(-1).indices.includes(id)));
  const cachedUploads = gl.uploads.length;
  render(27, 3, 3, 4);
  assert.equal(gl.uploads.length, cachedUploads, 'steady frames reuse the index payload and quality count');

  renderer.updateFeatureColors([{ id: 1, color: [82, 212, 200, 255] }]);
  assert.equal(renderer.getStats().pointAlertsTotal, 2);
  render(26, 2, 2, 4);
  renderer.updateFeatureColors([{ id: 9, color: [255, 70, 100, 255] }]);
  render(27, 3, 3, 4);
  renderer.setRiskPreservation(false);
  render(25, 1, 3, 4);
  renderer.updateFeatureColors([{ id: 4, color: [82, 212, 200, 255] }]);
  render(25, 0, 2, 4);
  renderer.updateFeatureColors([{ id: 8, color: [255, 70, 100, 255] }]);
  render(25, 1, 3, 4);
  renderer.setAdaptive(false);
  render(100, 3, 3, 1);

  const fragment = batch(2, 'point', 100);
  fragment.groups[0].colors.set([255, 70, 100, 255, 255, 70, 100, 255]);
  renderer.append(fragment);
  renderer.setAdaptive(true);
  render(26, 2, 5, 4);
  renderer.setRiskPreservation(true);
  render(29, 5, 5, 4);
  assert.equal(renderer.getStats().totalVertices, 102, 'mode changes and quality counters never add geometry');
  renderer.setLayers({ points: false });
  render(0, 0, 5, 4);
  renderer.setLayers({ points: true });
  renderer.focus(1e9, 1e9);
  render(0, 0, 5, 4);
  renderer.resetView();
  renderer.zoomBy(initialView.unitsPerPixel / 80);
  render(29, 5, 5, 4);
  renderer.reset();
  assert.equal(renderer.getStats().pointAlertsTotal, 0);
  assert.equal(renderer.getStats().pointAlertsDrawn, 0);
  assert.equal(renderer.getStats().pointsSubmitted, 0);
});

test('recoloring an existing point updates alert membership outside the LOD sampling stride', (t) => {
  const { renderer, gl, tick } = fixture(t);
  const initialView = tick();
  renderer.zoomBy(initialView.unitsPerPixel / 80);
  renderer.append(batch(50000));
  tick();
  assert.equal(renderer.getStats().pointAlertsTotal, 0);
  assert.equal(renderer.getStats().pointAlertsDrawn, 0);
  const id = 49999;
  renderer.trackFeatures([id]);
  assert.ok(!gl.draws.at(-1).indices.includes(id));
  const page = renderer.pages.points[0];
  const marker = gl.uploads.length;
  renderer.updateFeatureColors([{ id, color: [255, 214, 82, 238] }]);
  assert.equal(tick().lodStride, 4);
  assert.equal(renderer.getStats().pointAlertsTotal, 1);
  assert.equal(renderer.getStats().pointAlertsDrawn, 1);
  assert.ok(gl.draws.at(-1).indices.includes(id), 'a recolored warning enters the submitted LOD indices');
  assert.ok(gl.uploads.slice(marker).every(upload => upload.buffer !== page.gpu.position), 'LOD refresh never uploads positions');
  renderer.updateFeatureColors([{ id, color: [82, 212, 200, 255] }]);
  tick();
  assert.equal(renderer.getStats().pointAlertsTotal, 0);
  assert.equal(renderer.getStats().pointAlertsDrawn, 0);
  assert.ok(!gl.draws.at(-1).indices.includes(id), 'a recovered point returns to the normal sampling stride');
  assert.equal(renderer.getStats().totalVertices, 50000);
});

test('viewport culling, layer toggles and camera controls change real submitted geometry', (t) => {
  const { renderer, tick, interactions } = fixture(t);
  renderer.append(batch(20));
  renderer.append(batch(4, 'lines'));
  assert.equal(tick().drawCalls, 2);
  renderer.focus(1e9, 1e9);
  const culled = tick();
  assert.equal(culled.drawCalls, 0);
  assert.equal(culled.culledPages, 2);
  renderer.resetView();
  renderer.setLayers({ points: false });
  assert.equal(tick().vertices, 4);
  const previousZoom = renderer.getStats().zoom;
  renderer.zoomBy(2);
  assert.ok(renderer.getStats().zoom > previousZoom);
  renderer.rotateBy(30);
  assert.ok(Math.abs(renderer.getStats().heading-30)<1e-6);
  assert.throws(()=>renderer.rotateBy(NaN),TypeError);
  assert.equal(renderer.animateView(7), true);
  assert.ok(interactions.some((event) => event.type === 'animate' && event.x !== 0 && event.heading !== 0));
  renderer.reset();
  assert.equal(renderer.getStats().totalVertices, 0);
  assert.equal(renderer.getStats().cpuBytes, 0);
  assert.equal(renderer.getStats().gpuBytes, 0);
});

test('empty AK rejects explicitly and keeps the local renderer active', async (t) => {
  const { renderer, tick, container, canvas } = fixture(t);
  await assert.rejects(renderer.connectBaidu(''), /浏览器端 AK/);
  assert.equal(renderer.getStats().mode, 'sandbox');
  assert.ok(container.children.includes(canvas));
  renderer.append(batch(10));
  assert.equal(tick().vertices, 10);
});

test('commit tokens wait for GL upload including hidden and culled geometry, without extra draws', async (t) => {
  const { renderer, gl, tick } = fixture(t);
  renderer.setLayers({ points: false });
  renderer.focus(1e9, 1e9);
  const first = renderer.append(batch(20, 'point'));
  const second = renderer.append(batch(4, 'line'));
  assert.ok(second.revision > first.revision);
  assert.equal(second.stagingRevision, second.revision);
  let settled = false;
  const committed = renderer.awaitCommit(second.revision).then(stats => { settled = true; return stats; });
  await Promise.resolve();
  assert.equal(settled, false, 'CPU staging alone does not acknowledge GL submission');
  assert.equal(gl.calls.filter(call => call[0] === 'bufferSubData').length, 0);
  const frame = tick();
  const result = await committed;
  assert.equal(frame.vertices, 0);
  assert.equal(gl.draws.length, 0, 'uploading hidden pages must not draw them');
  assert.equal(gl.calls.filter(call => call[0] === 'bufferSubData').length, 4);
  assert.equal(result.committedRevision, second.revision);
  assert.ok(Number.isFinite(result.glUploadSubmissionMs) && result.glUploadSubmissionMs >= 0);
  assert.equal((await renderer.awaitCommit(first.revision)).committedRevision, second.revision);
});

test('reset cancels outstanding commit tokens and stale tokens cannot acknowledge a later run', async (t) => {
  const { renderer, tick } = fixture(t);
  const old = renderer.append(batch(5));
  const rejected = assert.rejects(renderer.awaitCommit(old.revision), { name: 'AbortError' });
  renderer.reset();
  await rejected;
  await assert.rejects(renderer.awaitCommit(old.revision), { name: 'AbortError' });
  assert.equal(renderer.getStats().glUploadSubmissionMs, 0);
  const fresh = renderer.append(batch(2));
  assert.ok(fresh.revision > old.revision);
  const committed = renderer.awaitCommit(fresh.revision);
  tick();
  assert.equal((await committed).committedRevision, fresh.revision);
  await assert.rejects(renderer.awaitCommit(fresh.revision + 1), RangeError);
});

test('destroy rejects pending commit promises rather than leaving the Worker consumer blocked', async (t) => {
  const { renderer } = fixture(t);
  const { revision } = renderer.append(batch(3));
  const rejected = assert.rejects(renderer.awaitCommit(revision), { name: 'AbortError' });
  renderer.destroy();
  await rejected;
  await assert.rejects(renderer.awaitCommit(revision), { name: 'AbortError' });
});

test('GL upload errors reject commit promises and a stopped render loop times out', async (t) => {
  const { renderer, gl, tick } = fixture(t);
  const originalUpload = gl.bufferSubData;
  const { revision } = renderer.append(batch(3));
  gl.bufferSubData = () => { throw new Error('Injected GL submission failure'); };
  const failed = assert.rejects(renderer.awaitCommit(revision), /Injected GL submission failure/);
  tick();
  await failed;
  assert.ok(renderer.getStats().committedRevision < revision);
  gl.bufferSubData = originalUpload;
  renderer.reset();
  const later = renderer.append(batch(2));
  await assert.rejects(renderer.awaitCommit(later.revision, { timeoutMs: 5 }), /提交超时/);
  assert.equal(renderer._commitWaiters.size, 0, 'expired waiters are released');
});

test('Baidu connection waits for SDK onRender and leaves shared render state to the SDK', async (t) => {
  const { renderer, tick, canvas, raf } = fixture(t);
  renderer.append(batch(20));
  tick();
  const mapCanvas = new Element('canvas');
  const sharedGL = new RecordingGL(mapCanvas);
  let map;
  class MapDouble {
    constructor() { map = this; this.zoom = 12; this.heading = 0; }
    enableScrollWheelZoom() {}
    enableRotate() {}
    enableTilt() {}
    addLayer(layer) { this.layer = layer; }
    addEventListener() {}
    getZoom() { return this.zoom; }
    getHeading() { return this.heading; }
    setHeading(value) { this.heading = value; }
    destroy() {}
  }
  class LayerDouble {
    constructor(options) { this.options = options; }
    remove() {}
    triggerRepaint() {}
    stopAnimation() {}
  }
  window.BMap = {
    Map: MapDouble, WebGLCustomLayer: LayerDouble,
    Point: class { constructor(lng, lat) { this.lng = lng; this.lat = lat; } }
  };
  let settled = false;
  const connecting = renderer.connectBaidu('test-contract-key').then((result) => { settled = true; return result; });
  await Promise.resolve();
  assert.equal(settled, false, 'namespace and layer construction alone do not mean connected');
  assert.equal(renderer.getStats().mode, 'sandbox');
  assert.equal(map.layer.options.unsafeGL, true);
  assert.equal(map.layer.options.renderStage, 'poi', 'geometry overlays render after the map POI pass');
  assert.match(map.layer.options.vertexShader, /uniform mat4 u_mvpMatrix;/, 'SDK builtin MVP is declared so its camera transform is updated');
  assert.equal(map.layer.options.zIndex, 100);
  assert.deepEqual(map.layer.options.referCenter, new window.BMap.Point(121.592, 31.189));
  const matrix = new Float32Array(16);
  matrix[0] = 2 / (800 * 80);
  matrix[5] = 2 / (600 * 80);
  matrix[10] = matrix[15] = 1;
  map.layer.options.onRender({
    gl: sharedGL, getMVPMatrix: () => matrix,
    getUnitsPerPixel: () => 80, getPixelRatio: () => 1
  });
  assert.equal(await connecting, true);
  assert.equal(renderer.getStats().mode, 'baidu');
  assert.equal(canvas.isConnected, false, 'local canvas is removed after the SDK first frame');
  assert.equal(raf.size, 0, 'local RAF is stopped after the SDK takes ownership');
  assert.ok(sharedGL.draws.length > 0);
  const matrixUpload = sharedGL.calls.find(call => call[0] === 'uniformMatrix4fv');
  assert.deepEqual(matrixUpload.slice(1), ['u_mvpMatrix', false, Array.from(matrix)], 'native pipeline receives the current SDK camera matrix');
  assert.deepEqual(renderer.getStats().rendererDiagnostics.originClip, [0, 0, 0, 1]);
  assert.equal(sharedGL.calls.filter((call) => ['viewport', 'enable', 'disable', 'blendFunc', 'clear', 'clearColor'].includes(call[0])).length, 0);
  assert.equal(renderer.animateView(3), false, 'automated sandbox motion is explicitly unavailable on SDK maps');
  renderer.rotateBy(30);
  assert.equal(map.heading,30,'rotation uses the SDK camera rather than a detached sandbox matrix');
});
