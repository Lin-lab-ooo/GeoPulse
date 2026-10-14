// A bounded page-local summary, not a drawing index. Each bucket owns the full
// bounds and count of its primitives, including long lines and triangles.
// A count is an upper bound: a large value can skip costly fine-tree creation,
// but must never be treated as an exact visible set or used to discard data.
export class CoarseSpatialIndex {
  constructor({ primitiveSize = 1, maxBuckets = 256 } = {}) {
    if (![1, 2, 3].includes(primitiveSize)) throw new RangeError('invalid primitiveSize');
    if (!Number.isSafeInteger(maxBuckets) || maxBuckets < 4 || maxBuckets > 4096) {
      throw new RangeError('maxBuckets must be between 4 and 4096');
    }
    this.primitiveSize = primitiveSize;
    this.maxBuckets = maxBuckets;
    this.indexedUntil = 0;
    this.cellSize = 0;
    this.merges = 0;
    this._buckets = new Map();
    this._bounds = new Float64Array(maxBuckets * 4);
    this._cells = new Float64Array(maxBuckets * 2);
    this._counts = new Uint32Array(maxBuckets);
  }

  // Only contiguous complete-primitive appends are accepted. The renderer owns
  // authoritative positions; this summary retains no per-primitive geometry.
  append(positions, start, end) {
    if (!(positions instanceof Float32Array) || positions.length % 2) throw new TypeError('xy Float32Array required');
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start !== this.indexedUntil ||
        end < start || end > positions.length / 2 || start % this.primitiveSize || end % this.primitiveSize) {
      throw new RangeError('append must continue at indexedUntil with complete primitives');
    }
    for (let i = start * 2; i < end * 2; i++) {
      if (!Number.isFinite(positions[i])) throw new RangeError('coordinates must be finite');
    }
    if (start === end) return 0;
    if (!this.cellSize) {
      // Seed scale from a bounded sample of this arrival, then fold buckets as
      // necessary. Subsequent distribution changes require no primitive rescan.
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const primitives = (end - start) / this.primitiveSize;
      for (let sample = 0; sample < Math.min(32, primitives); sample++) {
        const vertex = start + Math.floor(sample * primitives / Math.min(32, primitives)) * this.primitiveSize;
        const x = positions[vertex * 2], y = positions[vertex * 2 + 1];
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      this.cellSize = 2 ** Math.ceil(Math.log2(Math.max(8, (maxX - minX) / 16, (maxY - minY) / 16)));
    }
    for (let vertex = start; vertex < end; vertex += this.primitiveSize) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let offset = 0; offset < this.primitiveSize; offset++) {
        const x = positions[(vertex + offset) * 2], y = positions[(vertex + offset) * 2 + 1];
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      let bx = Math.floor(cx / this.cellSize), by = Math.floor(cy / this.cellSize);
      let key = bx + ',' + by;
      while (!this._buckets.has(key) && this._buckets.size === this.maxBuckets) {
        this._fold();
        bx = Math.floor(cx / this.cellSize); by = Math.floor(cy / this.cellSize);
        key = bx + ',' + by;
      }
      this._add(key, bx, by, minX, minY, maxX, maxY, 1);
    }
    this.indexedUntil = end;
    return (end - start) / this.primitiveSize;
  }

  _add(key, bx, by, minX, minY, maxX, maxY, count) {
    let bucket = this._buckets.get(key);
    if (bucket === undefined) {
      bucket = this._buckets.size;
      this._buckets.set(key, bucket);
      this._cells[bucket * 2] = bx; this._cells[bucket * 2 + 1] = by;
      this._bounds.set([minX, minY, maxX, maxY], bucket * 4);
      this._counts[bucket] = count;
    } else {
      const at = bucket * 4;
      this._bounds[at] = Math.min(this._bounds[at], minX);
      this._bounds[at + 1] = Math.min(this._bounds[at + 1], minY);
      this._bounds[at + 2] = Math.max(this._bounds[at + 2], maxX);
      this._bounds[at + 3] = Math.max(this._bounds[at + 3], maxY);
      this._counts[bucket] += count;
    }
  }

  _fold() {
    const bounds = this._bounds, cells = this._cells, counts = this._counts;
    const used = this._buckets.size;
    this._buckets = new Map();
    this._bounds = new Float64Array(this.maxBuckets * 4);
    this._cells = new Float64Array(this.maxBuckets * 2);
    this._counts = new Uint32Array(this.maxBuckets);
    this.cellSize *= 2;
    this.merges++;
    for (let i = 0; i < used; i++) {
      const bx = Math.floor(cells[i * 2] / 2), by = Math.floor(cells[i * 2 + 1] / 2);
      const at = i * 4;
      this._add(bx + ',' + by, bx, by, bounds[at], bounds[at + 1], bounds[at + 2], bounds[at + 3], counts[i]);
    }
  }

  count(classifyBounds) {
    if (typeof classifyBounds !== 'function') throw new TypeError('classifier required');
    const result = { bucketsTested: 0, primitivesSelected: 0 };
    const bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    for (let i = 0; i < this._buckets.size; i++) {
      const at = i * 4;
      bounds.minX = this._bounds[at]; bounds.minY = this._bounds[at + 1];
      bounds.maxX = this._bounds[at + 2]; bounds.maxY = this._bounds[at + 3];
      const classification = classifyBounds(bounds);
      if (![-1, 0, 1].includes(classification)) throw new RangeError('classifier must return -1, 0, or 1');
      result.bucketsTested++;
      if (classification !== -1) result.primitivesSelected += this._counts[i];
    }
    return result;
  }

  getStats() {
    const typedArrayBytes = this._bounds.byteLength + this._cells.byteLength + this._counts.byteLength;
    return { buckets: this._buckets.size, primitives: this.indexedUntil / this.primitiveSize,
      cellSize: this.cellSize, merges: this.merges, typedArrayBytes,
      // Map/key overhead is a planning estimate, not a measured JS heap size.
      estimatedBytes: typedArrayBytes + this._buckets.size * 112 };
  }
}
