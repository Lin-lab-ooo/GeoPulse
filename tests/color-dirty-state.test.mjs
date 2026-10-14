import test from 'node:test';
import assert from 'node:assert/strict';
import { ColorDirtyState } from '../public/js/color-dirty-state.js';
import { planDirtyRanges } from '../public/js/dirty-ranges.js';
const B = 65535 * 4;
const exact = state => state.peekPlan({ bufferBytes: state.capacity * 4, mergeGapBytes: 0, maxRanges: 65535 });
const byteCount = ranges => ranges.reduce((sum, [a, b]) => sum + b - a, 0);
const slotsOf = ranges => {
  const slots = new Set(); for (const [a, b] of ranges) for (let slot = a / 4; slot < b / 4; slot++) slots.add(slot);
  return [...slots].sort((a, b) => a - b);
};

test('tiny marks preserve distant eight bytes and adjacent one-call legacy semantics', () => {
  const state = new ColorDirtyState(); state.mark(50000); state.mark(100);
  let plan = state.peekPlan({ bufferBytes: B }); assert.deepEqual(plan.ranges, [[400, 404], [200000, 200004]]);
  assert.equal(plan.uniqueDirtyBytes, 8); assert.equal(state.getStats().storage, 'tiny'); assert.equal(state.clear(plan.token), true);
  state.mark(101); state.mark(100); plan = state.peekPlan({ bufferBytes: B });
  assert.deepEqual(plan.ranges, [[400, 408]]); assert.equal(state.clear(plan.token), true);
  state.mark(0); state.mark(17); assert.deepEqual(state.peekPlan({ bufferBytes: B }).ranges, [[0, 72]]);
  assert.deepEqual(state.peekPlan({ bufferBytes: B, mergeGapBytes: 0 }).ranges, [[0, 4], [68, 72]]);
  assert.deepEqual(state.peekPlan({ bufferBytes: B, mergeGapBytes: 0, maxRanges: 1 }).ranges, [[0, 72]]);
});
test('duplicates count unique once but stale token cannot clear newer color on same slot', () => {
  const state = new ColorDirtyState(); assert.equal(state.mark(31), true);
  const old = state.peekPlan({ bufferBytes: B }); assert.equal(state.mark(31), false);
  assert.equal(state.getStats().pendingUniqueVertices, 1); assert.equal(state.getStats().pendingMarks, 2);
  assert.equal(state.pendingUniqueVertices, 1);
  assert.equal(state.clear(old.token), false); const current = state.peekPlan({ bufferBytes: B });
  assert.equal(state.clear({ ...current.token }), false); assert.equal(state.clear(current.token), true);
  assert.equal(state.getStats().pendingUniqueVertices, 0);
});
test('tiny hash represents slot zero and maximum slot without an empty-key collision', () => {
  const state = new ColorDirtyState(); for (const slot of [65534, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) state.mark(slot);
  assert.equal(state.mark(65534), false); assert.equal(state.mark(0), false);
  assert.equal(state.getStats().pendingUniqueVertices, 12);
  assert.deepEqual(slotsOf(exact(state).ranges), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 65534]);
});
test('old-prefix peek excludes appended slots and refuses clearing uncommitted tail', () => {
  const state = new ColorDirtyState(); for (const slot of [2, 4, 8, 31]) state.mark(slot);
  const plan = state.peekPlan({ bufferBytes: 8 * 4, mergeGapBytes: 0 });
  assert.deepEqual(plan.ranges, [[8, 12], [16, 20]]); assert.equal(plan.uniqueDirtyBytes, 8);
  assert.equal(plan.excludedUniqueVertices, 2); assert.equal(plan.token.includesAllMarks, false);
  assert.equal(state.clear(plan.token), false); assert.equal(state.getStats().pendingUniqueVertices, 4);
  assert.equal(state.clear(plan.token, { tailUploaded: true }), true); assert.equal(state.getStats().pendingUniqueVertices, 0);
});
test('empty old prefix keeps marks unless full append was explicitly committed', () => {
  const state = new ColorDirtyState(); state.mark(300); const plan = state.peekPlan({ bufferBytes: 0 });
  assert.deepEqual(plan.ranges, []); assert.equal(plan.uniqueDirtyBytes, 0); assert.equal(state.clear(plan.token), false);
  assert.equal(state.clear(plan.token, { tailUploaded: true }), true);
});
test('512 unique slots promote once, retain exact min/max and choose bounded dense span', () => {
  const state = new ColorDirtyState(); for (let i = 0; i < 511; i++) state.mark(1000 + i * 2);
  assert.equal(state.getStats().storage, 'tiny'); for (let i = 0; i < 1000; i++) state.mark(1000);
  assert.equal(state.getStats().storage, 'tiny'); state.mark(1000 + 511 * 2);
  const plan = state.peekPlan({ bufferBytes: B }); assert.equal(state.getStats().storage, 'bitmap');
  assert.equal(plan.uniqueDirtyBytes, 2048); assert.equal(plan.spanBytes, 4092); assert.equal(plan.uploadedBytes, 4092);
  assert.equal(plan.choice, 'accumulator-span'); assert.equal(plan.fastPathBoundPassed, true);
  assert.equal(state.getStats().pendingMinVertex, 1000); assert.equal(state.getStats().pendingMaxVertexExclusive, 2023);
});
test('half-page dirty bitmap can upload full old prefix without exceeding 2x true unique bytes', () => {
  const state = new ColorDirtyState(); for (let slot = 0; slot < 65535; slot += 2) state.mark(slot);
  const plan = state.peekPlan({ bufferBytes: B }); assert.equal(plan.choice, 'accumulator-full');
  assert.equal(plan.uniqueDirtyBytes, 32768 * 4); assert.deepEqual(plan.ranges, [[0, B]]);
  assert.ok(plan.uploadedBytes <= plan.uniqueDirtyBytes * 2);
});
test('sparse bitmap uses legacy cap tradeoff; custom gap/cap always preserves legacy results', () => {
  const state = new ColorDirtyState(), input = [];
  for (let slot = 0; slot < 65535; slot += 64) { state.mark(slot); input.push([slot * 4, slot * 4 + 4]); }
  for (const options of [{}, { mergeGapBytes: 0, maxRanges: 64 }, { mergeGapBytes: 1024, maxRanges: 32 }, { maxRanges: 1 }]) {
    const plan = state.peekPlan({ bufferBytes: B, ...options });
    assert.deepEqual(plan.ranges, planDirtyRanges(input, options)); assert.equal(plan.choice, 'accumulator-legacy');
  }
});
test('bitmap runs cross word boundaries and prefix masking excludes bit31 and future slots correctly', () => {
  for (const limit of [1, 31, 32, 33, 63, 64, 65, 65535]) {
    const state = new ColorDirtyState({ promoteAt: 2 });
    for (const slot of [0, 1, 30, 31, 32, 33, 62, 63, 64, 65, 65534]) state.mark(slot);
    const plan = state.peekPlan({ bufferBytes: limit * 4, mergeGapBytes: 0, maxRanges: 65535 });
    const expected = [0, 1, 30, 31, 32, 33, 62, 63, 64, 65, 65534].filter(slot => slot < limit);
    assert.deepEqual(slotsOf(plan.ranges), expected); assert.equal(plan.uniqueDirtyBytes, expected.length * 4);
  }
});
test('full 32-bit masks and cross-word contiguous runs produce exact ordered ranges', () => {
  const state = new ColorDirtyState({ capacity: 130, promoteAt: 2 });
  for (let slot = 0; slot < 130; slot++) state.mark(slot);
  assert.deepEqual(exact(state).ranges, [[0, 520]]);
  state.reset(); for (let slot = 30; slot < 65; slot++) state.mark(slot);
  assert.deepEqual(exact(state).ranges, [[120, 260]]);
});
test('successful clear only touches dirty bitmap words; reset/release invalidate tokens and erase state', () => {
  const state = new ColorDirtyState({ promoteAt: 2 }); state.mark(0); state.mark(65534);
  const plan = exact(state), memory = state.getStats().memoryBytes;
  assert.equal(memory, 8192 + 4096); assert.equal(state.getStats().touchedWords, 2);
  assert.equal(state.clear(plan.token), true); assert.equal(state.getStats().storage, 'bitmap');
  assert.equal(state.getStats().memoryBytes, memory); state.mark(31); assert.deepEqual(exact(state).ranges, [[124, 128]]);
  const beforeReset = exact(state); state.reset(); assert.equal(state.clear(beforeReset.token), false);
  state.reset({ release: true }); assert.equal(state.getStats().storage, 'tiny'); assert.equal(state.getStats().memoryBytes, 16);
  state.mark(100); assert.deepEqual(exact(state).ranges, [[400, 404]]);
});
test('invalid slots/plans/options do not change pending marks or permit accidental success clearing', () => {
  const state = new ColorDirtyState(); state.mark(7); const plan = exact(state), stats = state.getStats();
  for (const slot of [-1, 65535, 0.5, NaN, Infinity, '4']) assert.throws(() => state.mark(slot), RangeError);
  for (const bufferBytes of [-1, 1, B + 4, Infinity, '8']) assert.throws(() => state.peekPlan({ bufferBytes }), RangeError);
  for (const options of [{ mergeGapBytes: -1 }, { maxRanges: 0 }, { maxRanges: 1.5 }]) assert.throws(() => state.peekPlan({ bufferBytes: B, ...options }), RangeError);
  assert.throws(() => state.clear(plan.token, { tailUploaded: 'false' }), TypeError);
  assert.throws(() => state.reset({ release: 1 }), TypeError); assert.deepEqual(state.getStats(), stats);
  assert.throws(() => new ColorDirtyState({ capacity: 65536 }), RangeError);
  assert.throws(() => new ColorDirtyState({ promoteAt: 513 }), RangeError);
});
test('deterministic random lifecycle retains every unique slot through duplicates, prefixes and bitmap resets', () => {
  let seed = 1807; const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (const promoteAt of [2, 8, 512]) {
    const state = new ColorDirtyState({ capacity: 4096, promoteAt });
    for (let epoch = 0; epoch < 20; epoch++) {
      const expected = new Set(); for (let i = 0; i < 900; i++) { const slot = Math.floor(random() * 4096); state.mark(slot); expected.add(slot); }
      const limit = Math.floor(random() * 4097), expectedPrefix = [...expected].filter(slot => slot < limit).sort((a, b) => a - b);
      const plan = state.peekPlan({ bufferBytes: limit * 4, mergeGapBytes: 0, maxRanges: 4096 });
      assert.deepEqual(slotsOf(plan.ranges), expectedPrefix); assert.equal(byteCount(plan.ranges), expectedPrefix.length * 4);
      assert.equal(state.getStats().pendingUniqueVertices, expected.size); const all = exact(state);
      assert.deepEqual(slotsOf(all.ranges), [...expected].sort((a, b) => a - b)); assert.equal(state.clear(all.token), true);
    }
  }
});
