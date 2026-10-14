import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingRenderer } from './helpers/recording-renderer.mjs';

const NORMAL = [20, 130, 220, 180];
const ALERT = [255, 70, 30, 255];

test('local unprojection requires a connected SDK layer, validates and copies the geographic result', () => {
  const fixture = createRecordingRenderer();
  try {
    const r = fixture.renderer;
    assert.throws(() => r.unprojectLocalPoint([0, 0]), /百度地图/);
    attachMapDouble(r);
    const calls = [], result = [121.592, 31.189];
    r._layer.unprojectFromLayer = point => { calls.push([...point]); return result; };
    assert.deepEqual(r.unprojectLocalPoint([-1200, 900]), result);
    assert.deepEqual(calls, [[-1200, 900]]);
    const copy = r.unprojectLocalPoint([0, 0]); copy[0] = 0;
    assert.equal(result[0], 121.592);
    for (const bad of [null, [0], [0, Infinity], [0, 1, 2]]) assert.throws(() => r.unprojectLocalPoint(bad));
    r._layer.unprojectFromLayer = () => [181, 30];
    assert.throws(() => r.unprojectLocalPoint([0, 0]), /BD-09/);
  } finally { fixture.dispose(); }
});

function points(count, color = () => NORMAL, firstID = 1) {
  const positions = new Float32Array(count * 2);
  const colors = new Uint8Array(count * 4);
  const ids = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    positions.set([i, i % 17], i * 2);
    colors.set(color(i), i * 4);
    ids[i] = firstID + i;
  }
  return { kind: 'points', positions, colors, ids, featureCount: count };
}

// No SDK, authentication, network, GPU execution or presentation is involved.
// This double checks the public camera contract and actual SDK call arguments.
function attachMapDouble(renderer) {
  const state = { center: { lng: 121.592, lat: 31.189 }, zoom: 12, heading: 0, tilt: 0 };
  const calls = [];
  globalThis.window.BMap = {
    Point: class Point { constructor(lng, lat) { this.lng = lng; this.lat = lat; } }
  };
  renderer.mode = 'baidu';
  renderer._map = {
    getCenter: () => ({ ...state.center }),
    getZoom: () => state.zoom,
    getHeading: () => state.heading,
    getTilt: () => state.tilt,
    setCenter: (value, options) => { calls.push(['center', value, options]); state.center = { lng: value.lng, lat: value.lat }; },
    setZoom: (value, options) => { calls.push(['zoom', value, options]); state.zoom = value; },
    setHeading: (value, options) => { calls.push(['heading', value, options]); state.heading = value; },
    setTilt: (value, options) => { calls.push(['tilt', value, options]); state.tilt = value; },
    destroy() {}
  };
  renderer._layer = { triggerRepaint() {}, stopAnimation() {}, remove() {} };
  return { state, calls };
}

test('sandbox view state round-trips local coordinates and a partial change preserves the other fields', () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    renderer.setViewState({ x: 123, y: -456, scale: 0.75, heading: 0.4 });
    const pose = renderer.getViewState();
    assert.deepEqual(pose, { mode: 'sandbox', x: 123, y: -456, scale: 0.75, heading: 0.4 });
    pose.x = 900;
    assert.equal(renderer.getViewState().x, 123, 'a returned pose must not expose the mutable camera');
    renderer.setViewState({ heading: -0.2 });
    assert.deepEqual(renderer.getViewState(), { mode: 'sandbox', x: 123, y: -456, scale: 0.75, heading: -0.2 });
  } finally { fixture.dispose(); }
});

test('invalid sandbox views do not partially move the camera', () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    const before = renderer.getViewState();
    for (const bad of [null, { x: 10, scale: 0 }, { x: 10, y: Infinity }, { x: 10, heading: NaN }, { scale: -1 }]) {
      assert.throws(() => renderer.setViewState(bad));
      assert.deepEqual(renderer.getViewState(), before);
    }
  } finally { fixture.dispose(); }
});

test('Baidu view controls use SDK geographic poses and explicitly disable each setter animation', () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    const map = attachMapDouble(renderer);
    const view = { mode: 'baidu', center: { lng: 121.6, lat: 31.2 }, zoom: 15, heading: 45, tilt: 50 };
    renderer.setViewState(view);
    assert.deepEqual(renderer.getViewState(), view);
    assert.deepEqual(map.calls.map(call => call[0]), ['center', 'zoom', 'heading', 'tilt']);
    for (const [, , options] of map.calls) assert.deepEqual(options, { noAnimation: true });
    const returned = renderer.getViewState();
    returned.center.lng = 0;
    assert.equal(renderer.getViewState().center.lng, 121.6);
    renderer.setViewState({ zoom: 16 });
    assert.deepEqual(renderer.getViewState(), { ...view, zoom: 16 });
  } finally { fixture.dispose(); }
});

test('Baidu view validation completes before calling any SDK setter', () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    const map = attachMapDouble(renderer);
    const before = renderer.getViewState();
    for (const bad of [
      null,
      { center: { lng: 121.6, lat: Infinity }, zoom: 16 },
      { center: { lng: 121.6, lat: 31.2 }, zoom: NaN },
      { center: { lng: 121.6, lat: 31.2 }, zoom: 16, heading: Infinity },
      { center: { lng: 121.6, lat: 31.2 }, zoom: 16, tilt: 90 }
    ]) {
      assert.throws(() => renderer.setViewState(bad));
      assert.equal(map.calls.length, 0, 'validation must not leave a half-applied SDK camera');
      assert.deepEqual(renderer.getViewState(), before);
    }
  } finally { fixture.dispose(); }
});

