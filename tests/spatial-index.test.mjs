import test from 'node:test';
import assert from 'node:assert/strict';
import { PrimitiveSpatialIndex } from '../public/js/spatial-index.js';

function classifier(view) {
  return bounds => {
    if (bounds.maxX < view.minX || bounds.minX > view.maxX
      || bounds.maxY < view.minY || bounds.minY > view.maxY) return -1;
    if (bounds.minX >= view.minX && bounds.maxX <= view.maxX
      && bounds.minY >= view.minY && bounds.maxY <= view.maxY) return 1;
    return 0;
  };
}

function collect(index, view) {
  const starts = [];
  const stats = index.query(classifier(view), start => starts.push(start));
  assert.equal(new Set(starts).size, starts.length, 'one reference per primitive');
  assert.equal(stats.primitivesSelected, starts.length);
  assert.equal(index.count(classifier(view)).primitivesSelected, starts.length, 'count and query select the same conservative candidates');
  return { starts, stats };
}

test('alternating distant clusters reject the empty middle and select only cluster A', () => {
  const positions = new Float32Array(2000 * 2);
  for (let pair = 0; pair < 1000; pair++) {
    positions.set([90 + pair % 21, 90 + Math.floor(pair / 21) % 21], pair * 4);
    positions.set([890 + pair % 21, 890 + Math.floor(pair / 21) % 21], pair * 4 + 2);
  }
  for (const leafSize of [64, 256]) {
    const index = new PrimitiveSpatialIndex({ leafSize });
    for (let start = 0; start < 2000; start += 73) index.append(positions, start, Math.min(2000, start + 73));
    assert.equal(collect(index, { minX: 450, minY: 450, maxX: 550, maxY: 550 }).starts.length, 0, `leafSize ${leafSize} rejects the empty gap`);
    const selected = collect(index, { minX: 80, minY: 80, maxX: 120, maxY: 120 }).starts;
    assert.equal(selected.length, 1000, `leafSize ${leafSize} selects exactly A`);
    assert.ok(selected.every(start => start % 2 === 0));
  }
});

test('random queries never miss a primitive whose complete bounds intersect', () => {
  let seed = 20261009;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (const primitiveSize of [1, 2, 3]) {
    const count = 600;
    const positions = new Float32Array(count * primitiveSize * 2);
    for (let offset = 0; offset < positions.length; offset++) positions[offset] = random() * 2000 - 1000;
    const index = new PrimitiveSpatialIndex({ primitiveSize, leafSize: 12, minExtent: 0.01, maxDepth: 18 });
    for (let start = 0; start < count * primitiveSize; start += 37 * primitiveSize) {
      index.append(positions, start, Math.min(count * primitiveSize, start + 37 * primitiveSize));
    }
    for (let query = 0; query < 40; query++) {
      const x = random() * 1800 - 900, y = random() * 1800 - 900;
      const view = { minX: x, minY: y, maxX: x + 100, maxY: y + 100 };
      const selected = new Set(collect(index, view).starts);
      for (let start = 0; start < count * primitiveSize; start += primitiveSize) {
        const coords = Array.from(positions.subarray(start * 2, (start + primitiveSize) * 2));
        const xs = coords.filter((_, offset) => offset % 2 === 0);
        const ys = coords.filter((_, offset) => offset % 2 === 1);
        const bounds = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
        if (classifier(view)(bounds) !== -1) assert.ok(selected.has(start), `missing primitive ${start} of size ${primitiveSize}`);
      }
    }
  }
});

test('long lines and triangles retain their full bounds and are never split or duplicated', () => {
  for (const primitiveSize of [2, 3]) {
    const crossing = primitiveSize === 2 ? [-100, 0, 100, 0] : [-100, -1, 100, -1, 0, 100];
    const isolated = primitiveSize === 2 ? [400, 400, 410, 410] : [400, 400, 410, 400, 405, 410];
    const positions = new Float32Array([...crossing, ...isolated]);
    const index = new PrimitiveSpatialIndex({ primitiveSize, leafSize: 1, minExtent: 0 });
    index.append(positions, 0, primitiveSize * 2);
    const result = collect(index, { minX: -1, minY: -1, maxX: 1, maxY: 1 });
    assert.deepEqual(result.starts, [0]);
    assert.ok(result.starts.every(start => start % primitiveSize === 0));
  }
});

