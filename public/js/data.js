/** Deterministic synthetic campus data and pure streaming/packing helpers. */
export const REFERENCE_CENTER = Object.freeze({ lng: 121.592, lat: 31.189 });
export const REGION_DEFINITIONS = Object.freeze([
  { id: 'R01', name: '临港智造西区', x: -3900, y: -2900, mean: 46 },
  { id: 'R02', name: '装备工坊', x: -1300, y: -3100, mean: 52 },
  { id: 'R03', name: '能源枢纽', x: 2200, y: -2700, mean: 60 },
  { id: 'R04', name: '海港物流', x: 4000, y: -200, mean: 55 },
  { id: 'R05', name: '研发园区', x: 1700, y: 800, mean: 42 },
  { id: 'R06', name: '公共设施', x: -1200, y: 900, mean: 49 },
  { id: 'R07', name: '生态工厂', x: -3400, y: 2700, mean: 44 },
  { id: 'R08', name: '北部仓储', x: 700, y: 3500, mean: 58 },
]);
export const DEFAULT_STREAM = Object.freeze({ count: 100000, seed: 20261009, chunk: 1024, delay: 12 });

export function createRandom(seed = DEFAULT_STREAM.seed) {
  let state = Number(seed) >>> 0;
  return function random() {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 2) => Number(value.toFixed(digits));

/** Mixed local Baidu Mercator metre coordinates: 88% devices, 10% pipes, 2% sites. */
export function* generateRecords({ count = DEFAULT_STREAM.count, seed = DEFAULT_STREAM.seed } = {}) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000000) throw new RangeError('count must be an integer from 1 to 1000000');
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 4294967295) throw new RangeError('seed must be an unsigned 32-bit integer');
  const random = createRandom(seed);
  const gaussian = () => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-9))) * Math.cos(2 * Math.PI * random());
  for (let index = 0; index < count; index += 1) {
    const region = REGION_DEFINITIONS[Math.floor(random() * REGION_DEFINITIONS.length)];
    // Rotated campus grids, small clusters, and corridors give the map a spatial structure.
    const angle = (Number(region.id.slice(1)) % 3 - 1) * 0.18;
    const corridor = random() < 0.22;
    const localX = corridor ? (random() - 0.5) * 1700 : gaussian() * 380;
    const localY = corridor ? gaussian() * 44 : gaussian() * 290;
    const x = round(clamp(region.x + localX * Math.cos(angle) - localY * Math.sin(angle), -5750, 5750));
    const y = round(clamp(region.y + localX * Math.sin(angle) + localY * Math.cos(angle), -5750, 5750));
    let value = region.mean + gaussian() * 3.5;
    let groundTruth = 'normal';
    if (index >= 512 && index % 97 === 0) {
      value += 34 + random() * 20;
      groundTruth = 'critical';
    } else if (index >= 512 && index % 61 === 0) {
      value += 14 + random() * 6;
      groundTruth = 'warning';
    }
    const slot = index % 100;
    const kind = slot < 88 ? 'point' : slot < 98 ? 'line' : 'polygon';
    const record = { id: index + 1, kind, x, y, value: round(value), status: random() < 0.005 ? 'maintenance' : 'online', region: region.id, groundTruth };
    if (kind === 'line') {
      const length = 55 + random() * 210;
      const direction = random() < 0.5 ? angle : angle + Math.PI / 2;
      const end = [round(clamp(x + Math.cos(direction) * length, -5990, 5990)), round(clamp(y + Math.sin(direction) * length, -5990, 5990))];
      record.coords = [[x, y], end];
      record.x = round((x + end[0]) / 2);
      record.y = round((y + end[1]) / 2);
    } else if (kind === 'polygon') {
      const halfWidth = 22 + random() * 65;
      const halfHeight = 20 + random() * 45;
      record.coords = [[round(x - halfWidth), round(y - halfHeight)], [round(x + halfWidth), round(y - halfHeight)], [round(x + halfWidth), round(y + halfHeight)], [round(x - halfWidth), round(y + halfHeight)], [round(x - halfWidth), round(y - halfHeight)]];
    }
    yield record;
  }
}

