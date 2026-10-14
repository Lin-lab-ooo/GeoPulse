import test from 'node:test';
import assert from 'node:assert/strict';
import { createDensityUploadPlanner } from '../tools/fixtures/upload-density-policy-2.3.js';
import { planDirtyRanges } from '../tools/fixtures/research-2.2/public/js/dirty-ranges.js';
const B = 65535 * 4;
const bytes = ranges => ranges.reduce((n, [a, b]) => n + b - a, 0);
const uniqueBytes = ranges => new Set(ranges.flatMap(([a, b]) => Array.from({ length: (b - a) / 4 }, (_, i) => a / 4 + i))).size * 4;

test('constant tiny planner preserves two distant 8B and merges neighbours and overlaps without sort', () => {
  const plan = createDensityUploadPlanner();
  assert.deepEqual(plan([[200000, 200004], [400, 404]], B).ranges, [[400, 404], [200000, 200004]]);
  assert.deepEqual(plan([[404, 408], [400, 404]], B).ranges, [[400, 408]]);
  assert.deepEqual(plan([[8, 16], [4, 12]], B).ranges, [[4, 16]]);
  assert.deepEqual(plan([[0, 4], [68, 72]], B).ranges, [[0, 72]]);
  assert.deepEqual(plan([[0, 4], [69, 73]], B).ranges, [[0, 4], [69, 73]]);
});
test('compact dense and half-page global updates satisfy exact 2x unique byte bound', () => {
  const plan = createDensityUploadPlanner();
  const compact = Array.from({ length: 512 }, (_, i) => [4000 + i * 8, 4004 + i * 8]);
  const dense = plan(compact, B); assert.equal(dense.choice, 'density-span'); assert.equal(dense.uniqueDirtyBytes, 2048);
  assert.equal(bytes(dense.ranges), 4092); assert.equal(dense.fastPathBoundPassed, true);
  const global = Array.from({ length: 32768 }, (_, i) => [i * 8, i * 8 + 4]);
  const wide = plan(global, B); assert.equal(wide.choice, 'density-full'); assert.equal(wide.uniqueDirtyBytes, 131072);
  assert.equal(bytes(wide.ranges), B); assert.ok(wide.uploadFactor <= 2);
});
test('duplicate sparse endpoints cannot fake dense updates and inherit legacy fallback only', () => {
  const plan = createDensityUploadPlanner();
  const ranges = Array.from({ length: 512 }, (_, i) => i % 2 ? [200000, 200004] : [400, 404]);
  const result = plan(ranges, B); assert.equal(result.choice, 'density-legacy'); assert.equal(result.uniqueDirtyBytes, 8);
  assert.equal(result.reason, 'span exceeds 2x exact unique dirty bytes'); assert.deepEqual(result.ranges, [[400, 404], [200000, 200004]]);
});
test('overlapping whole-page ranges count unique bytes once and skip full interior words', () => {
  const plan = createDensityUploadPlanner(), ranges = Array.from({ length: 512 }, () => [0, B]);
  const result = plan(ranges, B); assert.equal(result.uniqueDirtyBytes, B); assert.equal(result.choice, 'density-full');
  assert.equal(result.interiorWordsVisited, 2046); assert.equal(result.endpointWordsVisited, 1024);
  assert.equal(result.bitmapBytes, 8192); assert.equal(result.skipIndexBytes, 4098);
});
test('bitmap resets between calls, masks partial last word and counts overlaps accurately', () => {
  const plan = createDensityUploadPlanner();
  for (const points of [1, 31, 32, 33, 63, 64, 65]) {
    const ranges = Array.from({ length: 512 }, (_, i) => [Math.min(i % points, points - 1) * 4, Math.min(i % points, points - 1) * 4 + 4]);
    const result = plan(ranges, points * 4); assert.equal(result.uniqueDirtyBytes, points * 4); assert.equal(bytes(result.ranges), points * 4);
  }
  const overlap = Array.from({ length: 512 }, (_, i) => [i % 100 * 4, (i % 100 + 3) * 4]);
  assert.equal(plan(overlap, B).uniqueDirtyBytes, uniqueBytes(overlap));
});
test('not RGBA-aligned or too large buffer uses generic legacy while invalid ranges reject', () => {
  const plan = createDensityUploadPlanner(), unaligned = Array.from({ length: 512 }, (_, i) => [i * 5, i * 5 + 3]);
  assert.deepEqual(plan(unaligned, B).ranges, planDirtyRanges(unaligned));
  assert.equal(plan(unaligned, B).reason, 'not RGBA4-aligned single-page ranges');
  assert.equal(plan(Array.from({ length: 512 }, (_, i) => [i * 4, i * 4 + 4]), B + 4).choice, 'density-legacy');
  for (const invalid of [[-1, 3], [0, B + 1], [3, 2], [0, 1.5], [0, Infinity], null]) assert.throws(() => plan([invalid], B), RangeError);
  assert.throws(() => plan([], -1), RangeError); assert.throws(() => plan(null, B), TypeError);
  assert.deepEqual(plan([], 0).ranges, []); assert.deepEqual(plan([[4, 4]], 4).ranges, []);
});
test('seeded intervals validate exact unique accounting and density-branch byte bounds without mutating input', () => {
  const plan = createDensityUploadPlanner(); let state = 1201;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let trial = 0; trial < 40; trial++) {
    const ranges = Array.from({ length: 512 }, () => { const a = Math.floor(random() * 3000), width = 1 + Math.floor(random() * 15); return [a * 4, (a + width) * 4]; });
    const original = structuredClone(ranges), result = plan(ranges, B);
    assert.deepEqual(ranges, original); assert.equal(result.uniqueDirtyBytes, uniqueBytes(ranges));
    for (const [a, b] of ranges) assert.ok(result.ranges.some(([x, y]) => x <= a && y >= b));
    if (result.choice !== 'density-legacy') assert.ok(bytes(result.ranges) <= 2 * uniqueBytes(ranges));
  }
});
