/**
 * Plan byte ranges for bufferSubData without changing the caller's ranges.
 * Input and output use half-open intervals [start, end). Empty intervals do not
 * require an upload. Merging can include clean bytes, but never drops dirty ones.
 */
export function planDirtyRanges(ranges, { mergeGapBytes = 64, maxRanges = 32 } = {}) {
  if (!Array.isArray(ranges)) throw new TypeError('ranges must be an array');
  if (!Number.isSafeInteger(mergeGapBytes) || mergeGapBytes < 0) {
    throw new RangeError('mergeGapBytes must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(maxRanges) || maxRanges < 1) {
    throw new RangeError('maxRanges must be a positive safe integer');
  }

  const sorted = ranges.map((range) => {
    if (!Array.isArray(range) || range.length !== 2) {
      throw new TypeError('each range must be [start, end]');
    }
    const [start, end] = range;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end < start) {
      throw new RangeError('range endpoints must be non-negative safe integers with start <= end');
    }
    return [start, end];
  }).filter(([start, end]) => start !== end);
  sorted.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const merged = [];
  for (const [start, end] of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && start - previous[1] <= mergeGapBytes) {
      previous[1] = Math.max(previous[1], end);
    } else {
      merged.push([start, end]);
    }
  }

  // After overlap and threshold merging, the remaining gaps are independent and
  // closing any one of them merges exactly two neighbours, so reaching
  // maxRanges costs exactly (count - maxRanges) closed gaps and the cheapest
  // choice is the set of smallest gaps. Selecting them in one sort is
  // O(m log m); the previous repeated scan was O(m^2) on fragmented updates.
  // Ties prefer the earlier range, matching the incremental behaviour.
  if (merged.length > maxRanges) {
    const gaps = [];
    for (let i = 0; i < merged.length - 1; i++) gaps.push({ index: i, gap: merged[i + 1][0] - merged[i][1] });
    gaps.sort((a, b) => a.gap - b.gap || a.index - b.index);
    const close = new Set();
    for (let i = 0; i < merged.length - maxRanges; i++) close.add(gaps[i].index);
    const rebuilt = [];
    for (let i = 0; i < merged.length; i++) {
      if (!rebuilt.length || !close.has(i - 1)) rebuilt.push([merged[i][0], merged[i][1]]);
      else rebuilt[rebuilt.length - 1][1] = merged[i][1];
    }
    return rebuilt;
  }
  return merged;
}
