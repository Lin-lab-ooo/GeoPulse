import test from 'node:test';
import assert from 'node:assert/strict';
import { initLodExperiment } from '../public/js/lod-experiment.js';
import { initMapFrameExperiment } from '../public/js/map-frame-experiment.js';

// Virtual time and camera/DOM control doubles test policy leases only. They do
// not render pixels, time a real browser, or supply performance evidence.
function fixture(t) {
  const keys = ['document', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'innerWidth', 'innerHeight', 'devicePixelRatio', 'navigator'];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let now = 0, rafSerial = 0;
  const elements = new Map(), get = id => {
    if (!elements.has(id)) elements.set(id, { id, style: {}, disabled: false, checked: true, value: '1', events: {}, textContent: '',
      addEventListener(type, listener) { this.events[type] = listener; }, append() {}, replaceChildren() {},
      getBoundingClientRect() { return { width: 800, height: 600 }; } });
    return elements.get(id);
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible',
    getElementById: get, querySelectorAll: () => [], addEventListener() {},
    createDocumentFragment: () => ({ append() {} }), createElement: () => ({ style: {}, append() {}, addEventListener() {} }) } });
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'unit-control-double' } });
  globalThis.requestAnimationFrame = callback => { queueMicrotask(() => callback(now += 1000)); return ++rafSerial; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.innerWidth = 800; globalThis.innerHeight = 600; globalThis.devicePixelRatio = 1;
  const policies = [], r = { renderPolicy: 'demand', adaptive: true, risk: true,
    layers: { points: true, lines: true, polygons: true },
    matrix: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    optimization: { spatial: true },
    getStats() { return { features: 100000, pointVertices: 88000, totalVertices: 120000, riskPreservation: this.risk,
      optimization: this.optimization, mode: 'sandbox', stagingRevision: 1, committedRevision: 1,
      pointsSubmitted: 88000, pointAlertsTotal: 1000, pointAlertsDrawn: 1000, vertices: 120000, drawCalls: 3, gpuBytes: 2000000 }; },
    setRenderPolicy(policy) { policies.push(policy); this.renderPolicy = policy; },
    getViewState: () => ({ mode: 'sandbox', x: 0, y: 0, scale: .1, heading: 0 }), setViewState() {},
    setAdaptive(value) { this.adaptive = value; }, setRiskPreservation(value) { this.risk = value; },
    setLayers(value) { this.layers = { ...value }; }, resetView() {},
    setOptimizationOptions(value) { this.optimization = { ...value }; },
    subscribeFrames: () => () => {}, getTrackedFeatureIds: () => [], trackFeatures() {},
    getColorUpdateTargets: () => [{ id: 1, color: [20, 130, 220, 255] }, { id: 2, color: [20, 130, 220, 255] }], updateFeatureColors() {}
  };
  const common = { getRenderer: () => r, getConfig: () => ({ count: 100000 }), isBusy: () => false,
    onActiveChange() {}, onPhase() {}, onShowMap() {}, onShowResults() {}, stopNeural() {}, getEnvironment: () => ({}) };
  t.after(() => { for (const key of keys) { const descriptor = previous.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return { r, policies, get, common };
}

test('LOD comparison leases continuous rendering for every phase and restores demand afterward', async t => {
  const f = fixture(t), experiment = initLodExperiment(f.common);
  await f.get('lod-benchmark').events.click();
  assert.deepEqual(f.policies, ['continuous', 'demand']);
  assert.equal(experiment.evidence().length, 9);
  assert.ok(experiment.evidence().every(record => record.renderPolicy === 'continuous' && record.implementationVersion === '2.6'));
  assert.equal(f.get('render-policy').disabled, false);
  assert.equal(f.get('demand-start').disabled, false);
});

test('LOD preparation failure still restores its original policy and unlocks cross-experiment controls', async t => {
  const f = fixture(t); f.r.resetView = () => { throw new Error('camera failed'); };
  initLodExperiment(f.common);
  await f.get('lod-benchmark').events.click();
  assert.deepEqual(f.policies, ['continuous', 'demand']);
  assert.equal(f.r.renderPolicy, 'demand');
  assert.equal(f.get('demand-start').disabled, false);
  assert.match(f.get('lod-progress').textContent, /camera failed/);
});

test('map-frame camera failure releases continuous policy even when another restoration step fails', async t => {
  const f = fixture(t); f.r.setOptimizationOptions = () => { throw new Error('restore options failed'); };
  const experiment = initMapFrameExperiment(f.common);
  const result = await experiment.start({ allowSandbox: true, repeats: 1, warmupMs: 1, sampleMs: 1,
    referenceMs: 1, cameraPreset: 'local', cameraReadyTimeoutMs: 1 });
  assert.equal(result.ok, false); assert.match(result.error, /相机/);
  assert.equal(result.restoreError, 'restore options failed');
  assert.deepEqual(f.policies, ['continuous', 'demand']);
  assert.equal(f.r.renderPolicy, 'demand');
  assert.equal(f.get('render-policy').disabled, false); assert.equal(f.get('demand-start').disabled, false);
});
