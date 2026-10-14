/**
 * Independent chain-test material and scalar geometry oracle.
 * No production generator, detector, packer, renderer or update helper is used.
 * value=40 in every region makes the expected normal RGBA [38,205,174,190].
 * IDs may repeat: featureCount counts input records; slots are never deduplicated.
 * The oracle treats every existing ID as subscribed. A harness using renderer
 * edits must subscribe the tested IDs itself; edits before any binding are ignored.
 */
export const CHAIN_NORMAL_RGBA = Object.freeze([38, 205, 174, 190]);
const KINDS = Object.freeze(['points', 'lines', 'polygons']);
const keyFor = kind => ({point:'points', line:'lines', polygon:'polygons'})[kind];
const fail = message => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };
const validId = id => Number.isInteger(id) && id >= 0 && id <= 0xffffffff;
const coordinate = value => {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) throw new RangeError('Oracle coordinates must be finite Float32 values');
  return Math.fround(value);
};
const checkedColor = value => {
  if ((!Array.isArray(value) && !(value instanceof Uint8Array)) || value.length !== 4 ||
      !Array.from(value).every(v => Number.isInteger(v) && v >= 0 && v <= 255)) throw new TypeError('Oracle color must contain four RGBA bytes');
  return Array.from(value);
};

/** 88 point / 10 polyline / 2 rectangle records in each consecutive 100 rows. */
export function makeChainRecords(count = 8200, seed = 20261014) {
  if (!Number.isSafeInteger(count) || count < 0 || count > 1000000) throw new RangeError('Fixture count must be 0..1000000');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('Fixture seed must be uint32');
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const rows = [];
  for (let i = 0; i < count; i++) {
    const slot = i % 100, kind = slot < 88 ? 'point' : slot < 98 ? 'line' : 'polygon';
    // Quantized fractions survive JSON round trips exactly while requiring
    // Float32 conversion at the oracle/renderer boundary.
    const x = Math.round((random() * 2400 - 1200) * 32) / 32 + 0.1;
    const y = Math.round((random() * 1800 - 900) * 32) / 32 + 0.2;
    let id = i + 1;
    if (i >= Math.ceil(count / 2)) {
      if (slot === 0) id = 1;
      if (slot === 88) id = 89;
      if (slot === 98) id = 99;
    }
    const row = {id, kind, x, y, value:40, region:`通信园区·${i % 7}🌐`, status:'online', groundTruth:'normal'};
    if (kind === 'line') {
      const segments = slot === 88 ? 3 : 1;
      row.coords = Array.from({length:segments + 1}, (_, p) => [x + p * 13.375, y + p * (p % 2 ? 7.125 : -4.625)]);
    } else if (kind === 'polygon') {
      const left = x - 12.25, right = x + 12.25, bottom = y - 8.5, top = y + 8.5;
      row.coords = [[left,bottom],[right,bottom],[right,top],[left,top]];
      if (slot === 98) row.coords.push([left,bottom]);
    }
    rows.push(row);
  }
  return rows;
}

/** Scalar append-only state with per-slot tombstone snapshots. */
export class ChainOracle {
  constructor(records = []) {
    this.featureCount = 0;
    this.buckets = Object.fromEntries(KINDS.map(kind => [kind, {kind, featureCount:0, slots:[]}]));
    this.bindings = new Map();
    this.removed = new Set();
    this.moved = new Map();
    this.removedMoves = new Map();
    this.append(records);
  }

  append(records) {
    const incoming = Array.isArray(records) ? records : [records];
    const prepared = incoming.map(record => {
      const kind = keyFor(record?.kind);
      if (!kind || !validId(record.id) || record.id === 0) throw new TypeError('Invalid oracle fixture record');
      if (record.value !== 40) throw new RangeError('This oracle intentionally covers constant-40 normal data only');
      let vertices;
      if (kind === 'points') vertices = [[record.x, record.y]];
      else {
        const c = record.coords;
        if (!Array.isArray(c) || c.some(v => !Array.isArray(v) || v.length !== 2)) throw new TypeError('Invalid oracle coordinates');
        if (kind === 'lines') {
          if (c.length < 2) throw new RangeError('A polyline needs two or more coordinates');
          vertices = [];
          for (let segment = 0; segment < c.length - 1; segment++) vertices.push(c[segment], c[segment + 1]);
        } else {
          if ((c.length !== 4 && c.length !== 5) || c[0][1] !== c[1][1] || c[1][0] !== c[2][0] ||
              c[2][1] !== c[3][1] || c[3][0] !== c[0][0] ||
              (c.length === 5 && (c[4][0] !== c[0][0] || c[4][1] !== c[0][1]))) throw new RangeError('Only rectangular oracle polygons are supported');
          // Two triangles split the rectangle along the 0->2 diagonal.
          vertices = [c[0], c[1], c[2], c[0], c[2], c[3]];
        }
      }
      return {kind, id:record.id, vertices:vertices.map(([x,y]) => [coordinate(x), coordinate(y)])};
    });
    for (const record of prepared) {
      const bucket = this.buckets[record.kind];
      let bindings = this.bindings.get(record.id);
      if (!bindings) this.bindings.set(record.id, bindings = []);
      for (const [x,y] of record.vertices) {
        const rgba = [...CHAIN_NORMAL_RGBA];
        const slot = {id:record.id, x, y, rgba, moved:false, saved:null};
        if (this.removed.has(record.id)) {
          slot.saved = {rgba:[...rgba], moved:false};
          slot.rgba[3] = 0;
        }
        bucket.slots.push(slot);
        bindings.push(slot);
      }
      bucket.featureCount++;
      this.featureCount++;
    }
    return {appended:prepared.length, featureCount:this.featureCount};
  }

