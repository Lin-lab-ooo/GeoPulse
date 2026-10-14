import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRecords, packBatch } from '../public/js/data.js';
import { syntheticSoakLayout, soakCompletionTimeout } from '../tools/soak-size-policy-2.6.mjs';

test('soak resource schema agrees with real packed point/line/rectangle tails', () => {
  for (const count of [1, 87, 88, 89, 98, 99, 100, 101, 199, 513]) {
    const actual = packBatch([...generateRecords({ count, seed: 20261014 })]), expected = syntheticSoakLayout(count);
    const kinds = { point: 'points', line: 'lines', polygon: 'polygons' };
    assert.equal(actual.groups.reduce((n, group) => n + group.positions.length / 2, 0), expected.totalVertices);
    for (const group of actual.groups) {
      assert.equal(group.featureCount, expected.features[kinds[group.kind]]);
      assert.equal(group.positions.length / 2, expected.vertices[kinds[group.kind]]);
    }
  }
});

test('million-feature upper bounds cover fixed page capacities including optional indices', () => {
  const actual = syntheticSoakLayout(1000000);
  assert.deepEqual(actual.features, { points: 880000, lines: 100000, polygons: 20000 });
  assert.equal(actual.totalVertices, 1200000);
  assert.deepEqual(Object.fromEntries(Object.entries(actual.pages).map(([k, v]) => [k, [v.capacity, v.count]])), { points: [65535, 14], lines: [65534, 4], polygons: [65535, 2] });
  assert.equal(actual.maxCPUBufferBytes, 23592528); assert.equal(actual.maxGPUBufferBytes, 18349744);
  assert.equal(syntheticSoakLayout(100, { pageVertices: 65 }).maxCPUBufferBytes, 4626);
  assert.equal(syntheticSoakLayout(100, { pageVertices: 65 }).maxGPUBufferBytes, 3598);
});

test('soak timeout allows explicit network pacing plus grace rather than the cycle period', () => {
  assert.equal(soakCompletionTimeout(100000), 60000);
  assert.equal(soakCompletionTimeout(1000000), 69080);
  assert.equal(soakCompletionTimeout(1000000, { delay: 0 }), 60000);
  for (const n of [0, -1, 1.5, 1000001, NaN]) assert.throws(() => syntheticSoakLayout(n), /count/);
  assert.throws(() => syntheticSoakLayout(100, { pageVertices: 1 }), /capacity/);
  assert.throws(() => soakCompletionTimeout(100, { chunk: 0 }), /inputs/);
});
