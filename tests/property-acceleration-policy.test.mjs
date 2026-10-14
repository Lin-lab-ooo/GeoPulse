import test from 'node:test';
import assert from 'node:assert/strict';
import { decideSpatialWork } from '../public/js/spatial-work-policy.js';
import { CoarseSpatialIndex } from '../public/js/coarse-spatial-index.js';
import { PrimitiveSpatialIndex } from '../public/js/spatial-index.js';

const input = { primitiveCount: 100, coarseUpperBound: 20, coarseComplete: true, maxCandidateRatio: .15, denseGate: 'upper-heuristic' };
test('cold gate selects work without treating an upper bound as exact visibility', () => {
  assert.equal(decideSpatialWork(input).action, 'dense-fallback');
  assert.equal(decideSpatialWork({ ...input, coarseUpperBound: 15 }).action, 'refine');
  assert.equal(decideSpatialWork({ ...input, coarseUpperBound: 0 }).action, 'empty');
  assert.equal(decideSpatialWork({ ...input, maxCandidateRatio: 1 }).action, 'refine');
});
test('existing fine work, an incomplete summary and moved geometry bypass the cold gate', () => {
  for (const override of [{ hasFineIndex: true }, { hasWorkerPage: true }, { coarseComplete: false },
    { hasMovedGeometry: true }, { hasRemovedGeometry: true }, { lazyBuild: false }]) {
    for (const coarseUpperBound of [0, 100]) {
      assert.equal(decideSpatialWork({ ...input, coarseUpperBound, ...override }).action, 'refine');
    }
  }
});
test('gate budget uses primitive counts consistently for points, lines and triangles', () => {
  for (const size of [1, 2, 3]) {
    const vertices = 300 * size;
    assert.equal(decideSpatialWork({ primitiveCount: vertices / size, coarseUpperBound: 45,
      coarseComplete: true, maxCandidateRatio: .15, denseGate: 'upper-heuristic' }).action, 'refine');
    assert.equal(decideSpatialWork({ primitiveCount: vertices / size, coarseUpperBound: 46,
      coarseComplete: true, maxCandidateRatio: .15, denseGate: 'upper-heuristic' }).action, 'dense-fallback');
  }
});
test('a coarse false positive cannot block an already retained selective fine tree', () => {
  const positions = new Float32Array(200 * 2);
  for (let i = 0; i < 100; i++) { positions[i * 2] = i; positions[i * 2 + 1] = i % 2 ? 20 : 100; }
  for (let i = 100; i < 200; i++) { positions[i * 2] = i; positions[i * 2 + 1] = i % 2 ? 20 : 100; }
  const classify = b => b.minY > 65 || b.maxY < 55 ? -1 : 0;
  const coarse = new CoarseSpatialIndex({ maxBuckets: 4 }); coarse.append(positions, 0, 200);
  const fine = new PrimitiveSpatialIndex({ leafSize: 8, minExtent: 0 }); fine.append(positions, 0, 200);
  const upper = coarse.count(classify).primitivesSelected;
  assert.ok(upper >= fine.count(classify).primitivesSelected);
  assert.equal(upper, 200);
  assert.equal(fine.count(classify).primitivesSelected, 0);
  assert.equal(decideSpatialWork({ primitiveCount: 200, coarseUpperBound: upper, coarseComplete: true,
    hasFineIndex: true }).action, 'refine');
});
test('a full crossing line remains eligible even when its centroid is outside the view', () => {
  const positions = new Float32Array([-1000, 0, 2000, 0]);
  const classify = b => b.maxX < -20 || b.minX > 20 || b.maxY < -20 || b.minY > 20 ? -1 : 0;
  const coarse = new CoarseSpatialIndex({ primitiveSize: 2 }); coarse.append(positions, 0, 2);
  const upper = coarse.count(classify).primitivesSelected;
  assert.equal(upper, 1);
  assert.equal(decideSpatialWork({ primitiveCount: 1, coarseUpperBound: upper, coarseComplete: true }).action, 'refine');
  assert.equal(decideSpatialWork({ primitiveCount: 1, coarseUpperBound: upper, coarseComplete: true, denseGate: 'upper-heuristic' }).action, 'dense-fallback');
});
test('unsafe metadata is rejected, while unavailable summaries fail open', () => {
  for (const primitiveCount of [-1, 1.2, Infinity]) assert.throws(() => decideSpatialWork({ ...input, primitiveCount }), RangeError);
  for (const coarseUpperBound of [-1, 101, 1.2, NaN, null]) assert.throws(() => decideSpatialWork({ ...input, coarseUpperBound }), RangeError);
  for (const maxCandidateRatio of [0, -1, 1.01, NaN]) assert.throws(() => decideSpatialWork({ ...input, maxCandidateRatio }), RangeError);
  assert.equal(decideSpatialWork({ primitiveCount: 100 }).action, 'refine');
});
test('production default requires a proven dense lower bound, not a high loose upper bound', () => {
  const base = { primitiveCount: 100, coarseUpperBound: 90, coarseComplete: true };
  assert.equal(decideSpatialWork(base).action, 'refine');
  assert.equal(decideSpatialWork({ ...base, coarseLowerBound: 15 }).action, 'refine');
  assert.equal(decideSpatialWork({ ...base, coarseLowerBound: 16 }).action, 'dense-fallback');
  assert.equal(decideSpatialWork({ ...base, coarseLowerBound: 16 }).reason, 'proven-coarse-density');
  for (const coarseLowerBound of [-1, .5, 91, Infinity]) {
    assert.throws(() => decideSpatialWork({ ...base, coarseLowerBound }), RangeError);
  }
  assert.throws(() => decideSpatialWork({ ...base, denseGate: 'unknown' }), RangeError);
});
