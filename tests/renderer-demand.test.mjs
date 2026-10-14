import test from 'node:test';
import assert from 'node:assert/strict';
import { GeoRenderer } from '../public/js/renderer.js';
import { RecordingGL } from './helpers/recording-renderer.mjs';

class Element {
  constructor() { this.style = {}; this.events = {}; this.children = []; this.width = 0; this.height = 0; }
  appendChild(element) { this.children.push(element); element.parent = this; element.isConnected = true; return element; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); this.isConnected = false; }
  setAttribute() {}
  addEventListener(type, callback) { this.events[type] = callback; }
  removeEventListener(type) { delete this.events[type]; }
  getBoundingClientRect() { return { width: 800, height: 600, left: 0, top: 0 }; }
  getContext() { return this.gl ||= new RecordingGL(this); }
  setPointerCapture() {}
  hasPointerCapture() { return false; }
  releasePointerCapture() {}
}

function fixture(t) {
  const keys = ['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver'];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const raf = new Map(); let nextId = 0, time = 1000;
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = { createElement: () => new Element(), head: new Element() };
  globalThis.requestAnimationFrame = callback => { raf.set(++nextId, callback); return nextId; };
  globalThis.cancelAnimationFrame = id => raf.delete(id);
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  const r = new GeoRenderer(new Element()), frames = [];
  r.onFrame = info => frames.push(info);
  const gl = r._localGL;
  t.after(() => {
    r.destroy();
    for (const key of keys) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  function tick() {
    const item = raf.entries().next().value;
    if (!item) return false;
    const [id, callback] = item; raf.delete(id); callback(time += 16.667); return true;
  }
  function drain(max = 1000) {
    let count = 0;
    while (raf.size && count++ < max) tick();
    return count;
  }
  function attachSdk() {
    r._stopRenderSchedule(); r.mode = 'baidu';
    const state = { animation: false, starts: 0, stops: 0, repaints: 0 };
    r._map = { getZoom: () => 14, getHeading: () => 0, destroy() {} };
    r._layer = { isAnimating: () => state.animation,
      startAnimation() { state.starts++; state.animation = true; },
      stopAnimation() { state.stops++; state.animation = false; },
      triggerRepaint() { state.repaints++; }, remove() {} };
    function render() {
      gl.resetMeasurements();
      r._render(gl, r._localMatrix(), { time: time += 16.667, unitsPerPixel: 1 / r.camera.scale, pixelRatio: 1, shared: true });
    }
    return { state, render };
  }
  return { r, gl, raf, frames, tick, drain, attachSdk };
}

function points(count, color = [20, 130, 220, 255], position = index => [index % 20, Math.floor(index / 20)], firstID = 1) {
  const positions = new Float32Array(count * 2), colors = new Uint8Array(count * 4), ids = new Uint32Array(count);
  for (let index = 0; index < count; index++) {
    positions.set(position(index), index * 2); colors.set(typeof color === 'function' ? color(index) : color, index * 4); ids[index] = firstID + index;
  }
  return { featureCount: count, groups: [{ kind: 'points', positions, colors, ids, featureCount: count }] };
}

test('default demand sandbox sleeps after its first empty draw and has no permanent polling frame', t => {
  const { r, raf, tick } = fixture(t);
  assert.equal(r.renderPolicy, 'demand'); assert.equal(raf.size, 1);
  tick(); assert.equal(raf.size, 0);
  const snapshot = r.getRenderScheduling();
  assert.equal(snapshot.sleeping, true); assert.equal(snapshot.businessFrames, 1);
  assert.equal(snapshot.drawCalls, 0); assert.ok(snapshot.renderCpuMs > 0);
  assert.throws(() => r.setRenderPolicy('bad'), /策略/);
});

test('append and awaited commits wake sleeping sandbox, including geometry on hidden layers', async t => {
  const { r, raf, tick, drain } = fixture(t);
  tick(); r.setLayers({ points: false });
  const append = r.append(points(100)), commit = r.awaitCommit(append.revision);
  assert.equal(raf.size, 1); drain();
  const committed = await commit;
  assert.equal(committed.committedRevision, append.revision);
  assert.equal(committed.uploadedBytes, 1200);
  assert.equal(committed.drawCalls, 0); assert.equal(raf.size, 0);
});

test('mutator bursts merge into one pending sandbox frame and setters preserve final values', t => {
  const { r, raf, tick } = fixture(t);
  tick(); const before = r.getRenderScheduling();
  r.setAdaptive(false); r.setPointSize(7); r.setRiskPreservation(false);
  r.setLayers({ points: false }); r.setViewState({ x: 30 }); r.setOptimizationOptions({ spatial: false });
  assert.equal(raf.size, 1); tick(); assert.equal(raf.size, 0);
  const after = r.getRenderScheduling();
  assert.equal(after.sandboxFrameRequests - before.sandboxFrameRequests, 1);
  assert.ok(after.coalescedWakeRequests - before.coalescedWakeRequests >= 5);
  assert.equal(r.pointSize, 7); assert.equal(r.camera.x, 30);
});

test('continuous comparator keeps frames and switching back to demand sleeps without changing draw content', t => {
  const { r, raf, tick } = fixture(t);
  r.append(points(10)); tick(); assert.equal(raf.size, 0);
  const vertices = r.getStats().vertices;
  r.setRenderPolicy('continuous'); tick(); tick(); tick(); assert.equal(raf.size, 1);
  assert.equal(r.getStats().vertices, vertices);
  r.setRenderPolicy('demand'); tick(); assert.equal(raf.size, 0);
});

test('shader pulse keeps original time uniform cadence even for colors outside CPU risk predicate', t => {
  const { r, gl, raf, tick } = fixture(t), times = [];
  gl.uniform1f = (name, value) => { if (name === 'u_time') times.push(value); };
  r.append(points(1, [210, 255, 122, 255]));
  tick(); tick(); tick();
  assert.equal(r.getStats().pointAlertsTotal, 0);
  assert.equal(r.getRenderScheduling().pulseActive, true); assert.equal(raf.size, 1);
  assert.ok(Math.abs(times[2] - times[1] - .016667) < 1e-9);
  r.setLayers({ points: false }); tick(); assert.equal(raf.size, 0);
  r.setLayers({ points: true }); tick(); assert.equal(raf.size, 1);
});

test('color promotion wakes pulse and recovery submits only changed RGBA before sleeping again', async t => {
  const { r, gl, raf, tick } = fixture(t);
  r.append(points(2)); r.trackFeatures([1, 2]); tick(); assert.equal(raf.size, 0);
  const before = r.getStats().uploadedBytes;
  const change = r.updateFeatureColors([{ id: 1, color: [210, 255, 122, 255] }]);
  const committed = r.awaitCommit(change.revision); tick(); await committed;
  assert.equal(r.getStats().uploadedBytes - before, 4); assert.equal(raf.size, 1);
  gl.resetMeasurements(); r.updateFeatureColors([{ id: 1, color: [20, 130, 220, 255] }]); tick();
  assert.equal(gl.uploads.reduce((sum, upload) => sum + upload.byteLength, 0), 4);
  assert.equal(raf.size, 0); assert.equal(r.getRenderScheduling().pulseActive, false);
});

test('offscreen pulse pages and hidden ordinary pages do not force perpetual settling', t => {
  const { r, raf, tick } = fixture(t);
  r.append(points(10, [255, 70, 30, 255], index => [50000 + index, 50000])); tick();
  assert.equal(r.getStats().vertices, 0); assert.equal(r.getRenderScheduling().pulseActive, false); assert.equal(raf.size, 0);
  r.setViewState({ x: 50000, y: 50000 }); tick(); assert.equal(raf.size, 1);
  r.setLayers({ points: false }); tick(); assert.equal(raf.size, 0);
});

test('visible partial pages settle, finish progressive construction, draw the completed selection, then sleep', t => {
  const { r, raf, drain, frames } = fixture(t);
  r.setAdaptive(false);
  r.setOptimizationOptions({ maxCandidateRatio: 1, spatialBuildBudgetMs: .001, spatialBuildChunkPrimitives: 32 });
  r.setViewState({ scale: .2 });
  r.append(points(512, [20, 130, 220, 255], index => index < 64 ? [index, index % 10] : [50000 + index, 50000]));
  const count = drain(200);
  assert.ok(count > 4); assert.ok(count < 200); assert.equal(raf.size, 0);
  const stats = r.getStats();
  assert.equal(stats.spatialPendingPages, 0); assert.equal(stats.spatialReadyPages, 1);
  assert.equal(stats.vertices, 64); assert.equal(stats.spatialBuildProgress, 1);
  assert.equal(stats.renderScheduling.sleeping, true);
  assert.ok(frames.at(-1).indexUploadedBytes > 0);
  assert.equal(frames.at(-2).vertices, 512, 'completion frame still used complete fallback');
});

test('disabled spatial mode pauses retained pending construction without a busy loop and resumes on reenable', t => {
  const { r, raf, tick, drain } = fixture(t);
  r.setOptimizationOptions({ maxCandidateRatio: 1, spatialBuildBudgetMs: .001, spatialBuildChunkPrimitives: 1 });
  r.setViewState({ scale: .2 });
  r.append(points(512, [20, 130, 220, 255], index => index < 64 ? [index, 0] : [50000 + index, 50000]));
  for (let index = 0; index < 5; index++) tick();
  assert.ok(r.getStats().spatialPendingPages > 0);
  const progress = r.pages.points[0].spatialIndexedUntil;
  r.setOptimizationOptions({ spatial: false }); tick(); assert.equal(raf.size, 0);
  assert.equal(r.pages.points[0].spatialIndexedUntil, progress);
  r.setOptimizationOptions({ spatial: true }); drain(1000);
  assert.equal(r.getStats().spatialPendingPages, 0); assert.equal(raf.size, 0);
});

test('an append from onFrame remains pending after the current callback and commits on the next frame', async t => {
  const { r, raf, tick } = fixture(t);
  let revision = null;
  r.onFrame = () => { if (revision === null) revision = r.append(points(2)).revision; };
  tick(); assert.equal(raf.size, 1); assert.ok(revision > r.getStats().committedRevision);
  const committed = r.awaitCommit(revision); tick(); await committed;
  assert.equal(r.getStats().features, 2); assert.equal(raf.size, 0);
});

test('context loss suspends scheduling and active-context restoration wakes and reconstructs GL resources', t => {
  const { r, gl, raf, tick } = fixture(t);
  r.append(points(2)); tick(); assert.equal(raf.size, 0);
  const gpu = r.pages.points[0].gpu;
  r.canvas.events.webglcontextlost({ preventDefault() {} });
  assert.equal(r.contextLost, true); assert.equal(raf.size, 0);
  r.canvas.events.webglcontextrestored(); assert.equal(raf.size, 1); tick();
  assert.equal(r.contextLost, false); assert.notEqual(r.pages.points[0].gpu, gpu);
  assert.equal(gl.draws.at(-1).count, 2); assert.equal(raf.size, 0);
});

test('restore event from a nonactive old canvas cannot clear a currently lost shared context', t => {
  const { r } = fixture(t), oldCanvas = r.canvas, other = new Element();
  r._bindContextEvents(other); r._activeContextCanvas = other; r.contextLost = true;
  oldCanvas.events.webglcontextrestored(); assert.equal(r.contextLost, true);
});

test('reset clears pulse scheduling and schedules a clearing frame; resize wakes a sleeping sandbox', t => {
  const { r, raf, tick } = fixture(t);
  r.append(points(1, [255, 70, 30, 255])); tick(); assert.equal(raf.size, 1);
  r.reset(); tick(); assert.equal(raf.size, 0); assert.equal(r.getRenderScheduling().pulseActive, false);
  r.container.getBoundingClientRect = () => ({ width: 900, height: 600 });
  r._resize(); assert.equal(raf.size, 1); tick(); assert.equal(raf.size, 0);
});

test('Baidu mutation bursts issue one repaint and every SDK shared callback redraws unchanged content', async t => {
  const { r, gl, attachSdk } = fixture(t), sdk = attachSdk();
  const staged = r.append(points(2)); r.setPointSize(4); r.setAdaptive(false); const commit = r.awaitCommit(staged.revision);
  await Promise.resolve(); assert.equal(sdk.state.repaints, 1);
  sdk.render(); await commit; assert.equal(gl.draws.length, 1);
  assert.equal(r.getRenderScheduling().sleeping, true);
  sdk.render(); assert.equal(gl.draws.length, 1, 'new SDK frame must redraw even with no dirty data');
  assert.equal(sdk.state.starts, 0); assert.equal(sdk.state.stops, 0);
});

test('Baidu animation only changes at pulse/policy transitions rather than every business frame', async t => {
  const { r, attachSdk } = fixture(t), sdk = attachSdk();
  r.append(points(1, [210, 255, 122, 255])); await Promise.resolve(); sdk.render();
  assert.equal(sdk.state.starts, 1);
  for (let index = 0; index < 10; index++) sdk.render();
  assert.equal(sdk.state.starts, 1); assert.equal(sdk.state.stops, 0);
  r.setLayers({ points: false }); sdk.render(); assert.equal(sdk.state.stops, 1);
  r.setRenderPolicy('continuous'); assert.equal(sdk.state.starts, 2);
  sdk.render(); sdk.render(); assert.equal(sdk.state.starts, 2);
  r.setRenderPolicy('demand'); await Promise.resolve(); sdk.render();
  assert.equal(sdk.state.stops, 2);
});

test('a synchronous SDK callback from startAnimation cannot recurse or lose its deferred complete draw', async t => {
  const { r, gl, attachSdk } = fixture(t), sdk = attachSdk();
  r._layer.startAnimation = () => { sdk.state.starts++; sdk.state.animation = true; sdk.render(); };
  r.append(points(1, [255, 70, 30, 255])); await Promise.resolve(); sdk.render();
  assert.equal(sdk.state.starts, 1);
  assert.equal(r.getRenderScheduling().reentrantCallbacks, 1);
  assert.equal(r.getRenderScheduling().pendingFrame, true);
  sdk.render();
  assert.equal(gl.draws.length, 1);
  assert.equal(r.getRenderScheduling().businessFrames, 2);
  assert.equal(r.getRenderScheduling().pendingFrame, false);
  assert.equal(sdk.state.starts, 1);
});

test('Baidu repaint queued before an SDK frame cannot duplicate a replacement request after that frame', async t => {
  const { r, attachSdk } = fixture(t), sdk = attachSdk();
  r.setPointSize(4); // Queued repaint not yet dispatched.
  r.onFrame = () => { r.onFrame = () => {}; r.append(points(2)); };
  sdk.render(); // Consumes the old request, then queues a new append request.
  await Promise.resolve(); assert.equal(sdk.state.repaints, 1);
  sdk.render(); assert.equal(r.getStats().features, 2);
});

test('destroy cancels scheduled sandbox work and invalidates queued Baidu repaint microtasks', async t => {
  const { r, raf, attachSdk } = fixture(t), sdk = attachSdk();
  r.append(points(2)); r.destroy(); await Promise.resolve();
  assert.equal(raf.size, 0); assert.equal(sdk.state.repaints, 0);
  assert.throws(() => r.setRenderPolicy('continuous'), /销毁/);
});

test('constant-time scheduling snapshot does not visit page summaries or full renderer stats', t => {
  const { r } = fixture(t);
  r.getStats = () => { throw new Error('full stats forbidden'); };
  r.pages.points.push({ get coarse() { throw new Error('page scan forbidden'); } });
  assert.equal(r.getRenderScheduling().policy, 'demand');
  r.pages.points.length = 0;
});
