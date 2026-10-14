import { planDirtyRanges } from './research-2.2/public/js/dirty-ranges.js';
const DEFAULT_UPLOAD_POLICY = Object.freeze({ mergeGapBytes: 64, maxRanges: 32 });

/** Data-layout alternative: at many dirty intervals the O(n) enclosing span
 * avoids O(n log n) sorting. Threshold belongs to held-out validation, not a
 * neural prediction. Geometric proximity is not assumed: this is buffer order.
 */
export function planUploadBySpan(ranges, bufferBytes, { minimumRanges = 32, fullCoverage = .9,
  fallback = DEFAULT_UPLOAD_POLICY } = {}) {
  if (!Number.isSafeInteger(bufferBytes) || bufferBytes < 0) throw new RangeError('invalid bufferBytes');
  if (!Number.isSafeInteger(minimumRanges) || minimumRanges < 1) throw new RangeError('invalid minimumRanges');
  if (!Number.isFinite(fullCoverage) || fullCoverage <= 0 || fullCoverage > 1) throw new RangeError('invalid fullCoverage');
  if (!Array.isArray(ranges)) throw new TypeError('ranges must be an array');
  // Validate even the small path; never silently let an invalid offset escape.
  let min = bufferBytes, max = 0, nonempty = 0;
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length !== 2 || !Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1])
      || range[0] < 0 || range[1] < range[0] || range[1] > bufferBytes) throw new RangeError('dirty range lies outside buffer');
    if (range[0] !== range[1]) { min = Math.min(min, range[0]); max = Math.max(max, range[1]); nonempty++; }
  }
  if (!nonempty) return { ranges: [], choice: 'empty', modelUsed: false };
  if (nonempty <= 2) return { ranges: ranges.filter(([a, b]) => a < b).map(([a, b]) => [a, b]),
    choice: 'span-tiny-exact', modelUsed: false };
  if (nonempty < minimumRanges) return { ranges: planDirtyRanges(ranges, fallback), choice: 'span-small-fixed', modelUsed: false };
  const full = (max - min) >= bufferBytes * fullCoverage;
  return { ranges: full ? [[0, bufferBytes]] : [[min, max]], choice: full ? 'span-full' : 'span-envelope',
    modelUsed: false, scannedRanges: ranges.length, envelopeBytes: max - min };
}
