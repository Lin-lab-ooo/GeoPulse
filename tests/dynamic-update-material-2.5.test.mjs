import test from 'node:test';
import assert from 'node:assert/strict';
import { createDynamicUpdateMaterial, createIndependentOracle, applyIndependentOperation, independentLiveBounds, flattenIndependentOracle } from '../tools/fixtures/dynamic-update-data-2.5.js';

test('predeclared material keeps complete primitives, subscription cap and append count for four distributions and two orders', () => {
  for (const distribution of ['uniform', 'clusters', 'corridor', 'separated']) for (const order of ['spatial', 'interleaved']) {
    const material = createDynamicUpdateMaterial({ distribution, order, seed: 887, pointCount: 1024 });
    assert.equal(material.stages.length, 16); assert.ok(material.tracked.length <= 4096);
    const oracle = createIndependentOracle(material.initial);
    for (const stage of material.stages) for (const action of stage.actions) applyIndependentOperation(oracle, action);
    assert.equal(flattenIndependentOracle(oracle, 'points').count, 1248);
    assert.equal(flattenIndependentOracle(oracle, 'lines').count, 128);
    assert.equal(flattenIndependentOracle(oracle, 'polygons').count, 96);
    const points = independentLiveBounds(oracle, 'points');
    assert.ok(points.minX >= -2050 && points.maxX <= 2050 && points.minY >= -2050 && points.maxY <= 2050);
  }
});
test('independent oracle moves all same-ID bindings and restores original nonopaque RGBA', () => {
  const material = createDynamicUpdateMaterial({ distribution: 'uniform', order: 'interleaved', seed: 887, pointCount: 1024 });
  const oracle = createIndependentOracle(material.initial), bindings = oracle.bindings.get(17);
  assert.equal(bindings.length, 3); applyIndependentOperation(oracle, { type: 'move', updates: [{ id: 17, x: 1.25, y: 2.5 }] });
  for (const { group, slot } of bindings) assert.deepEqual([...group.positions.subarray(slot * 2, slot * 2 + 2)], [1.25, 2.5]);
  const before = bindings.map(({ group, slot }) => [...group.colors.subarray(slot * 4, slot * 4 + 4)]);
  applyIndependentOperation(oracle, { type: 'remove', ids: [17] });
  applyIndependentOperation(oracle, { type: 'move', updates: [{ id: 17, x: 100, y: 200 }] });
  for (const { group, slot } of bindings) { assert.equal(group.colors[slot * 4 + 3], 0); assert.equal(group.positions[slot * 2], 1.25); }
  applyIndependentOperation(oracle, { type: 'restore', ids: [17] });
  bindings.forEach(({ group, slot }, i) => assert.deepEqual([...group.colors.subarray(slot * 4, slot * 4 + 4)], before[i]));
});
test('full-primitive bound includes removed endpoint and transparent but logically live geometry', () => {
  const initial = { groups: [{ kind: 'lines', positions: new Float32Array([-1000, 0, 1000, 0]), colors: new Uint8Array(8), ids: new Uint32Array([1, 2]) }] };
  const oracle = createIndependentOracle(initial); let bounds = independentLiveBounds(oracle, 'lines');
  assert.equal(bounds.livePrimitives, 1); assert.equal(bounds.minX, -1000); assert.equal(bounds.maxX, 1000);
  applyIndependentOperation(oracle, { type: 'remove', ids: [1] }); bounds = independentLiveBounds(oracle, 'lines');
  assert.equal(bounds.livePrimitives, 1); assert.equal(bounds.minX, -1000);
  applyIndependentOperation(oracle, { type: 'remove', ids: [2] }); assert.equal(independentLiveBounds(oracle, 'lines').livePrimitives, 0);
});