/** Region-wise Welford model. Ground-truth labels are never read by this detector. */
export function createDetector({ mode = 'adaptive', warmup = 24, warningZ = 3, criticalZ = 5 } = {}) {
  const regions = new Map();
  let observations = 0;
  let warmedRegions = 0;
  return {
    mode,
    observe(record) {
      const value = Number(record.value);
      const regionKey = String(record.region);
      let state = regions.get(regionKey);
      if (!state) {
        state = { n: 0, mean: 0, m2: 0 };
        regions.set(regionKey, state);
      }
      observations += 1;
      const trained = state.n >= warmup;
      const deviation = Math.max(2.5, Math.sqrt(state.n > 1 ? state.m2 / (state.n - 1) : 12.25));
      const score = mode === 'fixed' ? Math.max(0, (value - 58) / 4) : trained ? Math.max(0, (value - state.mean) / deviation) : 0;
      const status = score >= criticalZ ? 'critical' : score >= warningZ ? 'warning' : 'normal';
      // Once warm, reject alert observations so injected faults do not redefine normal.
      if (mode === 'fixed' || !trained || status === 'normal') {
        state.n += 1;
        const delta = value - state.mean;
        state.mean += delta / state.n;
        state.m2 += delta * (value - state.mean);
        if (state.n === warmup) warmedRegions += 1;
      }
      return { score, status, mean: state.mean, deviation, trained };
    },
    snapshot() { return { mode, observations, regions: regions.size, warmedRegions, warmup }; },
  };
}

function invalidRecord(index, detail) {
  throw new TypeError(`Invalid record ${index + 1}: ${detail}`);
}

export function validateRecord(record, index = 0) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) invalidRecord(index, 'expected an object');
  if (!Number.isInteger(record.id) || record.id < 1 || record.id > 4294967295) invalidRecord(index, 'id must be uint32');
  if (record.kind !== 'point' && record.kind !== 'line' && record.kind !== 'polygon') invalidRecord(index, 'unknown kind');
  if (!Number.isFinite(record.x) || !Number.isFinite(record.y) || !Number.isFinite(record.value)) invalidRecord(index, 'x, y and value must be finite numbers');
  if (typeof record.region !== 'string' || !record.region) invalidRecord(index, 'region is required');
  if (record.kind !== 'point') {
    const coords = record.coords;
    if (!Array.isArray(coords) || coords.length < (record.kind === 'line' ? 2 : 4)) invalidRecord(index, 'invalid coords');
    for (let i = 0; i < coords.length; i += 1) {
      // Array.prototype.some/every skipped holes in the original validator.
      if (!(i in coords)) continue;
      const point = coords[i];
      if (!Array.isArray(point) || point.length !== 2 || (0 in point && !Number.isFinite(point[0])) || (1 in point && !Number.isFinite(point[1]))) invalidRecord(index, 'invalid coords');
    }
    // This demo intentionally supports only simple rectangular polygons.
    if (record.kind === 'polygon') {
      const c = record.coords;
      if ((c.length !== 4 && c.length !== 5) || c[0][1] !== c[1][1] || c[1][0] !== c[2][0] || c[2][1] !== c[3][1] || c[3][0] !== c[0][0] || (c.length === 5 && (c[4][0] !== c[0][0] || c[4][1] !== c[0][1]))) invalidRecord(index, 'only simple rectangular polygons are supported');
    }
  }
  return record;
}

function alertColor(score, status, color) {
  if (status === 'critical') {
    color[0] = 255; color[1] = 72; color[2] = clamp(Math.round(92 - score * 2), 35, 90); color[3] = 245;
  } else if (status === 'warning') {
    color[0] = 255; color[1] = clamp(Math.round(220 - score * 5), 170, 220); color[2] = 66; color[3] = 238;
  } else {
    color[0] = 38; color[1] = clamp(Math.round(205 - score * 5), 180, 205); color[2] = clamp(Math.round(174 + score * 8), 174, 198); color[3] = 190;
  }
}

function writeVertex(bucket, x, y, id, color) {
  const vertex = bucket.cursor++;
  bucket.positions[vertex * 2] = x;
  bucket.positions[vertex * 2 + 1] = y;
  const offset = vertex * 4;
  bucket.colors[offset] = color[0]; bucket.colors[offset + 1] = color[1];
  bucket.colors[offset + 2] = color[2]; bucket.colors[offset + 3] = color[3];
  bucket.ids[vertex] = id;
}

