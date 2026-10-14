import test from 'node:test';
import assert from 'node:assert/strict';
import { PrimitiveSpatialIndex } from '../public/js/spatial-index.js';
import { createPickMatrix, queryPickPrimitiveStarts } from '../public/js/pick-spatial.js';
const width = 800, height = 600;
function matrix({ heading = 0, tilt = 0, tx = 0, ty = 0 } = {}) {
  const m = new Float64Array(16), c = Math.cos(heading), s = Math.sin(heading);
  m[0] = 2 * c / width; m[4] = -2 * s / width; m[1] = 2 * s / height; m[5] = 2 * c / height;
  m[3] = tilt * s; m[7] = tilt * c; m[10] = m[15] = 1; m[12] = tx; m[13] = ty; return m;
}
function rng(seed) { return () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32); }
function material(size = 1, clustered = false, seed = 19, n = 2048) {
  const random = rng(seed), positions = new Float32Array(n * size * 2), colors = new Uint8Array(n * size * 4).fill(255), removed = new Set();
  for (let p = 0; p < n; p++) {
    const cx = clustered ? (p % 4 - 1.5) * 280 : 0, cy = clustered ? (p % 3 - 1) * 220 : 0;
    const spread = clustered ? 90 : 1800;
    for (let v = 0; v < size; v++) positions.set([cx + (random() - .5) * spread, cy + (random() - .5) * spread], (p * size + v) * 2);
  }
  const spatial = new PrimitiveSpatialIndex({ primitiveSize: size, leafSize: 8, minExtent: 0 }); spatial.append(positions, 0, n * size);
  return { positions, count: n * size, primitiveSize: size, spatial, spatialIndexedUntil: n * size, movedPrimitiveStarts: new Set(), colors, removed };
}
function candidates(f, view, px, py, radius = 13) { return queryPickPrimitiveStarts({ ...f, matrix: view, width, height, px, py, radius }); }
// Independent exact narrow phase. No projected-bounds or tree helper is called.
function exact(f, m, px, py, radius, starts = null, stride = 1) {
  let best = -1, distance = radius ** 2;
  const testVertex = vertex => {
    if (f.removed.has(vertex) || f.colors[vertex * 4 + 3] === 0 || (f.primitiveSize === 1 && vertex % stride !== 0)) return;
    const x = f.positions[vertex * 2], y = f.positions[vertex * 2 + 1], w = m[3] * x + m[7] * y + m[15];
    if (!(w > 0)) return;
    const sx = ((m[0] * x + m[4] * y + m[12]) / w + 1) * width / 2;
    const sy = (1 - (m[1] * x + m[5] * y + m[13]) / w) * height / 2;
    const d = (sx - px) ** 2 + (sy - py) ** 2;
    if (d < distance) { distance = d; best = vertex; }
  };
  if (starts === null) for (let i = 0; i < f.count; i++) testVertex(i);
  else for (const start of starts) for (let i = 0; i < f.primitiveSize; i++) testVertex(start + i);
  return { best, distance };
}
function match(f, m, px, py, radius = 13, stride = 1) {
  const query = candidates(f, m, px, py, radius);
  if (query.starts) { assert.deepEqual([...query.starts], [...query.starts].sort((a, b) => a - b)); assert.equal(new Set(query.starts).size, query.starts.length); assert.ok(query.starts.every(n => n % f.primitiveSize === 0)); }
  assert.deepEqual(exact(f, m, px, py, radius, query.starts, stride), exact(f, m, px, py, radius, null, stride)); return query;
}
for (const clustered of [false, true]) for (const [viewName, view] of [['flat', matrix()], ['rotated', matrix({ heading: .73, tx: .2 })], ['perspective', matrix({ heading: .41, tilt: .0017, ty: -.15 })]]) {
  test(`${clustered ? 'clustered' : 'uniform'} ${viewName}: exact nearest vertex equals brute without building or mutating tree`, () => {
    const f = material(1, clustered), before = f.spatial.getStats(), random = rng(819);
    f.spatial.append = () => { throw new Error('query must not build'); };
    for (let n = 0; n < 75; n++) match(f, view, random() * width, random() * height, 13, n % 5 ? 1 : 3);
    assert.deepEqual(f.spatial.getStats(), before);
  });
}
test('tiny cursor rectangle substantially reduces uniform candidates while preserving nearest ties', () => {
  const f = material(), view = matrix(), q = match(f, view, 400, 300);
  assert.equal(q.mode, 'spatial'); assert.ok(q.candidatePrimitives < f.count / 10);
  f.positions.set([0, 0, 0, 0], 0); f.movedPrimitiveStarts.add(0); f.movedPrimitiveStarts.add(1);
  assert.equal(match(f, view, 400, 300).starts[0], 0); assert.equal(exact(f, view, 400, 300, 13).best, 0);
});
test('moves remove stale base candidates and include current entering locations even across horizon', () => {
  const f = material(1, false, 27), view = matrix({ heading: .4, tilt: .002 });
  const initial = f.positions.slice(0, 2);
  f.positions.set([0, 0], 0); f.movedPrimitiveStarts.add(0);
  const entered = match(f, view, 400, 300); assert.ok(entered.starts.includes(0)); assert.equal(exact(f, view, 400, 300, 13).best, 0);
  f.positions.set([50000, 50000], 0); const left = match(f, view, 400, 300); assert.ok(!left.starts.includes(0)); assert.ok(left.movedRejected > 0);
  f.positions.set(initial, 0); match(f, view, 400, 300);
  f.positions.set([0, -501], 0); match(f, matrix({ tilt: .002 }), 400, 300);
});
for (const size of [2, 3]) test(`${size}-vertex primitives preserve complete current bbox after one independent endpoint moves`, () => {
  const f = material(size, false, 719, 512), view = matrix({ heading: -.34, tilt: .0002 });
  for (let v = 0; v < size; v++) f.positions.set([2000 + v, 0], v * 2);
  f.movedPrimitiveStarts.add(0); f.positions.set([0, 0], 0);
  const q = match(f, view, 400, 300); assert.ok(q.starts.includes(0));
  f.removed.add(0); f.colors[3] = 0; match(f, view, 400, 300);
  for (let i = 0; i < f.count; i++) f.removed.add(i);
  const all = match(f, view, 400, 300); assert.equal(exact(f, view, 400, 300, 13, all.starts).best, -1);
});
test('a crossing line/triangle remains a candidate even when its vertices are outside the cursor square', () => {
  for (const size of [2, 3]) {
    const f = material(size, false, 55, 1);
    f.positions.set([-200, 0, 200, 0]); if (size === 3) f.positions.set([0, 200], 4); f.movedPrimitiveStarts.add(0);
    const q = candidates(f, matrix(), 400, 300); assert.deepEqual([...q.starts], [0]);
    assert.equal(exact(f, matrix(), 400, 300, 13, q.starts).best, -1, 'broad phase does not invent line-interior hit semantics');
  }
});
test('pending/missing tree falls back without querying or allocating a full candidate list', () => {
  const f = material(); f.spatial.query = () => { throw new Error('pending query forbidden'); };
  f.spatialIndexedUntil--;
  assert.deepEqual(candidates(f, matrix(), 400, 300), { mode: 'full', starts: null, candidatePrimitives: f.count, nodesTested: 0, movedTested: 0, movedRejected: 0, baseMovedSkipped: 0 });
  f.spatial = null; f.spatialIndexedUntil = f.count; assert.equal(candidates(f, matrix(), 400, 300).mode, 'full');
});
test('invalid camera dimensions/radius or projection overflow conservatively falls back', () => {
  const f = material(), m = matrix();
  for (const parameters of [{ width: 0 }, { height: NaN }, { radius: 0 }, { px: Infinity }, { matrix: [1, 2] }, { matrix: new Float64Array(16).fill(Infinity) }]) {
    assert.equal(queryPickPrimitiveStarts({ ...f, matrix: m, width, height, px: 400, py: 300, radius: 13, ...parameters }).mode, 'full');
  }
  const huge = matrix(); huge[0] = Number.MAX_VALUE;
  assert.equal(createPickMatrix(huge, { width, height, px: 400, py: 300, radius: 1e-20 }), null);
});
test('all alpha-zero and deleted nearest objects remain absent under the exact caller filter', () => {
  const f = material(); f.positions.set([0, 0, 1, 0, 2, 0]); [0, 1, 2].forEach(i => f.movedPrimitiveStarts.add(i));
  f.colors[3] = 0; f.removed.add(1);
  const q = match(f, matrix(), 400, 300); assert.equal(exact(f, matrix(), 400, 300, 13, q.starts).best, 2);
});
test('query square encloses strict-circle boundary hits despite off-center recentering', () => {
  const f = material(1, false, 19, 3), view = matrix(), px = 723, py = 59, r = 13;
  for (let i = 0; i < 3; i++) { f.positions.set([px - width / 2 + r - .001 * (i + 1), height / 2 - py], i * 2); f.movedPrimitiveStarts.add(i); }
  const q = match(f, view, px, py, r); assert.equal(q.starts.length, 3);
});
test('invalid partial primitive inputs fail before any tree query', () => {
  const f = material(3); f.spatial.query = () => { throw new Error('no query'); };
  assert.throws(() => candidates({ ...f, count: f.count - 1 }, matrix(), 400, 300), /complete primitives/);
});

