import test from 'node:test';
import assert from 'node:assert/strict';
import { planDirtyRanges } from '../public/js/dirty-ranges.js';

const bytes = (ranges) => ranges.reduce((sum, [start, end]) => sum + end - start, 0);

test('two distant point colors upload only their eight changed bytes', () => {
  const result = planDirtyRanges([[100 * 4, 101 * 4], [50000 * 4, 50001 * 4]]);
  assert.deepEqual(result, [[400, 404], [200000, 200004]]);
  assert.equal(bytes(result), 8);
});

test('adjacent point colors merge into one eight-byte upload', () => {
  assert.deepEqual(planDirtyRanges([[404, 408], [400, 404]]), [[400, 408]]);
});

test('unsorted overlaps, duplicate and empty intervals are handled without mutation', () => {
  const input = [[30, 35], [5, 12], [10, 20], [5, 12], [20, 20], [20, 25]];
  const copy = structuredClone(input);
  assert.deepEqual(planDirtyRanges(input, { mergeGapBytes: 0 }), [[5, 25], [30, 35]]);
  assert.deepEqual(input, copy);
  assert.deepEqual(planDirtyRanges([]), []);
  assert.deepEqual(planDirtyRanges([[0, 0], [50, 50]]), []);
});

test('gap merging includes the threshold boundary but excludes larger gaps', () => {
  assert.deepEqual(planDirtyRanges([[0, 4], [68, 72], [137, 141]]), [[0, 72], [137, 141]]);
  assert.deepEqual(planDirtyRanges([[0, 4], [5, 9]], { mergeGapBytes: 0 }), [[0, 4], [5, 9]]);
});

test('the range cap merges the smallest gaps first and preserves separated ranges', () => {
  assert.deepEqual(planDirtyRanges([[100, 104], [0, 4], [200, 204], [110, 114]], {
    mergeGapBytes: 0, maxRanges: 2
  }), [[0, 4], [100, 204]]);
  assert.deepEqual(planDirtyRanges([[0, 4], [100, 104], [200, 204]], {
    mergeGapBytes: 0, maxRanges: 1
  }), [[0, 204]]);
});

test('cap ties merge the earlier gap deterministically', () => {
  assert.deepEqual(planDirtyRanges([[0, 4], [10, 14], [20, 24]], {
    mergeGapBytes: 0, maxRanges: 2
  }), [[0, 14], [20, 24]]);
});

test('invalid options and endpoints are rejected rather than dropping updates', () => {
  assert.throws(() => planDirtyRanges(null), TypeError);
  for (const mergeGapBytes of [-1, 0.5, NaN, Infinity, '64']) {
    assert.throws(() => planDirtyRanges([], { mergeGapBytes }), RangeError);
  }
  for (const maxRanges of [0, -1, 0.5, NaN, Infinity, '32']) {
    assert.throws(() => planDirtyRanges([], { maxRanges }), RangeError);
  }
  for (const range of [null, [0], [0, 1, 2]]) {
    assert.throws(() => planDirtyRanges([range]), TypeError);
  }
  for (const range of [[-1, 4], [4, 3], [0.5, 4], [0, Infinity], [0, Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(() => planDirtyRanges([range]), RangeError);
  }
});

test('seeded random cases preserve every dirty interval and obey the range cap', () => {
  let state = 20261009;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let trial = 0; trial < 500; trial++) {
    const input = Array.from({ length: Math.floor(random() * 100) }, () => {
      const start = Math.floor(random() * 10000);
      return [start, start + Math.floor(random() * 100)];
    });
    const mergeGapBytes = Math.floor(random() * 80);
    const maxRanges = 1 + Math.floor(random() * 16);
    const result = planDirtyRanges(input, { mergeGapBytes, maxRanges });
    assert.ok(result.length <= maxRanges);
    for (let i = 1; i < result.length; i++) {
      assert.ok(result[i][0] > result[i - 1][1] + mergeGapBytes);
    }
    for (const [start, end] of input) {
      if (start === end) continue;
      assert.ok(result.some(([a, b]) => a <= start && b >= end), `lost [${start}, ${end})`);
    }
    if (result.length) {
      const nonempty = input.filter(([start, end]) => start !== end);
      assert.equal(result[0][0], Math.min(...nonempty.map(([start]) => start)));
      assert.equal(result.at(-1)[1], Math.max(...nonempty.map(([, end]) => end)));
    }
  }
});

test('thousands of sparse intervals remain covered under the upload cap', () => {
  const input = Array.from({ length: 4096 }, (_, i) => [i * 128, i * 128 + 4]);
  const result = planDirtyRanges(input, { mergeGapBytes: 64, maxRanges: 32 });
  assert.equal(result.length, 32);
  for (const [start, end] of input) {
    assert.ok(result.some(([a, b]) => a <= start && b >= end));
  }
});