/** Packs flat draw arrays. Polygons are six vertices for simple rectangles only. */
export function packBatch(records, { detector = createDetector(), maxAnomalies = 100 } = {}) {
  // Count before allocation, then write the final transferable arrays directly.
  // Validation and detector observation still happen together in input order.
  const vertexCounts = { point: 0, line: 0, polygon: 0 };
  records.forEach(record => {
    if (record?.kind === 'point') vertexCounts.point += 1;
    else if (record?.kind === 'line' && Array.isArray(record.coords)) vertexCounts.line += Math.max(0, record.coords.length - 1) * 2;
    else if (record?.kind === 'polygon') vertexCounts.polygon += 6;
  });
  const buckets = Object.fromEntries(['point', 'line', 'polygon'].map(kind => [kind, {
    kind, positions: new Float32Array(vertexCounts[kind] * 2), colors: new Uint8Array(vertexCounts[kind] * 4),
    ids: new Uint32Array(vertexCounts[kind]), featureCount: 0, cursor: 0,
  }]));
  const color = new Uint8Array(4);
  const anomalies = [];
  const summary = { normal: 0, warning: 0, critical: 0, points: 0, lines: 0, polygons: 0, total: 0, evaluated: 0, truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0 };
  records.forEach((raw, index) => {
    const record = validateRecord(raw, index);
    const result = detector.observe(record);
    const bucket = buckets[record.kind];
    alertColor(result.score, result.status, color);
    if (record.kind === 'point') writeVertex(bucket, record.x, record.y, record.id, color);
    else if (record.kind === 'line') {
      for (let i = 1; i < record.coords.length; i += 1) {
        const a = record.coords[i - 1];
        const b = record.coords[i];
        writeVertex(bucket, a[0], a[1], record.id, color);
        writeVertex(bucket, b[0], b[1], record.id, color);
      }
    } else {
      const c = record.coords;
      writeVertex(bucket, c[0][0], c[0][1], record.id, color);
      writeVertex(bucket, c[1][0], c[1][1], record.id, color);
      writeVertex(bucket, c[2][0], c[2][1], record.id, color);
      writeVertex(bucket, c[0][0], c[0][1], record.id, color);
      writeVertex(bucket, c[2][0], c[2][1], record.id, color);
      writeVertex(bucket, c[3][0], c[3][1], record.id, color);
    }
    bucket.featureCount += 1;
    summary[result.status] += 1;
    summary[record.kind === 'point' ? 'points' : record.kind === 'line' ? 'lines' : 'polygons'] += 1;
    summary.total += 1;
    if (result.status !== 'normal' && anomalies.length < maxAnomalies) anomalies.push({ id: record.id, x: record.x, y: record.y, value: record.value, score: round(result.score, 3), region: record.region, status: result.status });
    // Labels are consulted only here, after detection, to evaluate this simulated dataset.
    if (record.groundTruth === 'normal' || record.groundTruth === 'warning' || record.groundTruth === 'critical') {
      const truth = record.groundTruth !== 'normal';
      const predicted = result.status !== 'normal';
      summary.evaluated += 1;
      summary[truth ? predicted ? 'truePositive' : 'falseNegative' : predicted ? 'falsePositive' : 'trueNegative'] += 1;
    }
  });
  summary.precision = summary.truePositive + summary.falsePositive ? summary.truePositive / (summary.truePositive + summary.falsePositive) : null;
  summary.recall = summary.truePositive + summary.falseNegative ? summary.truePositive / (summary.truePositive + summary.falseNegative) : null;
  return { groups: Object.values(buckets).filter(b => b.featureCount).map(b => ({ kind: b.kind, positions: b.positions, colors: b.colors, ids: b.ids, featureCount: b.featureCount })), featureCount: records.length, anomalies, summary };
}

export function transferablesForBatch(batch) {
  return batch.groups.flatMap(group => [group.positions.buffer, group.colors.buffer, group.ids.buffer]);
}

/** Incremental lines; safe with LF, CRLF, and a final line lacking a newline. */
export function createNdjsonParser({ maxLineLength = 1048576 } = {}) {
  let remainder = '';
  let lineNumber = 0;
  const parseLine = line => {
    lineNumber += 1;
    // JSON null is a record value; only whitespace denotes an absent line.
    if (!line.trim()) return undefined;
    if (line.length > maxLineLength) throw new Error(`NDJSON line ${lineNumber} exceeds the size limit`);
    try { return JSON.parse(line); } catch (error) { throw new Error(`Invalid NDJSON at line ${lineNumber}: ${error.message}`); }
  };
  return {
    push(text) {
      // Only an unfinished line crosses chunks. Avoid a split array and joining
      // that tail to an entire network chunk when most lines are already complete.
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) {
        remainder += text;
        if (remainder.length > maxLineLength) throw new Error(`NDJSON line ${lineNumber + 1} exceeds the size limit`);
        return [];
      }
      const tail = text.slice(lastNewline + 1);
      if (tail.length > maxLineLength) throw new Error(`NDJSON line ${lineNumber + 1} exceeds the size limit`);
      const records = [];
      let start = 0;
      let newline = text.indexOf('\n');
      if (remainder) {
        const record = parseLine(remainder + text.slice(0, newline));
        if (record !== undefined) records.push(record);
        remainder = '';
        start = newline + 1;
        newline = text.indexOf('\n', start);
      }
      while (newline !== -1) {
        const record = parseLine(text.slice(start, newline));
        if (record !== undefined) records.push(record);
        start = newline + 1;
        newline = text.indexOf('\n', start);
      }
      remainder = tail;
      return records;
    },
    finish() {
      if (!remainder) return [];
      const record = parseLine(remainder);
      remainder = '';
      return record === undefined ? [] : [record];
    },
    get lineNumber() { return lineNumber; },
  };
}

