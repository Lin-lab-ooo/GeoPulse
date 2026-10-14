import test from 'node:test';
import assert from 'node:assert/strict';
import { CoarseSpatialIndex } from '../public/js/coarse-spatial-index.js';

function classifier(view) {
  return b => {
    if (b.maxX < view.minX || b.minX > view.maxX || b.maxY < view.minY || b.minY > view.maxY) return -1;
    if (b.minX >= view.minX && b.maxX <= view.maxX && b.minY >= view.minY && b.maxY <= view.maxY) return 1;
    return 0;
  };
}

test('coarse buckets separate alternating distant clusters without retaining point references', () => {
  const index = new CoarseSpatialIndex();
  const positions = Float32Array.from({ length: 4000 }, (_, at) => at % 4 < 2 ? 100 : 900);
  for (let start = 0; start < 2000; start += 73) index.append(positions, start, Math.min(2000, start + 73));
  assert.equal(index.count(classifier({ minX: 450, minY: 450, maxX: 550, maxY: 550 })).primitivesSelected, 0);
  const view = classifier({ minX: 80, minY: 80, maxX: 120, maxY: 120 });
  assert.equal(index.count(view).primitivesSelected, 1000);
  positions.fill(500);
  assert.equal(index.count(view).primitivesSelected, 1000, 'summary owns copied bounds');
  assert.equal(index.getStats().primitives, 2000);
});

test('bounded folding yields a conservative count for randomly distributed full points, lines and triangles', () => {
  let seed = 20261010;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (const size of [1, 2, 3]) {
    const n = 10000, positions = Float32Array.from({ length: n * size * 2 }, () => random() * 20000 - 10000);
    const index = new CoarseSpatialIndex({ primitiveSize: size, maxBuckets: 16 });
    for (let start = 0; start < n * size; start += 91 * size) index.append(positions, start, Math.min(n * size, start + 91 * size));
    assert.ok(index.getStats().buckets <= 16);
    assert.ok(index.getStats().merges > 0);
    assert.equal(index.getStats().typedArrayBytes, 16 * 52);
    for (let query = 0; query < 20; query++) {
      const x = random() * 18000 - 9000, y = random() * 18000 - 9000;
      const classify = classifier({ minX: x, minY: y, maxX: x + 200, maxY: y + 200 });
      let exact = 0;
      for (let vertex = 0; vertex < n * size; vertex += size) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let k = vertex; k < vertex + size; k++) {
          minX = Math.min(minX, positions[k * 2]); maxX = Math.max(maxX, positions[k * 2]);
          minY = Math.min(minY, positions[k * 2 + 1]); maxY = Math.max(maxY, positions[k * 2 + 1]);
        }
        if (classify({ minX, minY, maxX, maxY }) !== -1) exact++;
      }
      const coarse = index.count(classify);
      assert.ok(coarse.primitivesSelected >= exact, `size ${size} count must be an upper bound`);
      assert.ok(coarse.primitivesSelected <= n);
      assert.ok(coarse.bucketsTested <= 16);
    }
  }
});

test('a long line or triangle crossing a viewport is counted even when its center is outside', () => {
  for (const size of [2, 3]) {
    const positions = new Float32Array(size === 2 ? [-1000, 0, 2000, 0] : [-1000, -10, 2000, -10, 2000, 100]);
    const index = new CoarseSpatialIndex({ primitiveSize: size });
    index.append(positions, 0, size);
    assert.equal(index.count(classifier({ minX: -20, minY: -20, maxX: 20, maxY: 20 })).primitivesSelected, 1);
  }
});

test('coarse append validates atomically and tracks a contiguous complete-primitive watermark', () => {
  const index = new CoarseSpatialIndex({ primitiveSize: 2 });
  const good = new Float32Array([0, 0, 1, 1, 2, 2, 3, 3]);
  index.append(good, 0, 2);
  const before = index.getStats();
  for (const [input, from, to] of [[good, 0, 2], [good, 3, 4], [good, 2, 3],
    [new Float32Array([0, 0, 1, 1, 2, 2, NaN, 3]), 2, 4]]) {
    assert.throws(() => index.append(input, from, to));
    assert.deepEqual(index.getStats(), before);
  }
  index.append(good, 2, 4);
  assert.equal(index.indexedUntil, 4);
  assert.equal(index.count(() => 1).primitivesSelected, 2);
  assert.throws(() => index.count(() => 2));
});

test('changing scale and extreme finite coordinates cannot exceed bucket memory or lose counts', () => {
  const index = new CoarseSpatialIndex({ maxBuckets: 4 });
  const coordinates = [];
  for (let power = 0; power < 120; power++) {
    const extent = 2 ** power;
    for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) coordinates.push(sx * extent, sy * extent);
  }
  const positions = new Float32Array(coordinates);
  index.append(positions, 0, 4);
  index.append(positions, 4, positions.length / 2);
  assert.ok(index.getStats().buckets <= 4);
  assert.equal(index.getStats().typedArrayBytes, 4 * 52);
  assert.equal(index.count(() => 1).primitivesSelected, positions.length / 2);
});