test('frame subscriptions run after draw/commit and unsubscribe without replacing the existing callback', () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    renderer.append({ groups: [points(3)] });
    const events = [], legacy = [];
    renderer.onFrame = info => legacy.push(info);
    const unsubscribe = renderer.subscribeFrames(info => {
      assert.ok(fixture.gl.draws.length > 0);
      assert.equal(info.committedRevision, renderer.getStats().stagingRevision);
      assert.equal(info.pointsSubmitted, 3);
      assert.equal(info.mode, 'sandbox');
      events.push(info);
    });
    assert.equal(typeof unsubscribe, 'function');
    fixture.render();
    fixture.render();
    assert.equal(events.length, 2);
    assert.equal(legacy.length, 2);
    unsubscribe();
    unsubscribe();
    fixture.render();
    assert.equal(events.length, 2);
    assert.equal(legacy.length, 3);
  } finally { fixture.dispose(); }
});

test('an observer exception cannot abort rendering or prevent another frame subscriber', () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    renderer.append({ groups: [points(1)] });
    renderer.subscribeFrames(() => { throw new Error('observer-only failure'); });
    let observed = 0;
    renderer.subscribeFrames(() => observed++);
    assert.doesNotThrow(() => fixture.render());
    assert.equal(observed, 1);
    assert.equal(renderer.getStats().lastError, null);
  } finally { fixture.dispose(); }
});

test('geographic projection requires a real map layer and delegates to projectToLayer', () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    assert.throws(() => renderer.projectGeographicPoint([121.6, 31.2]));
    attachMapDouble(renderer);
    const projected = [], result = [870, 1200];
    renderer._layer.projectToLayer = input => { projected.push([...input]); return result; };
    assert.deepEqual(renderer.projectGeographicPoint([121.6, 31.2]), result);
    assert.deepEqual(projected, [[121.6, 31.2]]);
    for (const bad of [null, [121.6], [NaN, 31.2], [121.6, Infinity]]) {
      assert.throws(() => renderer.projectGeographicPoint(bad));
    }
    assert.equal(projected.length, 1);
    renderer._layer = null;
    assert.throws(() => renderer.projectGeographicPoint([121.6, 31.2]));
  } finally { fixture.dispose(); }
});

test('color targets select distant ordinary points, copy colors and preserve existing subscriptions', () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    renderer.append({ groups: [points(400, i => i === 0 || i === 399 ? ALERT : NORMAL)] });
    renderer.trackFeatures([200]);
    const targets = renderer.getColorUpdateTargets(2);
    assert.equal(targets.length, 2);
    assert.deepEqual(targets.map(target => target.id), [2, 399]);
    assert.deepEqual(targets.map(target => target.pageIndex), [0, 0]);
    assert.deepEqual(targets.map(target => target.vertexIndex), [1, 398]);
    assert.deepEqual([...renderer.getTrackedFeatureIds()].sort((a, b) => a - b), [2, 200, 399]);
    for (const target of targets) assert.deepEqual(Array.from(target.color), NORMAL);
    targets[0].color[0] = 99;
    assert.equal(renderer.pages.points[0].colors[4], NORMAL[0]);
    fixture.render();
    const update = renderer.updateFeatureColors(targets.map(target => ({ id: target.id, color: [30, 140, 230, 180] })));
    assert.equal(update.updated, 2);
    assert.equal(fixture.render().colorUploadBytes, 8);
    const tracked = renderer.getTrackedFeatureIds();
    tracked.length = 0;
    assert.equal(renderer.getTrackedFeatureIds().length, 3, 'subscription snapshots must be independent');
  } finally { fixture.dispose(); }
});

test('color targets prefer a same-page pair and never substitute line vertices or alert points', () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    renderer.setOptimizationOptions({ spatial: false });
    const capacity = renderer.getStats().pageCapacity;
    renderer.append({ groups: [points(capacity + 3, i => i === 0 || i >= capacity - 1 ? NORMAL : ALERT)] });
    const targets = renderer.getColorUpdateTargets(2);
    assert.equal(targets.length, 2);
    assert.deepEqual(targets.map(target => target.pageIndex), [0, 0]);
    assert.deepEqual(targets.map(target => target.vertexIndex), [0, capacity - 1]);
  } finally { fixture.dispose(); }
  const alertFixture = createRecordingRenderer();
  try {
    const renderer = alertFixture.renderer;
    renderer.append({ groups: [points(5, () => ALERT), {
      kind: 'lines', positions: new Float32Array([0, 0, 1, 1]),
      colors: new Uint8Array([...NORMAL, ...NORMAL]), ids: new Uint32Array([99, 99]), featureCount: 1
    }] });
    renderer.trackFeatures([99]);
    assert.deepEqual(renderer.getColorUpdateTargets(2), []);
    assert.deepEqual(renderer.getTrackedFeatureIds(), [99]);
  } finally { alertFixture.dispose(); }
});

test('selecting color targets respects the subscription cap and rejects invalid target counts atomically', () => {
  const fixture = createRecordingRenderer();
  try {
    const renderer = fixture.renderer;
    renderer.append({ groups: [points(4100)] });
    const existing = Array.from({ length: 4096 }, (_, i) => i + 3);
    renderer.trackFeatures(existing);
    const targets = renderer.getColorUpdateTargets(2);
    assert.equal(targets.length, 2);
    const tracked = renderer.getTrackedFeatureIds();
    assert.equal(tracked.length, 4096);
    assert.deepEqual(tracked, existing);
    for (const target of targets) assert.ok(tracked.includes(target.id));
    for (const count of [0, -1, 9, 1.5, NaN]) {
      assert.throws(() => renderer.getColorUpdateTargets(count));
      assert.deepEqual(renderer.getTrackedFeatureIds(), existing);
    }
  } finally { fixture.dispose(); }
});
