import { planDirtyRanges } from './research-2.2/public/js/dirty-ranges.js';

export const DENSITY_POLICY = Object.freeze({ minimumRanges: 512, maximumUploadFactor: 2, fullCoverage: .9,
  maximumVertices: 65535, mergeGapBytes: 64, maxRanges: 32 });
const WORDS = Math.ceil(DENSITY_POLICY.maximumVertices / 32);
const popcount = value => {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  value = (value + (value >>> 4)) & 0x0f0f0f0f;
  return Math.imul(value, 0x01010101) >>> 24;
};

/** Fixed conservative RGBA candidate. Scratch is allocated once per planner.
 * Full-word union-find avoids rescanning thousands of already-filled words for
 * repeated or overlapping whole-page ranges: endpoints cost O(1) per range,
 * each interior word becomes full once, with amortized path-compression work.
 * The <=2x unique-byte guarantee applies to density fast paths. Legacy fallback
 * keeps the existing gap64/cap32 behavior and can exceed that byte factor.
 */
export function createDensityUploadPlanner() {
  const bitmap = new Uint32Array(WORDS), next = new Uint16Array(WORDS + 1);
  const scratchBytes = bitmap.byteLength + next.byteLength;
  function find(word) {
    let root = word;
    while (next[root] !== root) root = next[root];
    while (next[word] !== word) { const parent = next[word]; next[word] = root; word = parent; }
    return root;
  }
  return function planUploadByDensity(ranges, bufferBytes) {
    if (!Number.isSafeInteger(bufferBytes) || bufferBytes < 0) throw new RangeError('invalid bufferBytes');
    if (!Array.isArray(ranges)) throw new TypeError('ranges must be an array');
    let count = 0, min = bufferBytes, max = 0, aligned = bufferBytes % 4 === 0;
    for (const range of ranges) {
      if (!Array.isArray(range) || range.length !== 2 || !Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1])
        || range[0] < 0 || range[1] < range[0] || range[1] > bufferBytes) throw new RangeError('dirty range lies outside buffer');
      aligned &&= range[0] % 4 === 0 && range[1] % 4 === 0;
      if (range[0] !== range[1]) { count++; min = Math.min(min, range[0]); max = Math.max(max, range[1]); }
    }
    if (!count) return { ranges: [], choice: 'density-empty', modelUsed: false, uniqueDirtyBytes: 0, scratchBytes };
    // O(1) tiny planner preserves the old mergeGap64 behavior for neighbouring
    // and overlapping two ranges, including one bufferSubData for adjacency.
    if (count <= 2) {
      const nonempty = ranges.filter(([a, b]) => a < b);
      if (count === 1) return { ranges: [[min, max]], choice: 'density-tiny', modelUsed: false, scratchBytes };
      const [a, b] = nonempty[0][0] <= nonempty[1][0] ? nonempty : [nonempty[1], nonempty[0]];
      return { ranges: b[0] - a[1] <= 64 ? [[a[0], Math.max(a[1], b[1])]] : [[a[0], a[1]], [b[0], b[1]]],
        choice: 'density-tiny', modelUsed: false, scratchBytes };
    }
    const legacy = reason => ({ ranges: planDirtyRanges(ranges, { mergeGapBytes: 64, maxRanges: 32 }),
      choice: 'density-legacy', reason, modelUsed: false, scratchBytes, uniqueDirtyBytes: null, fastPathBoundPassed: null });
    if (count < DENSITY_POLICY.minimumRanges) return legacy('below fixed 512-range threshold');
    if (!aligned || bufferBytes / 4 > DENSITY_POLICY.maximumVertices) return legacy('not RGBA4-aligned single-page ranges');
    const slots = bufferBytes / 4, words = Math.ceil(slots / 32);
    bitmap.fill(0, 0, words); for (let word = 0; word <= words; word++) next[word] = word;
    let uniqueSlots = 0, interiorWordsVisited = 0, endpointWordsVisited = 0;
    const setWord = (word, mask) => {
      const old = bitmap[word], updated = (old | mask) >>> 0;
      uniqueSlots += popcount((updated ^ old) >>> 0); bitmap[word] = updated;
      const validMask = word === words - 1 && slots % 32 ? (0xffffffff >>> (32 - slots % 32)) : 0xffffffff;
      if (updated === validMask) next[word] = find(word + 1);
    };
    for (const [a, b] of ranges) {
      if (a === b) continue;
      const firstSlot = a / 4, lastSlot = b / 4 - 1, first = firstSlot >>> 5, last = lastSlot >>> 5;
      const low = (0xffffffff << (firstSlot & 31)) >>> 0, high = (0xffffffff >>> (31 - (lastSlot & 31))) >>> 0;
      setWord(first, first === last ? (low & high) >>> 0 : low); endpointWordsVisited++;
      if (first !== last) {
        setWord(last, high); endpointWordsVisited++;
        for (let word = find(first + 1); word < last; word = find(word + 1)) { setWord(word, 0xffffffff); interiorWordsVisited++; }
      }
    }
    const uniqueDirtyBytes = uniqueSlots * 4, spanBytes = max - min;
    const stats = { uniqueDirtyBytes, spanBytes, dirtyRangeCount: count, scratchBytes, bitmapBytes: bitmap.byteLength,
      skipIndexBytes: next.byteLength, interiorWordsVisited, endpointWordsVisited, modelUsed: false };
    if (spanBytes > uniqueDirtyBytes * 2) return { ...legacy('span exceeds 2x exact unique dirty bytes'), ...stats,
      fastPathBoundPassed: null };
    const full = spanBytes >= bufferBytes * .9 && bufferBytes <= uniqueDirtyBytes * 2;
    const selected = full ? [[0, bufferBytes]] : [[min, max]], uploadedBytes = full ? bufferBytes : spanBytes;
    return { ranges: selected, choice: full ? 'density-full' : 'density-span', ...stats,
      uploadedBytes, uploadFactor: uploadedBytes / uniqueDirtyBytes, fastPathBoundPassed: uploadedBytes <= uniqueDirtyBytes * 2 };
  };
}
