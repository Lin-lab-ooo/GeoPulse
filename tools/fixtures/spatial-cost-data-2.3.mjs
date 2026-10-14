/** Deterministic CPU-only cost workloads. This is research, not a renderer policy. */
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

export const ACTIONS = [32, 64, 128, 256];
export const TREE_OPTIONS = Object.freeze({ leafSize: 64, minExtent: 8, maxDepth: 16, maxSplitEntries: 256 });
export const PAGE_VERTICES = 65535;
export const FEATURE_NAMES = [
  'primitiveSize', 'indexedPrimitives', 'remainingPrimitives', 'pagePrimitives',
  'nodes', 'leaves', 'emaMsPerPrimitive', 'lastSliceMs',
  'centroidAnisotropy', 'occupiedCellRatio', 'bboxSpan', 'meanAdjacentDistance'
];
export const FEATURE_DEFINITIONS = [
  'Complete primitive vertices: 1 point, 2 segment, 3 triangle.',
  'Primitives already appended in this page; no future geometry inspected.',
  'Known buffered page primitives remaining before this slice.',
  'Known buffered page primitive count. This is not unknown live-stream total.',
  'Current index node count from getStats before append.',
  'Current index leaf count from getStats before append.',
  'EMA (alpha .2) of previous append CPU ms per primitive; zero means no prior slice.',
  'Previous append CPU ms; zero before the first slice.',
  'sqrt(min(varX,varY)/max(varX,varY)) of appended full-bbox centers; zero if degenerate.',
  'Occupied fixed 187.5-unit cells / appended primitives, clipped to one; appended data only.',
  'max(width,height) of appended full primitive bounds in coordinate units.',
  'Mean Euclidean distance of successive appended full-bbox centers in input order.'
];
export const VIEWS = Object.freeze([
  { name: 'full', bounds: [-7000, -7000, 7000, 7000] },
  { name: 'localCluster', bounds: [-4700, -3400, -3500, -2200] },
  { name: 'emptyCorner', bounds: [5300, 5300, 5900, 5900] },
  { name: 'narrowStrip', bounds: [-6500, -160, 6500, 160] },
  { name: 'center', bounds: [-300, -300, 300, 300] }
]);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function random(seed) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6D2B79F5) >>> 0; let n = Math.imul(state ^ state >>> 15, 1 | state); n ^= n + Math.imul(n ^ n >>> 7, 61 | n); return ((n ^ n >>> 14) >>> 0) / 4294967296; };
}
export function primitiveBounds(positions, start, primitiveSize) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let v = start; v < start + primitiveSize; v++) {
    const x = positions[v * 2], y = positions[v * 2 + 1];
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}
export const boundsOverlap = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
export function classifyBounds(bounds, view) {
  if (bounds.maxX < view[0] || bounds.minX > view[2] || bounds.maxY < view[1] || bounds.minY > view[3]) return -1;
  return bounds.minX >= view[0] && bounds.maxX <= view[2] && bounds.minY >= view[1] && bounds.maxY <= view[3] ? 1 : 0;
}
function morton(x, y) {
  const ix = Math.max(0, Math.min(65535, Math.floor((x + 7000) / 14000 * 65535)));
  const iy = Math.max(0, Math.min(65535, Math.floor((y + 7000) / 14000 * 65535)));
  let key = 0;
  for (let b = 0; b < 16; b++) key += ((ix >>> b) & 1) * 2 ** (b * 2) + ((iy >>> b) & 1) * 2 ** (b * 2 + 1);
  return key;
}
export function makeWorkload(input) {
  const config = { distribution: 'uniform', seed: 7, primitiveSize: 1, count: 4096, order: 'shuffled', ...input };
  const { distribution, seed, primitiveSize, count, order } = config;
  if (!['uniform', 'clusters', 'corridor', 'crossing-lines'].includes(distribution)) throw new RangeError('unknown distribution');
  if (![1, 2, 3].includes(primitiveSize)) throw new RangeError('primitiveSize');
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000000) throw new RangeError('count');
  if (!['shuffled', 'spatial', 'alternating'].includes(order)) throw new RangeError('order');
  // Different workload sizes/types use independent deterministic geometry seeds.
  // Order changes reuse the same geometry, which is intentional for arrival comparisons.
  const rngGeometrySeed = Number.parseInt(sha256(Buffer.from(JSON.stringify({ distribution, seed, primitiveSize, count }))).slice(0,8),16);
  const rng = random(rngGeometrySeed), centers = [[-4100,-2800],[-1500,-3000],[2000,-2800],[4200,-500],[2000,1000],[-1000,1000],[-3800,2800],[700,3800]];
  const normal = () => Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-9))) * Math.cos(2 * Math.PI * rng());
  const original = new Float32Array(count * primitiveSize * 2), keys = new Float64Array(count), cx = new Float64Array(count), cy = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    let x, y, coords;
    if (distribution === 'uniform') { x = (rng() - .5) * 12000; y = (rng() - .5) * 12000; }
    if (distribution === 'clusters') { const c = centers[Math.floor(rng() * centers.length)]; x = c[0] + normal() * 180; y = c[1] + normal() * 140; }
    if (distribution === 'corridor') { x = (rng() - .5) * 12000; y = normal() * 38; }
    if (distribution === 'crossing-lines') {
      if (primitiveSize === 1) { const vertical = rng() < .5; x = vertical ? normal() * 40 : (rng() - .5) * 12000; y = vertical ? (rng() - .5) * 12000 : normal() * 40; }
      else { const y0 = (rng() - .5) * 12000; coords = [-6000, y0 - (rng() - .5) * 1200, 900 + rng() * 5000, y0 + (rng() - .5) * 1200]; if (primitiveSize === 3) coords.push(coords[2] - rng() * 60, coords[3] + 10 + rng() * 40); }
    }
    if (!coords) {
      coords = [x, y];
      if (primitiveSize === 2) coords.push(x + 30 + rng() * 220, y + (rng() - .5) * 80);
      if (primitiveSize === 3) { const s = 12 + rng() * 70; coords.push(x + s, y, x, y + s); }
    }
    original.set(coords, i * primitiveSize * 2);
    const b = primitiveBounds(original, i * primitiveSize, primitiveSize);
    cx[i] = (b[0] + b[2]) / 2; cy[i] = (b[1] + b[3]) / 2; keys[i] = morton(cx[i], cy[i]);
  }
  let ids = Array.from({ length: count }, (_, i) => i);
  if (order === 'spatial') ids.sort((a,b) => keys[a] - keys[b] || a - b);
  if (order === 'shuffled') {
    const permute = random(seed ^ 0x75E259AD);
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(permute() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  }
  if (order === 'alternating') {
    ids.sort((a,b) => cx[a] - cx[b] || cy[a] - cy[b] || a - b);
    const sorted = ids; ids = [];
    for (let lo = 0, hi = count - 1; lo <= hi; lo++, hi--) { ids.push(sorted[lo]); if (lo !== hi) ids.push(sorted[hi]); }
  }
  const pages = [], capacity = Math.floor(PAGE_VERTICES / primitiveSize);
  for (let start = 0; start < count; start += capacity) {
    const primitiveCount = Math.min(capacity, count - start), positions = new Float32Array(primitiveCount * primitiveSize * 2);
    for (let i = 0; i < primitiveCount; i++) {
      const src = ids[start + i] * primitiveSize * 2;
      positions.set(original.subarray(src, src + primitiveSize * 2), i * primitiveSize * 2);
    }
    pages.push({ pageId: pages.length, primitiveStart: start, primitiveCount, positions });
  }
  const geometryHash = createHash('sha256'); for (const page of pages) geometryHash.update(page.positions);
  const id = `${distribution}-p${primitiveSize}-n${count}-s${seed}-${order}`;
  return { id, config, rngGeometrySeed, count, primitiveSize, pages, geometryHash: geometryHash.digest('hex') };
}
export function workloadManifest({ quick = false } = {}) {
  const workloads = [], counts = quick ? [4096,16384] : [4096,16384,60000], seeds = quick ? [7] : [7,19];
  const distributions = ['uniform','clusters','corridor','crossing-lines'];
  for (const [d, distribution] of distributions.entries()) for (const primitiveSize of [1,2,3]) for (const [c, count] of counts.entries()) for (const [s, seed] of seeds.entries()) {
    const order = ['shuffled','spatial','alternating'][(d + primitiveSize + c + s) % 3];
    const split = distribution === 'crossing-lines' ? 'test-held-out-distribution' : count === 60000 ? 'test-large' : seed === 7 ? 'train' : 'validation';
    const config = { distribution, primitiveSize, count, seed, order };
    workloads.push({ id: `${distribution}-p${primitiveSize}-n${count}-s${seed}-${order}`, split, config });
  }
  return workloads;
}
export function newCostState(page, primitiveSize) {
  return { primitiveSize, pagePrimitives: page.primitiveCount, indexedPrimitives: 0, meanX: 0, meanY: 0, m2X: 0, m2Y: 0,
    occupied: new Set(), bounds: [Infinity,Infinity,-Infinity,-Infinity], previousCenter: null, pathDistance: 0,
    emaMsPerPrimitive: 0, lastSliceMs: 0, version: 0 };
}
export function makeCostContext(index, page, state) {
  const stats = index.getStats(), maxVariance = Math.max(state.m2X, state.m2Y);
  return { primitiveSize: state.primitiveSize, indexedPrimitives: state.indexedPrimitives,
    remainingPrimitives: page.primitiveCount - state.indexedPrimitives, pagePrimitives: page.primitiveCount,
    nodes: stats.nodes, leaves: stats.leaves, emaMsPerPrimitive: state.emaMsPerPrimitive, lastSliceMs: state.lastSliceMs,
    centroidAnisotropy: maxVariance > 0 ? Math.sqrt(Math.min(state.m2X,state.m2Y) / maxVariance) : 0,
    occupiedCellRatio: state.indexedPrimitives ? Math.min(1,state.occupied.size / state.indexedPrimitives) : 0,
    bboxSpan: state.indexedPrimitives ? Math.max(state.bounds[2] - state.bounds[0],state.bounds[3] - state.bounds[1]) : 0,
    meanAdjacentDistance: state.indexedPrimitives > 1 ? state.pathDistance / (state.indexedPrimitives - 1) : 0,
    version: state.version };
}
export function makeCostFeatures(context) {
  const values = FEATURE_NAMES.map(name => context[name]);
  if (!values.every(Number.isFinite)) throw new TypeError('cost features must all be finite');
  return values;
}
export function advanceCostState(state, positions, start, end, cpuMs) {
  if (start !== state.indexedPrimitives * state.primitiveSize || end % state.primitiveSize || end <= start || !Number.isFinite(cpuMs) || cpuMs < 0) throw new RangeError('invalid causal append state');
  const primitiveCount = (end - start) / state.primitiveSize;
  for (let v = start; v < end; v += state.primitiveSize) {
    const b = primitiveBounds(positions,v,state.primitiveSize), x = (b[0]+b[2])/2, y = (b[1]+b[3])/2;
    const n = ++state.indexedPrimitives, dx = x - state.meanX, dy = y - state.meanY;
    state.meanX += dx / n; state.meanY += dy / n; state.m2X += dx * (x-state.meanX); state.m2Y += dy * (y-state.meanY);
    state.occupied.add(`${Math.floor((x+6000)/187.5)},${Math.floor((y+6000)/187.5)}`);
    state.bounds[0] = Math.min(state.bounds[0],b[0]); state.bounds[1] = Math.min(state.bounds[1],b[1]);
    state.bounds[2] = Math.max(state.bounds[2],b[2]); state.bounds[3] = Math.max(state.bounds[3],b[3]);
    if (state.previousCenter) state.pathDistance += Math.hypot(x-state.previousCenter[0],y-state.previousCenter[1]);
    state.previousCenter = [x,y];
  }
  const rate = cpuMs / primitiveCount;
  state.emaMsPerPrimitive = state.version ? .2 * rate + .8 * state.emaMsPerPrimitive : rate;
  state.lastSliceMs = cpuMs; state.version++;
}
export function verifyQueries(workload, indexes) {
  assert.equal(indexes.length, workload.pages.length);
  return VIEWS.map(view => {
    const candidates = [], exact = [], aggregate = { nodesTested: 0, leavesVisited: 0, primitivesSelected: 0 };
    for (let p = 0; p < workload.pages.length; p++) {
      const page = workload.pages[p], index = indexes[p];
      const stats = index.query(bounds => classifyBounds(bounds,view.bounds), start => {
        assert.equal(start % workload.primitiveSize,0);
        assert.ok(start >= 0 && start < page.primitiveCount * workload.primitiveSize);
        candidates.push(page.primitiveStart + start / workload.primitiveSize);
      });
      for (const key of Object.keys(aggregate)) aggregate[key] += stats[key];
      const count = index.count(bounds => classifyBounds(bounds,view.bounds)); assert.equal(count.primitivesSelected,stats.primitivesSelected);
      for (let i=0;i<page.primitiveCount;i++) if (boundsOverlap(primitiveBounds(page.positions,i*workload.primitiveSize,workload.primitiveSize),view.bounds)) exact.push(page.primitiveStart+i);
    }
    candidates.sort((a,b)=>a-b); exact.sort((a,b)=>a-b);
    assert.equal(new Set(candidates).size,candidates.length,'each complete primitive selected at most once');
    const selected = new Set(candidates); for (const id of exact) assert.ok(selected.has(id),`${view.name} omitted primitive ${id}`);
    if (view.name==='full') assert.equal(candidates.length,workload.count);
    return { view: view.name, candidateCount: candidates.length, exactBoundsCount: exact.length,
      candidatesSha256: sha256(new Uint32Array(candidates)), exactBoundsSha256: sha256(new Uint32Array(exact)), ...aggregate,
      conservativeNoMissing: true };
  });
}