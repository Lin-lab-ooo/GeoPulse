import { planDirtyRanges } from './dirty-ranges.js';

const RGBA_BYTES = 4;
const MAX_VERTICES = 65535;
const DEFAULT_PROMOTION = 512;
const HASH_SIZE = 1024;
const trailingZeroes = value => 31 - Math.clz32((value & -value) >>> 0);
const popcount = value => {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return Math.imul((value + (value >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
};

/** Optional RGBA dirty state. mark() stores vertex slots, never per-vertex
 * [start,end] arrays. CPU colors, geometry, alerts and revisions belong to the
 * renderer. A plan only concerns old uploaded prefix bytes; the caller must
 * successfully submit GL work before clear(token). No position-buffer state.
 */
export class ColorDirtyState {
  get pendingUniqueVertices() { return this._unique; }

  constructor({ capacity = MAX_VERTICES, promoteAt = DEFAULT_PROMOTION } = {}) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_VERTICES) throw new RangeError('capacity must be 1..65535');
    if (!Number.isSafeInteger(promoteAt) || promoteAt < 2 || promoteAt > DEFAULT_PROMOTION) throw new RangeError('promoteAt must be 2..512');
    this.capacity = capacity;
    this.promoteAt = promoteAt;
    this._version = 1;
    this._unique = 0;
    this._marks = 0;
    this._min = Infinity;
    this._max = 0;
    this._tiny = new Uint16Array(Math.min(8, capacity));
    this._hash = null;
    this._bitmap = null;
    this._touchedWords = null;
    this._touchedWordCount = 0;
    this._lastToken = null;
  }

  _hashIndex(encoded) {
    let index = Math.imul(encoded, 0x9e3779b1) >>> 22;
    for (let probes = 0; probes < HASH_SIZE; probes++) {
      if (!this._hash[index] || this._hash[index] === encoded) return index;
      index = (index + 1) & (HASH_SIZE - 1);
    }
    throw new Error('Internal tiny dirty hash is full');
  }

  _ensureHash() {
    if (this._hash || this._unique < 8 || this.capacity <= 8) return;
    this._hash = new Uint16Array(HASH_SIZE);
    for (let i = 0; i < this._unique; i++) {
      const encoded = this._tiny[i] + 1;
      this._hash[this._hashIndex(encoded)] = encoded;
    }
  }

  _setBit(vertex) {
    const word = vertex >>> 5, mask = (1 << (vertex & 31)) >>> 0, previous = this._bitmap[word];
    if (previous & mask) return false;
    if (!previous) this._touchedWords[this._touchedWordCount++] = word;
    this._bitmap[word] = (previous | mask) >>> 0;
    return true;
  }

  _promote() {
    const words = Math.ceil(this.capacity / 32);
    this._bitmap = new Uint32Array(words);
    this._touchedWords = new Uint16Array(words);
    for (let i = 0; i < this._unique; i++) this._setBit(this._tiny[i]);
    this._tiny = null;
    this._hash = null;
  }

  /** Returns whether the slot was newly dirty. Even duplicates invalidate a
   * previous plan token: the same slot may have received a new RGBA value.
   */
  mark(vertex) {
    if (!Number.isSafeInteger(vertex) || vertex < 0 || vertex >= this.capacity) throw new RangeError('dirty vertex is outside page capacity');
    this._version++;
    this._marks++;
    let added;
    if (this._bitmap) added = this._setBit(vertex);
    else {
      this._ensureHash();
      if (this._hash) {
        const encoded = vertex + 1, index = this._hashIndex(encoded);
        added = !this._hash[index];
        if (added) this._hash[index] = encoded;
      } else {
        added = true;
        for (let i = 0; i < this._unique; i++) if (this._tiny[i] === vertex) { added = false; break; }
      }
      if (added) {
        if (this._unique === this._tiny.length) {
          const next = new Uint16Array(Math.min(this.capacity, this.promoteAt, Math.max(this._unique + 1, this._tiny.length * 2)));
          next.set(this._tiny); this._tiny = next;
        }
        this._tiny[this._unique] = vertex;
      }
    }
    if (added) {
      this._unique++;
      this._min = Math.min(this._min, vertex);
      this._max = Math.max(this._max, vertex + 1);
      if (!this._bitmap && this._unique >= this.promoteAt) this._promote();
    }
    return added;
  }

  _prefixStats(limit) {
    if (!this._unique || this._min >= limit) return { unique: 0, min: 0, max: 0 };
    if (this._max <= limit) return { unique: this._unique, min: this._min, max: this._max };
    let unique = 0, min = Infinity, max = 0;
    if (!this._bitmap) {
      for (let i = 0; i < this._unique; i++) {
        const vertex = this._tiny[i];
        if (vertex < limit) { unique++; min = Math.min(min, vertex); max = Math.max(max, vertex + 1); }
      }
    } else {
      for (let word = 0; word < Math.ceil(limit / 32); word++) {
        let mask = this._bitmap[word];
        if ((word + 1) * 32 > limit) mask &= 0xffffffff >>> (32 - limit % 32);
        if (mask) {
          unique += popcount(mask);
          min = Math.min(min, word * 32 + trailingZeroes(mask));
          max = word * 32 + 32 - Math.clz32(mask);
        }
      }
    }
    return { unique, min: unique ? min : 0, max };
  }

  /** Sorted exact RGBA runs; bitmap enumeration merges neighbour slots before
   * allocating an output range, rather than allocating a pair per dirty slot.
   */
  _exactRanges(limit) {
    const ranges = [];
    const emit = (start, end) => {
      const previous = ranges[ranges.length - 1];
      if (previous && previous[1] === start) previous[1] = end;
      else ranges.push([start, end]);
    };
    if (!this._bitmap) {
      const slots = this._tiny.slice(0, this._unique);
      slots.sort();
      for (const slot of slots) if (slot < limit) emit(slot * 4, (slot + 1) * 4);
    } else {
      for (let word = 0; word < Math.ceil(limit / 32); word++) {
        let mask = this._bitmap[word];
        if ((word + 1) * 32 > limit) mask &= 0xffffffff >>> (32 - limit % 32);
        while (mask) {
          const bit = trailingZeroes(mask), shifted = mask >>> bit;
          const complement = (~shifted) >>> 0;
          const width = complement ? trailingZeroes(complement) : 32;
          emit((word * 32 + bit) * 4, (word * 32 + bit + width) * 4);
          const run = width === 32 ? 0xffffffff : ((0xffffffff >>> (32 - width)) << bit) >>> 0;
          mask = (mask & ~run) >>> 0;
        }
      }
    }
    return ranges;
  }

  /** Never consumes marks. Default dense branch adds at most 2x unique bytes;
   * fallback retains the old gap64/cap32 behavior, including its byte tradeoff.
   * bufferBytes is the old page.uploaded*4, not allocated capacity bytes.
   */
  peekPlan({ bufferBytes, mergeGapBytes = 64, maxRanges = 32 } = {}) {
    if (!Number.isSafeInteger(bufferBytes) || bufferBytes < 0 || bufferBytes > this.capacity * RGBA_BYTES || bufferBytes % RGBA_BYTES) {
      throw new RangeError('bufferBytes must be a RGBA-aligned old uploaded prefix');
    }
    if (!Number.isSafeInteger(mergeGapBytes) || mergeGapBytes < 0) throw new RangeError('invalid mergeGapBytes');
    if (!Number.isSafeInteger(maxRanges) || maxRanges < 1) throw new RangeError('invalid maxRanges');
    const prefixVertices = bufferBytes / 4, stats = this._prefixStats(prefixVertices);
    const uniqueDirtyBytes = stats.unique * 4, spanBytes = stats.unique ? (stats.max - stats.min) * 4 : 0;
    let ranges, choice, fastPathBoundPassed = null;
    if (!stats.unique) { ranges = []; choice = 'empty'; }
    else if (stats.unique >= DEFAULT_PROMOTION && mergeGapBytes === 64 && maxRanges === 32 && spanBytes <= uniqueDirtyBytes * 2) {
      const full = spanBytes >= bufferBytes * .9 && bufferBytes <= uniqueDirtyBytes * 2;
      ranges = full ? [[0, bufferBytes]] : [[stats.min * 4, stats.max * 4]];
      choice = full ? 'accumulator-full' : 'accumulator-span';
      fastPathBoundPassed = true;
    } else {
      ranges = planDirtyRanges(this._exactRanges(prefixVertices), { mergeGapBytes, maxRanges });
      choice = 'accumulator-legacy';
    }
    const token = Object.freeze({ version: this._version, prefixVertices, includesAllMarks: stats.unique === this._unique });
    this._lastToken = token;
    return { ranges, token, choice, uniqueDirtyBytes, spanBytes, uniqueVertices: stats.unique,
      excludedUniqueVertices: this._unique - stats.unique, fastPathBoundPassed,
      uploadedBytes: ranges.reduce((sum, [a, b]) => sum + b - a, 0), ...this.getStats() };
  }

  /** A stale token or uncommitted excluded tail keeps ALL marks for retry.
   * tailUploaded=true is allowed only after the caller also committed append.
   */
  clear(token, { tailUploaded = false } = {}) {
    if (typeof tailUploaded !== 'boolean') throw new TypeError('tailUploaded must be boolean');
    if (!token || token !== this._lastToken || token.version !== this._version || (!token.includesAllMarks && !tailUploaded)) return false;
    this.reset();
    return true;
  }

  reset({ release = false } = {}) {
    if (typeof release !== 'boolean') throw new TypeError('release must be boolean');
    if (this._bitmap) for (let i = 0; i < this._touchedWordCount; i++) this._bitmap[this._touchedWords[i]] = 0;
    if (this._hash) this._hash.fill(0);
    this._unique = 0; this._marks = 0; this._min = Infinity; this._max = 0; this._touchedWordCount = 0;
    this._version++; this._lastToken = null;
    if (release) {
      this._bitmap = null; this._touchedWords = null; this._hash = null;
      this._tiny = new Uint16Array(Math.min(8, this.capacity));
    }
  }

  getStats() {
    return { pendingMarks: this._marks, pendingUniqueVertices: this._unique,
      pendingMinVertex: this._unique ? this._min : null, pendingMaxVertexExclusive: this._max,
      storage: this._bitmap ? 'bitmap' : 'tiny', touchedWords: this._touchedWordCount,
      memoryBytes: (this._tiny?.byteLength || 0) + (this._hash?.byteLength || 0)
        + (this._bitmap?.byteLength || 0) + (this._touchedWords?.byteLength || 0) };
  }
}
