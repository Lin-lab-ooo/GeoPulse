import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveBoundsIndex } from '../public/js/live-bounds-index.js';

function setup(count = 96, primitiveSize = 1, blockSize = 32) {
  const positions = new Float32Array(count * primitiveSize * 2), removed = new Uint8Array(count * primitiveSize);
  for (let p = 0; p < count; p++) for (let v = 0; v < primitiveSize; v++) positions.set([p * 10 + v, p % 13 * 7 + v], (p * primitiveSize + v) * 2);
  const index = new LiveBoundsIndex({ positions, primitiveSize, blockSize, isRemoved: v => Boolean(removed[v]) });
  return { index, positions, removed, primitiveSize, count };
}
function brute(f) {
  let b = null;
  for (let start = 0; start < f.index.indexedUntil; start += f.primitiveSize) {
    if (!Array.from({ length: f.primitiveSize }, (_, i) => !f.removed[start + i]).some(Boolean)) continue;
    for (let v = start; v < start + f.primitiveSize; v++) {
      const x = f.positions[v * 2], y = f.positions[v * 2 + 1];
      if (!b) b = [x, y, x, y]; else { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
    }
  }
  return b;
}
function checked(f, { exact = false } = {}) {
  const expected = brute(f), actual = f.index.getBounds();
  for (const n of [actual.minX, actual.minY, actual.maxX, actual.maxY]) assert.ok(Number.isFinite(n), 'published bounds stay finite');
  if (expected) {
    assert.equal(actual.empty, false);
    assert.ok(actual.minX <= expected[0] && actual.minY <= expected[1] && actual.maxX >= expected[2] && actual.maxY >= expected[3], 'published bbox covers current live complete geometry');
  }
  if (exact || actual.exact) {
    assert.equal(actual.empty, expected === null);
    assert.deepEqual([actual.minX, actual.minY, actual.maxX, actual.maxY], expected ?? [0, 0, 0, 0]);
  }
  return actual;
}
function mutate(f, starts, callback, kind = 'update') {
  const token = f.index.captureChanges(starts); callback(); return f.index.commitChanges(token, { kind });
}
function random(seed) { let n = seed >>> 0; return () => (n = (Math.imul(n, 1664525) + 1013904223) >>> 0) / 2 ** 32; }

test('fixed hierarchy, declared typed payload, empty pages and complete incremental append', () => {
  for (const size of [1, 2, 3]) for (const blockSize of [32, 64, 128, 256]) {
    const f = setup(300, size, blockSize); checked(f, { exact: true }); const before = f.index.getStats();
    assert.equal(before.primitives, 0); assert.equal(before.borrowedPositionsBytes, f.positions.byteLength); assert.ok(before.typedArrayBytes > 0);
    for (let start = 0; start < f.positions.length / 2; start += 37 * size) {
      f.index.append(start, Math.min(start + 37 * size, f.positions.length / 2)); checked(f, { exact: true });
    }
    assert.equal(f.index.getStats().typedArrayBytes, before.typedArrayBytes, 'fixed capacity does not grow');
    assert.equal(f.index.getStats().appendPrimitives, 300); assert.equal(f.index.getStats().pendingBlocks, 0);
  }
  const empty = new LiveBoundsIndex({ positions: new Float32Array(0) }); assert.equal(empty.getBounds().empty, true); assert.equal(empty.getStats().blocks, 0);
});

test('maximum complete page capacities and last Uint16 start survive update/delete/restore', () => {
  for (const size of [1, 2, 3]) {
    const f = setup(Math.floor(65535 / size), size, 64), end = f.positions.length / 2, start = end - size;
    f.index.append(0, end); checked(f, { exact: true });
    mutate(f, [start], () => { for (let v = 0; v < size; v++) f.positions.set([-99999 + v, -33333 + v], (start + v) * 2); });
    checked(f); f.index.maintain(); checked(f, { exact: true });
    mutate(f, [start], () => f.removed.fill(1, start, end), 'delete'); f.index.maintain(); checked(f, { exact: true });
    mutate(f, [start], () => { f.removed[start] = 0; }, 'restore'); checked(f, { exact: true });
    assert.equal(f.index.getStats().primitives, Math.floor(65535 / size));
    assert.equal(f.index.getStats().openCaptures, 0);
  }
  assert.throws(() => new LiveBoundsIndex({ positions: new Float32Array(65536 * 2) }), /vertexCapacity/);
  assert.throws(() => new LiveBoundsIndex({ positions: new Float32Array(65535 * 2), primitiveSize: 2 }), /vertexCapacity/);
});

test('interior motion/axis-extremum preservation avoids rescans, exterior motion expands immediately', () => {
  const f = setup(32); f.positions.set([0, 0, 100, 100, 50, 50]);
  for (let v = 3; v < 32; v++) f.positions.set([50, 50], v * 2);
  f.index.append(0, 32);
  mutate(f, [2, 2], () => f.positions.set([60, 60], 4)); checked(f, { exact: true }); assert.equal(f.index.getStats().pendingBlocks, 0);
  mutate(f, [0], () => f.positions.set([-10, 0], 0)); checked(f, { exact: true }); assert.equal(f.index.getStats().pendingBlocks, 0);
  assert.equal(f.index.maintain().scannedPrimitives, 0);
  mutate(f, [1], () => f.positions.set([70, 80], 2)); const loose = checked(f); assert.equal(loose.exact, false); assert.equal(loose.maxX, 100);
  const work = f.index.maintain({ maxPrimitives: 32 }); assert.equal(work.scannedPrimitives, 32); assert.equal(work.rescannedBlocks, 1); checked(f, { exact: true });
});

test('tied extrema, repeated updates, deletion/restore and entirely empty finite bounds', () => {
  const f = setup(64); for (let i = 0; i < 64; i++) f.positions.set([i % 2 ? 10 : 0, i % 3 ? 5 : 0], i * 2); f.index.append(0, 64);
  mutate(f, [0], () => { f.removed[0] = 1; }, 'delete'); checked(f); f.index.maintain(); checked(f, { exact: true }); assert.equal(f.index.getBounds().minX, 0);
  for (let i = 0; i < 5; i++) mutate(f, [0], () => { f.removed[0] = 0; f.positions.set([-100 - i, -100 - i], 0); }, 'restore');
  checked(f); const all = Array.from({ length: 64 }, (_, i) => i);
  mutate(f, all, () => f.removed.fill(1), 'delete'); const work = f.index.maintain();
  assert.equal(work.rescannedBlocks, 2); assert.equal(work.scannedPrimitives, 64); checked(f, { exact: true });
  mutate(f, [63], () => { f.removed[63] = 0; f.positions.set([999, -999], 126); }, 'restore'); checked(f, { exact: true });
});

test('partial removal retains the whole line/triangle bbox until every vertex is removed', () => {
  for (const size of [2, 3]) {
    const f = setup(1, size); f.positions.set([-1000, 0, 4000, 0]); if (size === 3) f.positions.set([4000, 500], 4); f.index.append(0, size);
    mutate(f, [0], () => { f.removed[0] = 1; }, 'delete'); f.index.maintain(); checked(f, { exact: true }); assert.equal(f.index.getBounds().minX, -1000);
    mutate(f, [0], () => f.removed.fill(1), 'delete'); f.index.maintain(); checked(f, { exact: true }); assert.equal(f.index.getBounds().empty, true);
    mutate(f, [0], () => { f.removed[1] = 0; }, 'restore'); checked(f, { exact: true }); assert.equal(f.index.getBounds().maxX, 4000);
  }
});

test('hard primitive budget scans complete blocks once and merges each shared ancestor once', () => {
  const f = setup(128); f.index.append(0, 128);
  const starts = [0, 1, 32, 33, 64, 65, 96, 97]; f.index.notifyChanged(starts);
  assert.equal(f.index.getStats().pendingBlocks, 4);
  const blocked = f.index.maintain({ maxPrimitives: 31 }); assert.equal(blocked.scannedPrimitives, 0); assert.equal(blocked.blockedByPrimitiveBudget, true);
  const first = f.index.maintain({ maxPrimitives: 64 }); assert.equal(first.scannedPrimitives, 64); assert.equal(first.rescannedBlocks, 2); assert.equal(first.pendingBlocks, 2); assert.equal(first.ancestorMerges, 2);
  assert.ok(first.iteratedBlocks <= 3, 'small budget does not enumerate the full dirty backlog');
  const second = f.index.maintain({ maxPrimitives: 64 }); assert.equal(second.ancestorMerges, 2); checked(f, { exact: true });
  f.index.notifyChanged(Array.from({ length: 128 }, (_, i) => i));
  const dense = f.index.maintain(); assert.equal(dense.rescannedBlocks, 4); assert.equal(dense.scannedPrimitives, 128); assert.equal(dense.ancestorMerges, 3, 'bottom-up deduplicated complete heap');
});

test('a newer append/update/delete version invalidates stale captures and tightening results', () => {
  const f = setup(64); f.index.append(0, 32); const capture = f.index.captureChanges([0]), version = f.index.getBlockVersion(0);
  f.index.append(32, 64); assert.ok(f.index.version > version);
  mutate(f, [1], () => f.positions.set([9000, 9000], 2)); f.positions.set([8000, 8000], 0);
  f.index.commitChanges(capture); checked(f); f.index.maintain(); checked(f, { exact: true });
  f.index.notifyChanged([0]); let calls = 0, fired = false;
  const clock = () => { if (++calls === 3) { fired = true; mutate(f, [0], () => f.positions.set([20000, -20000], 0)); } return calls * .1; };
  const result = f.index.maintain({ clock }); assert.equal(fired, true); assert.equal(result.discardedBlocks, 1); assert.equal(result.pendingBlocks, 1);
  checked(f); assert.equal(f.index.getBounds().maxX, 20000); f.index.maintain(); checked(f, { exact: true });
});

test('soft elapsed budget and reentrant maintenance do not clear newer pending work', () => {
  const f = setup(96); f.index.append(0, 96); f.index.notifyChanged([0, 32, 64]); let calls = 0;
  const clock = () => ++calls;
  const result = f.index.maintain({ budgetMs: 2.5, clock }); assert.equal(result.rescannedBlocks, 1); assert.equal(result.pendingBlocks, 2);
  let once = false, nested;
  const nestedClock = () => { if (!once) { once = true; nested = f.index.maintain(); } return 0; };
  f.index.maintain({ clock: nestedClock }); assert.equal(nested.reentrant, true); checked(f, { exact: true });
  f.index.notifyChanged([0]); assert.throws(() => f.index.maintain({ clock: () => { throw new Error('clock failed'); } }), /clock failed/);
  assert.throws(() => f.index.maintain({ clock: () => NaN }), /finite timestamp/);
  assert.equal(f.index.maintain().reentrant, undefined); checked(f, { exact: true });
  mutate(f, [0, 32], () => { f.positions.set([200, 20], 0); f.positions.set([400, 20], 64); });
  f.index.notifyChanged([0, 32]); let interrupted = 0;
  assert.throws(() => f.index.maintain({ clock: () => { if (++interrupted === 4) throw new Error('partial scan interruption'); return 0; } }), /partial scan/);
  checked(f); f.index.maintain(); checked(f, { exact: true });
  // Clock callbacks may keep appending dirty entries visible to a Set iterator.
  // Freeze the number of attempted targets, never rescan a block twice here.
  f.index.notifyChanged([0]); let clockCalls = 0;
  const expandsBacklog = () => { clockCalls++; f.index.notifyChanged([0, 32, 64]); return 0; };
  const bounded = f.index.maintain({ clock: expandsBacklog });
  assert.equal(bounded.initialDirtyBlocks, 1); assert.equal(bounded.iteratedBlocks, 1);
  assert.equal(bounded.scannedPrimitives, 32); assert.equal(bounded.discardedBlocks, 1); assert.equal(bounded.pendingBlocks, 3);
  assert.ok(clockCalls <= 4); checked(f); f.index.maintain(); checked(f, { exact: true });
  f.index.notifyChanged([0, 32]); let repeatCalls = 0;
  const redirtyProcessed = () => { if (++repeatCalls === 4) f.index.notifyChanged([0]); return 0; };
  const repeated = f.index.maintain({ clock: redirtyProcessed });
  assert.equal(repeated.initialDirtyBlocks, 2); assert.equal(repeated.iteratedBlocks, 2);
  assert.equal(repeated.scannedPrimitives, 64); assert.equal(repeated.pendingBlocks, 1);
  f.index.maintain(); checked(f, { exact: true });
});

test('capture memory is explicit, opaque and released on commit/discard; invalid metadata is atomic', () => {
  const f = setup(32); f.index.append(0, 32); const before = f.index.getStats(), b = f.index.getBounds();
  assert.throws(() => f.index.captureChanges([1, 100]), /complete appended/); assert.deepEqual(f.index.getBounds(), b);
  const token = f.index.captureChanges([1, 1, 2]); assert.equal(token.primitives, 2); assert.equal(token.typedArrayBytes, 86);
  assert.equal(f.index.getStats().captureTypedArrayBytes, 86); assert.equal(f.index.getStats().openCaptures, 1);
  assert.throws(() => f.index.commitChanges({}, {}), /invalid/); assert.throws(() => f.index.commitChanges(token, { kind: 'color' }), /invalid geometry/);
  f.index.discardChanges(token); assert.equal(f.index.getStats().captureTypedArrayBytes, 0); assert.throws(() => f.index.commitChanges(token), /consumed/);
  assert.equal(f.index.getStats().typedArrayBytes, before.typedArrayBytes);
  f.positions[2] = NaN; assert.throws(() => f.index.notifyChanged([1]), /finite/); assert.deepEqual(f.index.getBounds(), b); f.positions[2] = 10;
  assert.throws(() => f.index.append(0, 1), /continue/); assert.throws(() => f.index.maintain({ maxPrimitives: -1 }), /budget/);
  f.index.destroy(); assert.equal(f.index.getStats().totalOwnedTypedArrayBytes, 0); assert.equal(f.index.getStats().borrowedPositionsBytes, 0); assert.throws(() => f.index.getBounds(), /destroyed/);
});

test('deterministic randomized append/move/delete/restore batches remain conservative and tighten to independent live bounds', () => {
  for (const size of [1, 2, 3]) for (const blockSize of [32, 64, 128, 256]) {
    const f = setup(360, size, blockSize), rng = random(811 + size * blockSize); f.index.append(0, 53 * size);
    for (let step = 0; step < 90; step++) {
      if (step % 7 === 0 && f.index.indexedUntil < f.positions.length / 2) {
        const end = Math.min(f.positions.length / 2, f.index.indexedUntil + 29 * size); f.index.append(f.index.indexedUntil, end);
      } else {
        const count = f.index.indexedUntil / size, starts = Array.from({ length: 1 + Math.floor(rng() * 18) }, () => Math.floor(rng() * count) * size), kind = ['update', 'delete', 'restore'][Math.floor(rng() * 3)];
        mutate(f, starts, () => { for (const start of new Set(starts)) for (let v = 0; v < size; v++) {
          if (kind === 'update') f.positions.set([Math.fround((rng() - .5) * 90000), Math.fround((rng() - .5) * 70000)], (start + v) * 2);
          else f.removed[start + v] = kind === 'delete' ? 1 : 0;
        } }, kind);
      }
      checked(f);
      const budget = blockSize * (step % 3), result = f.index.maintain({ maxPrimitives: budget }); assert.ok(result.scannedPrimitives <= budget); checked(f);
      if (step % 11 === 0) { f.index.maintain(); checked(f, { exact: true }); }
    }
    f.index.maintain(); checked(f, { exact: true }); assert.equal(f.index.getStats().openCaptures, 0);
  }
});
