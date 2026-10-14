// Deterministic research material; independent of renderer/index policy.
const SIZE = { points: 1, lines: 2, polygons: 3 };
const COLOR = [30, 145, 225, 173];
const rng = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const f32 = Math.fround;
function center(distribution, random, i, n) {
  if (distribution === 'uniform') return [(random() - .5) * 4096, (random() - .5) * 4096];
  if (distribution === 'clusters') {
    const c = [[-800, -800], [800, -800], [-800, 800], [800, 800]][i % 4];
    return [c[0] + (random() + random() + random() - 1.5) * 40, c[1] + (random() + random() + random() - 1.5) * 40];
  }
  if (distribution === 'corridor') { const x = (i / Math.max(1, n - 1) - .5) * 4096; return [x, 200 * Math.sin(x / 256) + (random() - .5) * 12]; }
  if (distribution === 'separated') { const sign = i & 1 ? 1 : -1; return [sign * 1800 + (random() - .5) * 32, sign * 1800 + (random() - .5) * 32]; }
  throw new RangeError('Unknown distribution');
}
function group(kind, records, order, random) {
  const list = [...records];
  if (order === 'spatial') list.sort((a, b) => Math.floor(a.xy[0] / 128) - Math.floor(b.xy[0] / 128) || Math.floor(a.xy[1] / 128) - Math.floor(b.xy[1] / 128) || a.ids[0] - b.ids[0]);
  else if (order === 'interleaved') for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  else throw new RangeError('Unknown order');
  const count = list.length * SIZE[kind], positions = new Float32Array(count * 2), colors = new Uint8Array(count * 4), ids = new Uint32Array(count);
  let slot = 0;
  for (const record of list) for (let vertex = 0; vertex < SIZE[kind]; vertex++, slot++) {
    positions.set(record.xy.slice(vertex * 2, vertex * 2 + 2), slot * 2); colors.set(COLOR, slot * 4); ids[slot] = record.ids[vertex];
  }
  return { kind, positions, colors, ids, featureCount: list.length };
}
export function createDynamicUpdateMaterial({ distribution, order, seed, pointCount = 32768 } = {}) {
  if (!Number.isInteger(seed) || !Number.isInteger(pointCount) || pointCount < 1024 || pointCount > 60000) throw new RangeError('Bad material parameters');
  const random = rng(seed), records = [], original = new Map();
  for (let i = 0; i < pointCount; i++) {
    const xy = i < 4 ? [[-80000, 0], [80000, 0], [0, -80000], [0, 80000]][i] : center(distribution, random, i, pointCount);
    original.set(i + 1, xy.map(f32)); records.push({ xy, ids: [i + 1] });
  }
  const lines = [], triangles = [];
  for (let i = 0; i < 64; i++) {
    const xy = i < 16 ? [-1200, -180 + i * 24, 1200, -180 + i * 24] : [...center(distribution, random, i, 64), ...center(distribution, random, i + 1, 64)];
    lines.push({ xy, ids: [i < 16 ? i + 17 : 1000000 + i * 2, 1000000 + i * 2 + 1] });
  }
  for (let i = 0; i < 32; i++) {
    const c = center(distribution, random, i, 32), xy = i < 8 ? [-1000, -600, 1000, -600, 0, 1200] : [c[0] - 8, c[1] - 8, c[0] + 8, c[1] - 8, c[0], c[1] + 8];
    triangles.push({ xy, ids: [i < 8 ? i + 17 : 2000000 + i * 3, 2000000 + i * 3 + 1, 2000000 + i * 3 + 2] });
  }
  const initial = { groups: [group('points', records, order, random), group('lines', lines, order, random), group('polygons', triangles, order, random)] };
  const tracked = new Set(Array.from({ length: 1024 }, (_, i) => i + 1));
  for (const g of initial.groups) if (g.kind !== 'points') for (const id of g.ids) tracked.add(id);
  for (let i = 0; i < 224; i++) tracked.add(3000000 + i);
  const moves = (ids, position) => ({ type: 'move', updates: ids.map((id, i) => ({ id, x: f32(position(id, i)[0]), y: f32(position(id, i)[1]) })) });
  const ids = (start, n) => Array.from({ length: n }, (_, i) => start + i);
  const primary = [
    moves(ids(10, 32), id => [original.get(id)[0] + .5, original.get(id)[1] - .25]),
    moves([1, 2], (_, i) => [i ? 180 : -180, 0]),
    { type: 'remove', ids: [3, 4] },
    { type: 'restore', ids: [3, 4] },
    moves(ids(50, 64), (_, i) => [60000 + i, 30000 + i]),
    moves(ids(50, 32), (_, i) => [-120 + i * 6, 80 + i % 4]),
    moves(ids(200, 512), (_, i) => [60000 * Math.cos(i), 40000 * Math.sin(i)]),
    moves(ids(200, 512), (_, i) => [-32 + i % 32 * 2, -32 + Math.floor(i / 32) * 2]),
    moves(ids(200, 512), (_, i) => [70000 + i % 32, 70000 + Math.floor(i / 32)]),
    moves(ids(17, 16), (_, i) => [-1000, -180 + i * 24]),
    { type: 'remove', ids: ids(50, 16) },
    { type: 'restore', ids: ids(50, 16) },
    moves([3, 4], (_, i) => [0, i ? 12 : -12]),
    moves([1000001, 2000001], (_, i) => [i ? 1000 : 1200, i ? -600 : -180]),
    moves([...ids(50, 64), ...ids(200, 512)], id => original.get(id)), { type: 'idle' }
  ];
  const cameras = Array.from({ length: 16 }, (_, i) => i === 13 ? { x: 60000, y: 30000, scale: 1, heading: 0 }
    : i === 14 ? { x: 0, y: 0, scale: 1, heading: Math.PI / 6 }
    : i === 15 ? { x: 50000, y: 0, scale: 1, heading: Math.PI / 6 }
    : { x: 0, y: 0, scale: 1, heading: i % 4 === 3 ? Math.PI / 8 : 0 });
  const stages = primary.map((operation, stage) => {
    const actions = [operation];
    if (stage < 14) {
      const count = 16, positions = new Float32Array(count * 2), colors = new Uint8Array(count * 4), appendedIDs = new Uint32Array(count);
      for (let i = 0; i < count; i++) { positions.set([-160 + i * 16, 100 + stage * 2], i * 2); colors.set(COLOR, i * 4); appendedIDs[i] = 3000000 + stage * 16 + i; }
      actions.push({ type: 'append', batch: { groups: [{ kind: 'points', positions, colors, ids: appendedIDs, featureCount: count }] } });
    }
    return { name: ['internal-micro', 'boundary-inward', 'boundary-remove', 'boundary-restore', 'far-migration', 'return-visible', 'batch-scattered', 'batch-compact', 'batch-far', 'shared-ID-full-primitive', 'remove-moved', 'restore-moved', 'shrink-restored-extreme', 'independent-vertex', 'rotate-settle', 'offscreen-settle'][stage], actions, camera: cameras[stage] };
  });
  return { initial, tracked: [...tracked], stages, meta: { distribution, order, seed, pointCount, linePrimitives: 64, trianglePrimitives: 32, stages: 16, appendedPoints: 224, APITrackedIDs: tracked.size } };
}
export function createIndependentOracle(initial) {
  const state = { groups: [], bindings: new Map(), removed: new Set(), saved: new Map() };
  for (const group of initial.groups) oracleAppend(state, { groups: [group] });
  return state;
}
function oracleAppend(state, batch) {
  for (const source of batch.groups) {
    const group = { kind: source.kind, positions: source.positions.slice(), colors: source.colors.slice(), ids: source.ids.slice() }; state.groups.push(group);
    for (let slot = 0; slot < group.ids.length; slot++) {
      const id = group.ids[slot], binding = { group, slot }; let list = state.bindings.get(id); if (!list) state.bindings.set(id, list = []); list.push(binding);
      if (state.removed.has(id)) { state.saved.set(binding, group.colors.slice(slot * 4, slot * 4 + 4)); group.colors[slot * 4 + 3] = 0; }
    }
  }
}
export function applyIndependentOperation(state, operation) {
  if (operation.type === 'append') { oracleAppend(state, operation.batch); return; }
  if (operation.type === 'idle') return;
  if (operation.type === 'move') {
    const latest = new Map(operation.updates.map(update => [update.id, update]));
    for (const [id, update] of latest) if (!state.removed.has(id)) for (const { group, slot } of state.bindings.get(id) ?? []) group.positions.set([f32(update.x), f32(update.y)], slot * 2);
    return;
  }
  if (operation.type === 'remove') {
    for (const id of new Set(operation.ids)) if (!state.removed.has(id) && state.bindings.has(id)) {
      state.removed.add(id); for (const binding of state.bindings.get(id)) { const { group, slot } = binding; state.saved.set(binding, group.colors.slice(slot * 4, slot * 4 + 4)); group.colors[slot * 4 + 3] = 0; }
    }
    return;
  }
  if (operation.type === 'restore') {
    for (const id of new Set(operation.ids)) if (state.removed.has(id)) {
      state.removed.delete(id); for (const binding of state.bindings.get(id) ?? []) { const saved = state.saved.get(binding); if (!saved) throw new Error('Oracle missing restore snapshot'); binding.group.colors.set(saved, binding.slot * 4); state.saved.delete(binding); }
    }
    return;
  }
  throw new RangeError('Unknown operation');
}
export function flattenIndependentOracle(state, kind) {
  const groups = state.groups.filter(group => group.kind === kind), count = groups.reduce((sum, group) => sum + group.ids.length, 0);
  const positions = new Float32Array(count * 2), colors = new Uint8Array(count * 4), ids = new Uint32Array(count); let at = 0;
  for (const group of groups) { positions.set(group.positions, at * 2); colors.set(group.colors, at * 4); ids.set(group.ids, at); at += group.ids.length; }
  return { kind, positions, colors, ids, count };
}
export function independentLiveBounds(state, kind) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, livePrimitives = 0;
  for (const group of state.groups) if (group.kind === kind) for (let start = 0; start < group.ids.length; start += SIZE[kind]) {
    let live = false; for (let v = 0; v < SIZE[kind]; v++) if (!state.removed.has(group.ids[start + v])) live = true;
    if (!live) continue; livePrimitives++;
    // Logical deletion, not alpha, determines live geometry. A removed endpoint
    // still bounds a primitive when another endpoint is logically live.
    for (let v = 0; v < SIZE[kind]; v++) { const x = group.positions[(start + v) * 2], y = group.positions[(start + v) * 2 + 1]; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  }
  return { minX, minY, maxX, maxY, livePrimitives };
}