test('appending expands only the existing tree and makes new geometry queryable', () => {
  const positions = new Float32Array([0, 0, 1, 1, 1000, 1000, -1000, -1000]);
  const index = new PrimitiveSpatialIndex({ leafSize: 1, minExtent: 0 });
  index.append(positions, 0, 2);
  const root = index._root;
  const left = root.left;
  index.append(positions, 2, 3);
  assert.equal(index._root, root, 'append does not replace the root');
  assert.equal(root.left, left, 'unaffected child retained');
  assert.deepEqual(collect(index, { minX: 999, minY: 999, maxX: 1001, maxY: 1001 }).starts, [2]);
  index.append(positions, 3, 4);
  assert.deepEqual(collect(index, { minX: -1001, minY: -1001, maxX: -999, maxY: -999 }).starts, [3]);
  assert.equal(index.getStats().primitives, 4);
});

test('fully contained subtrees skip further bounds classification; outside root skips visits', () => {
  const positions = new Float32Array(Array.from({ length: 200 }, (_, offset) => offset));
  const index = new PrimitiveSpatialIndex({ leafSize: 4, minExtent: 0 });
  index.append(positions, 0, 100);
  let classifications = 0, visits = 0;
  const all = index.query(() => { classifications++; return 1; }, () => visits++);
  assert.equal(classifications, 1);
  assert.equal(all.nodesTested, 1);
  assert.equal(visits, 100);
  assert.equal(all.leavesVisited, index.getStats().leaves);
  const none = index.query(() => -1, () => assert.fail('outside root cannot visit a primitive'));
  assert.deepEqual(none, { nodesTested: 1, leavesVisited: 0, primitivesSelected: 0 });
});

test('degenerate coincident centers stay in one leaf without repeated failed splitting', () => {
  const positions = new Float32Array(10000 * 2).fill(50);
  const index = new PrimitiveSpatialIndex({ leafSize: 1, minExtent: 0 });
  for (let start = 0; start < 10000; start += 100) index.append(positions, start, start + 100);
  assert.deepEqual(index.getStats(), { nodes: 1, leaves: 1, primitives: 10000, typedArrayBytes: 92160, estimatedBytes: 173152 });
  assert.equal(collect(index, { minX: 49, minY: 49, maxX: 51, maxY: 51 }).starts.length, 10000);
});

test('equal centers remain together on median ties and distant groups stay separable', () => {
  const positions = new Float32Array(2000 * 2);
  for (let start = 0; start < 2000; start++) positions.set(start % 2 ? [900, 900] : [100, 100], start * 2);
  const index = new PrimitiveSpatialIndex({ leafSize: 16, minExtent: 0 });
  index.append(positions, 0, 2000);
  assert.equal(index.getStats().nodes, 3);
  assert.equal(collect(index, { minX: 99, minY: 99, maxX: 101, maxY: 101 }).starts.length, 1000);
  assert.equal(collect(index, { minX: 400, minY: 400, maxX: 600, maxY: 600 }).starts.length, 0);
});

test('continuous center distributions retain a balanced median split', () => {
  const positions = new Float32Array(65 * 2);
  for (let start = 0; start < 65; start++) positions.set([start, 0], start * 2);
  const index = new PrimitiveSpatialIndex({ leafSize: 64, minExtent: 0 });
  index.append(positions, 0, 65);
  assert.equal(index._root.split, 32);
  assert.equal(index._root.left.count, 32);
  assert.equal(index._root.right.count, 33);
  assert.equal(index.getStats().nodes, 3);
});

test('minExtent and maxDepth independently bound subdivision', () => {
  const positions = new Float32Array([0, 0, 1, 1, 2, 2, 3, 3]);
  for (const options of [{ minExtent: 10 }, { minExtent: 0, maxDepth: 0 }]) {
    const index = new PrimitiveSpatialIndex({ leafSize: 1, ...options });
    index.append(positions, 0, 4);
    assert.equal(index.getStats().nodes, 1);
  }
  const depthOne = new PrimitiveSpatialIndex({ leafSize: 1, minExtent: 0, maxDepth: 1 });
  depthOne.append(positions, 0, 4);
  assert.equal(depthOne.getStats().nodes, 3);
});

