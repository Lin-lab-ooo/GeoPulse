import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingRenderer } from './helpers/recording-renderer.mjs';
import { createPickMaterial, createPickTrace, exactPickOracle, comparablePick, pickMatrix } from '../tools/fixtures/pick-data-2.6.js';
function setup(t, group, eager = true) {
  const f = createRecordingRenderer(), r = f.renderer; t.after(() => f.dispose());
  r.setAdaptive(false); r.setPointSize(4);
  r.setOptimizationOptions({ spatialBuildPolicy: eager ? 'eager' : 'lazy', spatialBuildExecution: 'synchronous', spatialQueryWorker: false, liveBounds: false, movedFilter: false });
  r.append({ groups: [group] }); r._useContext(f.gl); r.matrix = pickMatrix(); r._frame.lodStride = 1;
  let event; r.onInteraction = e => { event = e; };
  return { ...f, pick(query, enabled = true) { r.setOptimizationOptions({ spatialPicking: enabled }); r.matrix = query.matrix; r._pickScreen(query.px, query.py); return { event: comparablePick(event), stats: { ...r._lastPickStats } }; } };
}
function group(xys, kind = 'points', ids = null) {
  const positions = Float32Array.from(xys.flat()), count = positions.length / 2, colors = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) colors.set([30, 135, 225, 173], i * 4);
  return { kind, positions, colors, ids: ids ? Uint32Array.from(ids) : Uint32Array.from({ length: count }, (_, i) => i + 1), featureCount: kind === 'points' ? count : count / (kind === 'lines' ? 2 : 3) };
}
for (const distribution of ['uniform', 'clusters']) test(`integrated ${distribution} picking matches independent oracle before and after 4096 public updates`, t => {
  const material = createPickMaterial({ count: 60000, distribution, seed: 1061, moved: 4096 }), f = setup(t, material.group), r = f.renderer;
  for (const updated of [false, true]) {
    if (updated) { r.trackFeatures(material.updates.map(u => u.id)); r.updateFeaturePositions(material.updates); }
    for (const p of r.pages.points) { assert.equal(p.spatialIndexedUntil, p.count); p.spatial.append = () => { throw new Error('click initiated build'); }; }
    for (const query of createPickTrace(r, 1061)) for (const enabled of [false, true]) {
      const result = f.pick(query, enabled); assert.deepEqual(result.event, exactPickOracle(r, query));
      assert.equal(result.stats.spatialPages, enabled ? r.pages.points.length : 0);
    }
  }
});
test('unfinished base tree uses full exact picking and never starts construction', t => {
  const f = setup(t, group([[0, 0], [20, 0]]), false), r = f.renderer;
  assert.equal(r.pages.points[0].spatial, null); r._ensureSpatialIndex = () => { throw new Error('forbidden click build'); };
  const q = { matrix: pickMatrix(), px: 400, py: 300 }, out = f.pick(q);
  assert.deepEqual(out.event, { hit: true, id: 1, kind: 'points', x: 0, y: 0 }); assert.equal(out.stats.fullPages, 1); assert.equal(out.stats.spatialPages, 0);
});
test('deleted/alpha-zero nearest vertices cannot win; restore returns full color eligibility', t => {
  const g = group([[0, 0], [1, 0], [2, 0]]); g.colors[3] = 0;
  const f = setup(t, g), r = f.renderer; r.trackFeatures([2]); r.removeFeatures([2]);
  const q = { matrix: pickMatrix(), px: 400, py: 300 };
  for (const enabled of [false, true]) assert.equal(f.pick(q, enabled).event.id, 3);
  r.restoreFeatures([2]); for (const enabled of [false, true]) assert.equal(f.pick(q, enabled).event.id, 2);
});
test('screen edge radius exceeds old render-page padding yet nearest candidate is preserved', t => {
  const f = setup(t, group([[408, 0]])), q = { matrix: pickMatrix(), px: 799, py: 300 };
  for (const enabled of [false, true]) assert.equal(f.pick(q, enabled).event.id, 1);
});
test('same-distance selection retains vertex/kind/page order with LOD, risk and layer gating', t => {
  const g = group([[1, 0], [0, 0], [-1, 0]]); g.colors.set([230, 70, 30, 173], 4);
  const f = setup(t, g), r = f.renderer, q = { matrix: pickMatrix(), px: 400, py: 300 };
  r._frame.lodStride = 2; r.riskPreservation = false;
  assert.equal(f.pick(q).event.id, 1);
  r.riskPreservation = true; assert.equal(f.pick(q).event.id, 2);
  r.setLayers({ points: false }); assert.equal(f.pick(q).event.hit, false);
});
for (const [kind,points] of [['lines', [[0, 0], [20, 0]]], ['polygons', [[0, 0], [20, 0], [0, 20]]]]) test(`integrated ${kind} partial deletion and absolute endpoint movement preserve vertex picking`, t => {
  const f = setup(t, group(points, kind)), r = f.renderer, q = { matrix: pickMatrix(), px: 400, py: 300 };
  r.trackFeatures([1, 2]); r.removeFeatures([1]); r.updateFeaturePositions([{ id: 2, x: 1, y: 0 }]);
  for (const enabled of [false, true]) assert.equal(f.pick(q, enabled).event.id, 2);
});
