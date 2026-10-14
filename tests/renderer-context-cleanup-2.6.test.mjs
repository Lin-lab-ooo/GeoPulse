import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, Target, batch} from '../tools/fixtures/candidate-context-cleanup-2.6/test-helper.mjs';
import {GeoRenderer as Renderer} from '../public/js/renderer.js';
const contextTypes = ['webglcontextlost', 'webglcontextrestored'];
const intact = canvas => contextTypes.forEach(type => assert.equal(canvas.count(type), 1));
const detachedOnce = canvas => contextTypes.forEach(type => { assert.equal(canvas.count(type), 0); assert.equal(canvas.removeCounts[type], 1); });

test('context binding deduplicates and does not place SDK canvas in generic listener closures', t => {
  const f = fixture(Renderer); t.after(() => f.dispose()); const r = f.r, count = r._listeners.length, sdk = new Target();
  r._bindContextEvents(sdk); r._bindContextEvents(sdk); intact(sdk); intact(r.canvas);
  assert.equal(r._listeners.length, count); assert.equal(r._contextCanvases.size, 2);
  contextTypes.forEach(type => assert.equal(sdk.addCounts[type], 1));
});

test('real first shared upload failure rejects connection and promptly detaches SDK context handlers', async t => {
  const f = fixture(Renderer); t.after(() => f.dispose()); const r = f.r; r.append(batch());
  const { promise, map } = await f.beginConnect(); const rejected = assert.rejects(promise, /GPU/);
  map.gl.createBuffer = () => null; f.drawMap(map); await rejected;
  detachedOnce(map.canvas); intact(r.canvas); assert.equal(map.destroyed, 1); assert.equal(map.layer.removed, 1);
  assert.equal(r._map, null); assert.equal(r._mapHost, null); assert.equal(r.mode, 'sandbox');
  assert.equal(r._contextCanvases.size, 1); assert.ok(r._contextCanvases.has(r.canvas));
});

test('failed connections followed by explicit run reset do not accumulate retired canvas handlers', async t => {
  const f = fixture(Renderer); t.after(() => f.dispose());
  for (let i = 0; i < 3; i++) {
    f.r.reset(); f.r.append(batch()); const { promise, map } = await f.beginConnect();
    const rejected = assert.rejects(promise, /GPU/); map.gl.createBuffer = () => null; f.drawMap(map); await rejected;
    detachedOnce(map.canvas); assert.equal(f.r._contextCanvases.size, 1);
  }
  f.r.reset(); f.r.append(batch()); const { promise, map } = await f.beginConnect(); f.drawMap(map); assert.equal(await promise, true);
  assert.equal(f.r.mode, 'baidu'); intact(map.canvas); intact(f.r.canvas); assert.equal(f.r._contextCanvases.size, 2);
  f.maps.slice(0, -1).forEach(previous => detachedOnce(previous.canvas));
});

test('cleanup is idempotent, ignores retiring SDK events and preserves sandbox loss/restore', t => {
  const f = fixture(Renderer); t.after(() => f.dispose()); const r = f.r, sdk = new Target();
  r._bindContextEvents(sdk); const lateLost = sdk.first('webglcontextlost'); r._activeContextCanvas = sdk;
  r._map = { destroy() { sdk.dispatch('webglcontextlost', { preventDefault() {} }); } };
  r._cleanupMap(); r._cleanupMap(); detachedOnce(sdk); intact(r.canvas); assert.equal(f.errors.length, 0);
  lateLost({ preventDefault() { throw new Error('Retired canvas must be ignored'); } }); assert.equal(r.contextLost, false);
  let prevented = false; r.canvas.dispatch('webglcontextlost', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(r.contextLost, true); assert.equal(f.errors.length, 1);
  r.canvas.dispatch('webglcontextrestored'); assert.equal(r.contextLost, false); assert.equal(r._commitError, null);
});

test('switching SDK canvases detaches the old one but retains local fallback listeners', t => {
  const f = fixture(Renderer); t.after(() => f.dispose()); const first = new Target(), second = new Target();
  f.r._useContext(first.getContext()); f.r._useContext(second.getContext());
  detachedOnce(first); intact(second); intact(f.r.canvas); assert.equal(f.r._contextCanvases.size, 2);
  f.r._useContext(second.getContext()); intact(second); contextTypes.forEach(type => assert.equal(second.addCounts[type], 1));
});

test('destroy detaches all context/input handlers once and stale closures cannot revive renderer', t => {
  const f = fixture(Renderer); t.after(() => f.dispose()); const sdk = new Target(), local = f.r.canvas;
  f.r._bindContextEvents(sdk); const lateRestore = sdk.first('webglcontextrestored'); f.r._activeContextCanvas = sdk;
  f.r.destroy(); f.r.destroy(); detachedOnce(sdk); detachedOnce(local);
  assert.equal(f.r._contextCanvases.size, 0); assert.equal(f.r._listeners.length, 0);
  const queued = f.raf.size; lateRestore(); assert.equal(f.raf.size, queued);
});

test('partial listener installation unwinds both bookkeeping and the successfully attached listener', t => {
  const f = fixture(Renderer); t.after(() => f.dispose()); const sdk = new Target(); sdk.throwAdd = 'webglcontextrestored';
  assert.throws(() => f.r._bindContextEvents(sdk), /installation failure/);
  detachedOnce(sdk); assert.equal(f.r._contextCanvases.has(sdk), false); intact(f.r.canvas);
});