  applyMove(updates) {
    const values = new Map();
    for (const update of Array.isArray(updates) ? updates : [updates]) {
      if (!validId(update?.id)) throw new TypeError('Oracle move ID must be uint32');
      values.set(update.id, {x:coordinate(update.x), y:coordinate(update.y)});
    }
    const result = {updated:0, ignored:0, unchanged:0};
    for (const [id, position] of values) {
      const slots = this.bindings.get(id);
      if (!slots || this.removed.has(id)) { result.ignored++; continue; }
      let changed = false;
      for (const slot of slots) {
        if (slot.x === position.x && slot.y === position.y) continue;
        slot.x = position.x; slot.y = position.y; slot.moved = true; changed = true;
      }
      if (changed) { this.moved.set(id, position); result.updated++; }
      else result.unchanged++;
    }
    return result;
  }

  applyColor(updates) {
    const values = new Map();
    for (const update of Array.isArray(updates) ? updates : [updates]) {
      if (!validId(update?.id)) throw new TypeError('Oracle color ID must be uint32');
      values.set(update.id, checkedColor(update.color));
    }
    const result = {updated:0, updatedVertices:0, ignored:0, unchanged:0};
    for (const [id, color] of values) {
      const slots = this.bindings.get(id);
      if (!slots || this.removed.has(id)) { result.ignored++; continue; }
      let changed = false;
      for (const slot of slots) {
        if (slot.rgba.every((value, channel) => value === color[channel])) continue;
        slot.rgba = [...color]; result.updatedVertices++; changed = true;
      }
      if (changed) result.updated++;
      else result.unchanged++;
    }
    return result;
  }

  applyRemove(ids) {
    if ((!Array.isArray(ids) && !(ids instanceof Uint32Array)) || !Array.from(ids).every(validId)) throw new TypeError('Oracle remove needs uint32 IDs');
    const result = {removed:0, ignored:0};
    for (const id of new Set(ids)) {
      const slots = this.bindings.get(id);
      if (!slots || this.removed.has(id)) { result.ignored++; continue; }
      const position = this.moved.get(id);
      if (position) this.removedMoves.set(id, {...position});
      this.moved.delete(id); this.removed.add(id);
      for (const slot of slots) {
        slot.saved = {rgba:[...slot.rgba], moved:slot.moved};
        slot.rgba[3] = 0; slot.moved = false;
      }
      result.removed++;
    }
    return result;
  }

  applyRestore(ids) {
    if ((!Array.isArray(ids) && !(ids instanceof Uint32Array)) || !Array.from(ids).every(validId)) throw new TypeError('Oracle restore needs uint32 IDs');
    let restored = 0;
    for (const id of new Set(ids)) {
      if (!this.removed.has(id)) continue;
      this.removed.delete(id);
      const position = this.removedMoves.get(id);
      if (position) this.moved.set(id, {...position});
      this.removedMoves.delete(id);
      for (const slot of this.bindings.get(id)) {
        check(slot.saved !== null, 'Missing oracle tombstone snapshot');
        slot.rgba = [...slot.saved.rgba]; slot.moved = slot.saved.moved; slot.saved = null;
      }
      restored++;
    }
    return {restored};
  }

  snapshot() {
    const groups = KINDS.map(kind => {
      const bucket = this.buckets[kind], positions = new Float32Array(bucket.slots.length * 2);
      const colors = new Uint8Array(bucket.slots.length * 4), ids = new Uint32Array(bucket.slots.length);
      bucket.slots.forEach((slot, index) => { positions.set([slot.x,slot.y], index * 2); colors.set(slot.rgba, index * 4); ids[index] = slot.id; });
      return {kind, positions, colors, ids, featureCount:bucket.featureCount};
    });
    return {featureCount:this.featureCount, totalVertices:groups.reduce((sum,g) => sum + g.ids.length, 0), groups,
      removedIds:[...this.removed], movedIds:[...this.moved.keys()]};
  }
}