test('validation is atomic, empty indexes are queryable, and overlapping ranges are rejected', () => {
  for (const options of [{ primitiveSize: 0 }, { primitiveSize: 4 }, { leafSize: 0 }, { leafSize: 1.5 }, { minExtent: -1 }, { minExtent: NaN }, { maxDepth: -1 }, { maxDepth: 1.5 }]) {
    assert.throws(() => new PrimitiveSpatialIndex(options), RangeError);
  }
  const index = new PrimitiveSpatialIndex({ primitiveSize: 2 });
  assert.deepEqual(index.getStats(), { nodes: 0, leaves: 0, primitives: 0, typedArrayBytes: 0, estimatedBytes: 0 });
  assert.deepEqual(index.query(() => 1, () => assert.fail()), { nodesTested: 0, leavesVisited: 0, primitivesSelected: 0 });
  assert.deepEqual(index.count(() => 1), { nodesTested: 0, leavesVisited: 0, primitivesSelected: 0 });
  assert.throws(() => index.append([0, 0], 0, 1), TypeError);
  assert.throws(() => index.append(new Float32Array(3), 0, 0), TypeError);
  assert.throws(() => index.append(new Float32Array(8), 1, 4), RangeError);
  assert.throws(() => index.append(new Float32Array(8), 0, 5), RangeError);
  assert.throws(() => index.append(new Float32Array([0, 0, 1, 1, NaN, 0, 3, 3]), 0, 4), RangeError);
  assert.equal(index.getStats().primitives, 0);
  const positions = new Float32Array([0, 0, 1, 1, 2, 2, 3, 3]);
  assert.equal(index.append(positions, 2, 4), 1, 'noncontiguous arrival is supported');
  assert.throws(() => index.append(positions, 0, 4), RangeError);
  assert.equal(index.getStats().primitives, 1, 'overlap rejection does not append the preceding new primitive');
  assert.equal(index.append(positions, 0, 2), 1);
  assert.equal(index.append(positions, 4, 4), 0);
  assert.throws(() => index.query(null, () => {}), TypeError);
  assert.throws(() => index.query(() => 2, () => {}), RangeError);
  assert.throws(() => index.count(null), TypeError);
  assert.throws(() => index.count(() => 2), RangeError);
});

test('count fully contained root reads only node count and does not access primitives or children', () => {
  const positions = new Float32Array(Array.from({ length: 200 }, (_, offset) => offset));
  const index = new PrimitiveSpatialIndex({ leafSize: 4, minExtent: 0 });
  index.append(positions, 0, 100);
  for (const property of ['entries', 'left', 'right']) {
    Object.defineProperty(index._root, property, { get() { assert.fail(`contained count cannot read ${property}`); } });
  }
  let classifications = 0;
  const result = index.count(() => { classifications++; return 1; });
  assert.equal(classifications, 1);
  assert.deepEqual(result, { nodesTested: 1, leavesVisited: 0, primitivesSelected: 100 });
  assert.deepEqual(index.count(() => -1), { nodesTested: 1, leavesVisited: 0, primitivesSelected: 0 });
});

test('copied compact bounds are unaffected by subsequent changes to input positions', () => {
  for (const primitiveSize of [1, 2, 3]) {
    const first = primitiveSize === 1 ? [10, 10] : primitiveSize === 2 ? [9, 9, 11, 11] : [9, 9, 11, 9, 10, 11];
    const second = Array.from({ length: primitiveSize }, (_, offset) => [100 + offset, 100 + offset]).flat();
    const positions = new Float32Array([...first, ...second]);
    const index = new PrimitiveSpatialIndex({ primitiveSize, leafSize: 1, minExtent: 0 });
    index.append(positions, 0, primitiveSize * 2);
    positions.fill(-1000);
    assert.deepEqual(collect(index, { minX: 8, minY: 8, maxX: 12, maxY: 12 }).starts, [0]);
    assert.equal(collect(index, { minX: -1001, minY: -1001, maxX: -999, maxY: -999 }).starts.length, 0);
  }
});

test('typedArrayBytes measures compact block buffers and sparse addresses do not allocate gaps', () => {
  for (const primitiveSize of [1, 2, 3]) {
    const start = 200000 * primitiveSize;
    const positions = new Float32Array((start + primitiveSize) * 2);
    positions.fill(7, start * 2);
    const index = new PrimitiveSpatialIndex({ primitiveSize });
    index.append(positions, start, start + primitiveSize);
    const expectedBytes = primitiveSize === 1 ? 9216 : 17408;
    assert.equal(index.getStats().typedArrayBytes, expectedBytes, 'one occupied address block only');
    assert.equal(index._blocks.size, 1);
    assert.deepEqual(collect(index, { minX: 6, minY: 6, maxX: 8, maxY: 8 }).starts, [start]);
    assert.throws(() => index.append(positions, start, start + primitiveSize), RangeError);
    assert.equal(index.getStats().typedArrayBytes, expectedBytes);
  }
});