test('old base slot is explicitly masked after its current geometry leaves the pick rectangle', () => {
  const positions = new Float32Array([0, 0, 1000, 1000]);
  const spatial = new PrimitiveSpatialIndex({ leafSize: 1, minExtent: 0 }); spatial.append(positions, 0, 2);
  const f = { positions, count: 2, primitiveSize: 1, spatial, spatialIndexedUntil: 2, movedPrimitiveStarts: new Set([0]) };
  positions.set([2000, 2000], 0);
  const q = candidates(f, matrix(), 400, 300);
  assert.equal(q.baseMovedSkipped, 1); assert.equal(q.movedTested, 1); assert.equal(q.movedRejected, 1); assert.deepEqual([...q.starts], []);
});

test('current page envelope shortcut skips enumeration for fully coincident candidates', () => {
  const positions = new Float32Array(120000), spatial = new PrimitiveSpatialIndex(); spatial.append(positions, 0, 60000);
  spatial.query = () => { throw new Error('contained page must not enumerate or sort'); };
  const f = { positions, count: 60000, primitiveSize: 1, spatial, spatialIndexedUntil: 60000, currentBounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } };
  const q = candidates(f, matrix(), 400, 300); assert.equal(q.mode, 'full'); assert.equal(q.starts, null); assert.equal(q.candidatePrimitives, 60000);
  const outside = candidates(f, matrix(), 600, 300); assert.equal(outside.mode, 'spatial'); assert.deepEqual([...outside.starts], []);
});
test('current expanded envelope cannot hide a moved-in primitive absent from the base root', () => {
  const positions = new Float32Array([2000, 2000]), spatial = new PrimitiveSpatialIndex(); spatial.append(positions, 0, 1); positions.set([0, 0]);
  const f = { positions, count: 1, primitiveSize: 1, spatial, spatialIndexedUntil: 1, movedPrimitiveStarts: new Set([0]), currentBounds: { minX: 0, minY: 0, maxX: 2000, maxY: 2000 } };
  const q = candidates(f, matrix(), 400, 300); assert.ok(q.starts.includes(0));
});