/** Lightweight, dependency-free fixture checks; no browser or production imports. */
export function runChainOracleSelfCheck() {
  let checks = 0;
  const assert = (value, label) => { check(value, label); checks++; };
  const rows = makeChainRecords(), other = makeChainRecords();
  assert(JSON.stringify(rows) === JSON.stringify(other), 'Fixture must be deterministic');
  assert(JSON.stringify(rows) !== JSON.stringify(makeChainRecords(8200, 9)), 'Seed must affect material');
  assert(rows.length === 8200 && rows.filter(r => r.kind === 'point').length === 7216 &&
    rows.filter(r => r.kind === 'line').length === 820 && rows.filter(r => r.kind === 'polygon').length === 164, '88/10/2 record composition');
  assert(rows.every(r => r.value === 40 && r.region.includes('🌐')), 'Unicode constant-value material');
  assert(rows.filter(r => r.id === 1).every(r => r.kind === 'point') && rows.filter(r => r.id === 89).every(r => r.kind === 'line') &&
    rows.filter(r => r.id === 99).every(r => r.kind === 'polygon') && rows.filter(r => r.id === 1).length > 1, 'Late repeated IDs must preserve geometry type');
  const whole = new ChainOracle(rows).snapshot(), streamed = new ChainOracle();
  for (let i = 0; i < rows.length; i += 2048) streamed.append(rows.slice(i, i + 2048));
  const streamedState = streamed.snapshot();
  assert(whole.featureCount === 8200 && whole.totalVertices === 10168, 'Record and mixed-polyline vertex counts');
  for (let group = 0; group < 3; group++) for (const channel of ['positions','colors','ids']) {
    const a = whole.groups[group][channel], b = streamedState.groups[group][channel];
    assert(a.length === b.length && a.every((v,i) => v === b[i]), `Chunk-independent ${group}/${channel}`);
  }
  const triangle = new ChainOracle([rows[98]]).snapshot().groups[2];
  assert(triangle.ids.length === 6 && triangle.positions[0] === triangle.positions[6] &&
    triangle.positions[4] === triangle.positions[8] && triangle.positions[5] === triangle.positions[9], 'Rectangle diagonal triangulation');
  const point = {...rows[0], x:1.1, y:2.2}, late = {...point, x:7.7, y:8.8};
  const state = new ChainOracle([point]);
  state.applyMove([{id:1,x:3.3,y:4.4}]); state.applyColor([{id:1,color:[1,2,3,41]}]); state.append(late);
  let g = state.snapshot().groups[0];
  assert(g.positions[0] === Math.fround(3.3) && g.positions[2] === Math.fround(7.7) &&
    g.colors[3] === 41 && g.colors[7] === 190, 'Late append does not inherit prior move or color');
  state.applyRemove([1]);
  assert(state.applyMove([{id:1,x:99,y:99}]).ignored === 1 && state.applyColor([{id:1,color:[9,9,9,255]}]).ignored === 1, 'Deleted ordinary edits ignored');
  state.append({...late,x:10.1,y:11.2}); g = state.snapshot().groups[0];
  assert(g.colors[3] === 0 && g.colors[7] === 0 && g.colors[11] === 0, 'Late append inherits tombstone only');
  assert(state.applyRemove([1]).ignored === 1 && state.applyRestore([1,1]).restored === 1 && state.applyRestore([1]).restored === 0, 'Removal/restoration idempotence');
  g = state.snapshot().groups[0];
  assert(g.colors[3] === 41 && g.colors[7] === 190 && g.colors[11] === 190 &&
    g.positions[0] === Math.fround(3.3) && g.positions[2] === Math.fround(7.7) && g.positions[4] === Math.fround(10.1), 'Each restored slot retains its own pre-delete or append values');
  const prior = Array.from(g.positions); let threw = false;
  try { state.applyMove([{id:1,x:2,y:3},{id:2,x:NaN,y:4}]); } catch { threw = true; }
  assert(threw && state.snapshot().groups[0].positions.every((v,i) => v === prior[i]), 'Invalid multi-update is atomic');
  assert(state.applyMove([{id:9000000,x:1,y:1}]).ignored === 1 && state.applyRemove([9000000]).ignored === 1, 'Unbound operations ignored');
  const isolated = state.snapshot(); isolated.groups[0].colors[0] = 99;
  assert(state.snapshot().groups[0].colors[0] === 1, 'Snapshots own independent typed arrays');
  return {passed:true, checks, records:rows.length, vertices:whole.totalVertices, scope:'Pure independent fixture and state oracle; no production or rendering validation'};
}