export function createNdjsonDecoder(options) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parser = createNdjsonParser(options);
  return {
    push(bytes) { return parser.push(decoder.decode(bytes, { stream: true })); },
    finish() { return [...parser.push(decoder.decode()), ...parser.finish()]; },
  };
}

/**
 * Pull decoder for ACK-paced consumers. A push only decodes UTF-8; drain(limit)
 * parses at most limit nonblank records. The caller must drain buffered input
 * before pushing again, so a network chunk cannot create an unbounded list of
 * parsed records while the consumer waits for a batch acknowledgement.
 *
 * This bounds parsed record count, not bytes: the current raw reader chunk and
 * decoded text remain resident, and JSON.parse of one maxLineLength line is not
 * preemptible. A malformed later line can fail after valid earlier batches were
 * delivered. Callers must label that run partial/failed, never complete.
 * Existing createNdjsonDecoder push/finish semantics remain unchanged.
 */
export function createNdjsonPullDecoder({ maxLineLength = 1048576 } = {}) {
  if (!Number.isSafeInteger(maxLineLength) || maxLineLength < 1) throw new RangeError('maxLineLength must be a positive integer');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = null, cursor = 0, prefix = '', remainder = '', lineNumber = 0;
  let finished = false, failed = false;
  const checkUsable = () => { if (failed) throw new Error('NDJSON decoder is failed'); };
  const parseLine = line => {
    lineNumber++;
    if (!line.trim()) return undefined;
    if (line.length > maxLineLength) throw new Error(`NDJSON line ${lineNumber} exceeds the size limit`);
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`Invalid NDJSON at line ${lineNumber}: ${error.message}`); }
  };
  const install = decoded => { text = decoded; cursor = 0; prefix = remainder; remainder = ''; };
  const release = () => { text = null; cursor = 0; prefix = ''; };
  return {
    push(bytes) {
      checkUsable();
      if (finished) throw new Error('Cannot push after NDJSON input finished');
      if (text !== null) throw new Error('Drain pending NDJSON input before pushing');
      try { install(decoder.decode(bytes, { stream: true })); }
      catch (error) { failed = true; throw error; }
    },
    drain(limit) {
      checkUsable();
      if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('drain limit must be a positive integer');
      if (text === null) return [];
      const records = [];
      try {
        while (records.length < limit && text !== null) {
          const newline = text.indexOf('\n', cursor);
          if (newline === -1) {
            const tail = prefix + text.slice(cursor);
            release();
            if (finished) {
              if (tail) { const record = parseLine(tail); if (record !== undefined) records.push(record); }
            } else {
              if (tail.length > maxLineLength) throw new Error(`NDJSON line ${lineNumber + 1} exceeds the size limit`);
              remainder = tail;
            }
            break;
          }
          const line = prefix + text.slice(cursor, newline);
          prefix = ''; cursor = newline + 1;
          const record = parseLine(line);
          if (record !== undefined) records.push(record);
          // No tail remains. Release the whole source string before waiting for
          // ACK instead of requiring one extra empty drain to free it.
          if (cursor === text.length) release();
        }
        return records;
      } catch (error) {
        failed = true; release(); remainder = ''; throw error;
      }
    },
    finishInput() {
      checkUsable();
      if (finished) throw new Error('NDJSON input already finished');
      if (text !== null) throw new Error('Drain pending NDJSON input before finishing');
      try { const flushed = decoder.decode(); finished = true; install(flushed); }
      catch (error) { failed = true; throw error; }
    },
    get hasPendingInput() { return text !== null; },
    get lineNumber() { return lineNumber; },
    // Logical string code units only: engines may retain parent substrings.
    get bufferedTextCodeUnits() { return (text?.length ?? 0) + prefix.length + remainder.length; },
  };
}

export function parseNdjson(text) {
  const parser = createNdjsonParser();
  return [...parser.push(text), ...parser.finish()];
}

/** Only an explicit nonnegative safe integer header declares an exact count. */
export function parseStreamCountHeader(value) {
  const declared = typeof value === 'string' ? value.trim() : '';
  const count = /^\d+$/.test(declared) ? Number(declared) : NaN;
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/** Verify after complete EOF/decoder flush; null means no exact count contract. */
export function verifyStreamRecordCount(actualCount, expectedCount) {
  if (expectedCount !== null && actualCount !== expectedCount) {
    throw new Error(`Stream count mismatch: expected ${expectedCount} records, received ${actualCount}`);
  }
}
