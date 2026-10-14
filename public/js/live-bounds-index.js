// Storage-slot blocks maintain the bounds of current live complete primitives.
// This is a bounds-maintenance hierarchy, not a spatial clustering/query tree.
export class LiveBoundsIndex {
  constructor({ positions, primitiveSize = 1, vertexCapacity = positions?.length / 2,
    blockSize = 64, isRemoved = () => false } = {}) {
    if (!(positions instanceof Float32Array) || positions.length % 2) throw new TypeError('xy Float32Array required');
    if (![1, 2, 3].includes(primitiveSize)) throw new RangeError('primitiveSize must be 1, 2 or 3');
    if (!Number.isSafeInteger(vertexCapacity) || vertexCapacity < 0 || vertexCapacity > 65535 ||
        vertexCapacity > positions.length / 2 || vertexCapacity % primitiveSize) throw new RangeError('vertexCapacity must contain complete page primitives');
    if (![32, 64, 128, 256].includes(blockSize)) throw new RangeError('blockSize must be 32, 64, 128 or 256');
    if (typeof isRemoved !== 'function') throw new TypeError('isRemoved must be a vertex predicate');
    this.positions = positions; this.primitiveSize = primitiveSize; this.vertexCapacity = vertexCapacity;
    this.blockSize = blockSize; this.isRemoved = isRemoved; this.indexedUntil = 0; this.version = 0;
    this.blockCount = Math.ceil(vertexCapacity / primitiveSize / blockSize);
    this.leafBase = 1; while (this.leafBase < this.blockCount) this.leafBase *= 2;
    this.depth = Math.log2(this.leafBase);
    this._bounds = new Float64Array(this.leafBase * 2 * 4);
    this._nonempty = new Uint8Array(this.leafBase * 2);
    this._blockVersions = new Float64Array(this.blockCount);
    this._ancestorMarks = new Uint8Array(this.leafBase);
    this._ancestorWork = new Uint32Array(Math.max(0, this.leafBase - 1));
    this._levelCounts = new Uint32Array(this.depth);
    this._dirty = new Set(); this._captures = new Map(); this._captureBytes = 0;
    this._maintenanceRunning = false; this.destroyed = false;
    this._stats = { appendPrimitives: 0, changedPrimitives: 0, mutationBatches: 0, capturedPrimitives: 0,
      rescanPrimitives: 0, rescanBlocks: 0, discardedRescans: 0, ancestorMerges: 0,
      maintenanceCalls: 0, maintenanceIteratedBlocks: 0, capturePeakTypedArrayBytes: 0 };
  }

  _assertLive() { if (this.destroyed) throw new Error('LiveBoundsIndex destroyed'); }
  _nextVersion() {
    if (this.version >= Number.MAX_SAFE_INTEGER) throw new RangeError('bounds version exhausted');
    return ++this.version;
  }
  _validateStarts(starts) {
    this._assertLive();
    if (!Array.isArray(starts) && !(starts instanceof Uint16Array) && !(starts instanceof Uint32Array) && !(starts instanceof Set)) {
      throw new TypeError('primitive starts must be an array, typed array or Set');
    }
    const unique = new Set();
    for (const start of starts) {
      if (!Number.isSafeInteger(start) || start < 0 || start >= this.indexedUntil || start % this.primitiveSize) {
        throw new RangeError('start must address a complete appended primitive');
      }
      unique.add(start);
    }
    return Uint16Array.from(unique);
  }
  _block(start) { return Math.floor(start / this.primitiveSize / this.blockSize); }
  _primitive(start) {
    // Public append permits mixed IDs/alpha within a line or triangle. Partial
    // vertex removal can still rasterize; only an entirely removed primitive
    // is empty. Keep ALL its vertices in the bbox if any vertex remains live.
    let live = false;
    for (let v = start; v < start + this.primitiveSize; v++) if (!this.isRemoved(v)) { live = true; break; }
    if (!live) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let v = start; v < start + this.primitiveSize; v++) {
      const x = this.positions[v * 2], y = this.positions[v * 2 + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('live coordinates must be finite');
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    return [minX, minY, maxX, maxY];
  }
  _expand(block, b) {
    if (!b) return false;
    const node = this.leafBase + block, at = node * 4;
    if (!this._nonempty[node]) {
      this._bounds.set(b, at); this._nonempty[node] = 1; return true;
    }
    const before = [this._bounds[at], this._bounds[at + 1], this._bounds[at + 2], this._bounds[at + 3]];
    this._bounds[at] = Math.min(before[0], b[0]); this._bounds[at + 1] = Math.min(before[1], b[1]);
    this._bounds[at + 2] = Math.max(before[2], b[2]); this._bounds[at + 3] = Math.max(before[3], b[3]);
    return before.some((v, i) => v !== this._bounds[at + i]);
  }
  _invalidatesExtrema(block, before, after) {
    if (!before) return false;
    const at = (this.leafBase + block) * 4;
    return before[0] === this._bounds[at] && (!after || after[0] > before[0]) ||
      before[1] === this._bounds[at + 1] && (!after || after[1] > before[1]) ||
      before[2] === this._bounds[at + 2] && (!after || after[2] < before[2]) ||
      before[3] === this._bounds[at + 3] && (!after || after[3] < before[3]);
  }
  _combine(node) {
    const left = node * 2, right = left + 1, a = left * 4, b = right * 4, out = node * 4;
    if (!this._nonempty[left] && !this._nonempty[right]) {
      this._nonempty[node] = 0; this._bounds.fill(0, out, out + 4);
    } else if (!this._nonempty[left] || !this._nonempty[right]) {
      const from = this._nonempty[left] ? a : b;
      this._nonempty[node] = 1; for (let i = 0; i < 4; i++) this._bounds[out + i] = this._bounds[from + i];
    } else {
      this._nonempty[node] = 1;
      this._bounds[out] = Math.min(this._bounds[a], this._bounds[b]);
      this._bounds[out + 1] = Math.min(this._bounds[a + 1], this._bounds[b + 1]);
      this._bounds[out + 2] = Math.max(this._bounds[a + 2], this._bounds[b + 2]);
      this._bounds[out + 3] = Math.max(this._bounds[a + 3], this._bounds[b + 3]);
    }
  }
  _mergeAncestors(blocks) {
    // A node is enqueued once, in its fixed depth segment. Processing depths
    // from deep to shallow is O(unique ancestors), with no sorting/rescan of N.
    for (const block of blocks) {
      let node = (this.leafBase + block) >> 1, depth = this.depth - 1;
      while (node) {
        if (this._ancestorMarks[node]) break;
        this._ancestorMarks[node] = 1;
        this._ancestorWork[(2 ** depth - 1) + this._levelCounts[depth]++] = node;
        node >>= 1; depth--;
      }
    }
    let merged = 0;
    for (let depth = this.depth - 1; depth >= 0; depth--) {
      const offset = 2 ** depth - 1, count = this._levelCounts[depth];
      for (let i = 0; i < count; i++) {
        const node = this._ancestorWork[offset + i]; this._combine(node); this._ancestorMarks[node] = 0; merged++;
      }
      this._levelCounts[depth] = 0;
    }
    this._stats.ancestorMerges += merged; return merged;
  }

  append(start, end) {
    this._assertLive();
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start !== this.indexedUntil ||
        end < start || end > this.vertexCapacity || start % this.primitiveSize || end % this.primitiveSize) {
      throw new RangeError('append must continue with complete primitives');
    }
    for (let i = start * 2; i < end * 2; i++) if (!Number.isFinite(this.positions[i])) throw new RangeError('coordinates must be finite');
    if (start === end) return { primitives: 0, ancestorMerges: 0, version: this.version };
    const changed = new Set(), touched = new Set(), version = this._nextVersion();
    for (let v = start; v < end; v += this.primitiveSize) {
      const block = this._block(v); touched.add(block);
      if (this._expand(block, this._primitive(v))) changed.add(block);
    }
    for (const block of touched) this._blockVersions[block] = version;
    this.indexedUntil = end; const primitives = (end - start) / this.primitiveSize;
    this._stats.appendPrimitives += primitives; this._stats.mutationBatches++;
    return { primitives, ancestorMerges: this._mergeAncestors(changed), version };
  }

  /** Capture BEFORE authoritative geometry/removal edits; commit immediately after. */
  captureChanges(starts) {
    const unique = this._validateStarts(starts), bounds = new Float64Array(unique.length * 4),
      alive = new Uint8Array(unique.length), versions = new Float64Array(unique.length);
    for (let i = 0; i < unique.length; i++) {
      const b = this._primitive(unique[i]); if (b) { bounds.set(b, i * 4); alive[i] = 1; }
      versions[i] = this._blockVersions[this._block(unique[i])];
    }
    const typedArrayBytes = unique.byteLength + bounds.byteLength + alive.byteLength + versions.byteLength;
    const token = Object.freeze({ primitives: unique.length, typedArrayBytes });
    this._captures.set(token, { starts: unique, bounds, alive, versions }); this._captureBytes += typedArrayBytes;
    this._stats.capturedPrimitives += unique.length;
    this._stats.capturePeakTypedArrayBytes = Math.max(this._stats.capturePeakTypedArrayBytes, this._captureBytes);
    return token;
  }
  discardChanges(token) {
    this._assertLive(); if (!this._captures.has(token)) throw new Error('invalid or consumed capture token');
    this._captures.delete(token); this._captureBytes -= token.typedArrayBytes;
  }
  commitChanges(token, { kind = 'update' } = {}) {
    this._assertLive(); const capture = this._captures.get(token);
    if (!capture) throw new Error('invalid or consumed capture token');
    if (!['update', 'delete', 'restore'].includes(kind)) throw new RangeError('invalid geometry change kind');
    const result = this._applyChanges(capture.starts, capture);
    this.discardChanges(token); return { ...result, kind };
  }
  /** Without a pre-edit capture, conservatively mark every affected block dirty. */
  notifyChanged(starts, { kind = 'update' } = {}) {
    if (!['update', 'delete', 'restore'].includes(kind)) throw new RangeError('invalid geometry change kind');
    return { ...this._applyChanges(this._validateStarts(starts), null), kind };
  }
  _applyChanges(starts, capture) {
    // Validate every new complete live bbox before mutating index metadata.
    const after = Array.from(starts, start => this._primitive(start));
    if (!starts.length) return { primitives: 0, dirtyBlocks: 0, ancestorMerges: 0, version: this.version };
    const touched = new Set(), expanded = new Set(), version = this._nextVersion();
    for (let i = 0; i < starts.length; i++) {
      const block = this._block(starts[i]); touched.add(block);
      const old = capture?.alive[i] ? capture.bounds.subarray(i * 4, i * 4 + 4) : null;
      if (!capture || capture.versions[i] !== this._blockVersions[block] || this._invalidatesExtrema(block, old, after[i])) this._dirty.add(block);
      if (this._expand(block, after[i])) expanded.add(block);
    }
    for (const block of touched) this._blockVersions[block] = version;
    this._stats.changedPrimitives += starts.length; this._stats.mutationBatches++;
    return { primitives: starts.length, dirtyBlocks: this._dirty.size, ancestorMerges: this._mergeAncestors(expanded), version };
  }

  maintain({ maxPrimitives = Infinity, budgetMs = Infinity, clock = () => performance.now() } = {}) {
    this._assertLive();
    if (!(maxPrimitives === Infinity || Number.isSafeInteger(maxPrimitives) && maxPrimitives >= 0) ||
        !(budgetMs === Infinity || Number.isFinite(budgetMs) && budgetMs >= 0) || typeof clock !== 'function') {
      throw new RangeError('invalid maintenance budget');
    }
    if (this._maintenanceRunning) return { reentrant: true, scannedPrimitives: 0, rescannedBlocks: 0, discardedBlocks: 0, pendingBlocks: this._dirty.size };
    this._maintenanceRunning = true; this._stats.maintenanceCalls++;
    // Iterate only as far as the original dirty count. Set iterators observe
    // newly appended entries, so this cap plus visited IDs prevents a callback
    // repeatedly re-dirtying a completed block from extending this batch.
    const initialDirtyBlocks = this._dirty.size, targets = this._dirty.values(), visited = new Set(), changed = new Set();
    const readClock = () => { const value = clock(); if (!Number.isFinite(value)) throw new RangeError('clock must return a finite timestamp'); return value; };
    let scannedPrimitives = 0, rescannedBlocks = 0, discardedBlocks = 0, blockedByPrimitiveBudget = false, merged = false, iteratedBlocks = 0;
    try {
      const started = readClock();
      while (iteratedBlocks < initialDirtyBlocks) {
        const next = targets.next(); if (next.done) break;
        const block = next.value; iteratedBlocks++;
        if (visited.has(block) || !this._dirty.has(block)) continue;
        visited.add(block);
        if (readClock() - started >= budgetMs) break;
        const start = block * this.blockSize * this.primitiveSize,
          end = Math.min(this.indexedUntil, start + this.blockSize * this.primitiveSize), count = (end - start) / this.primitiveSize;
        if (scannedPrimitives + count > maxPrimitives) { blockedByPrimitiveBudget = true; break; }
        const version = this._blockVersions[block]; let b = null;
        for (let v = start; v < end; v += this.primitiveSize) {
          const current = this._primitive(v); scannedPrimitives++;
          if (!current) continue;
          if (!b) b = current; else { b[0] = Math.min(b[0], current[0]); b[1] = Math.min(b[1], current[1]); b[2] = Math.max(b[2], current[2]); b[3] = Math.max(b[3], current[3]); }
        }
        // A callback/clock may have committed a newer edit while scanning.
        // Its immediate external expansion wins; stale tightening is discarded.
        readClock();
        if (this._blockVersions[block] !== version) { discardedBlocks++; continue; }
        const node = this.leafBase + block, at = node * 4;
        this._nonempty[node] = b ? 1 : 0; if (b) this._bounds.set(b, at); else this._bounds.fill(0, at, at + 4);
        this._dirty.delete(block); changed.add(block); rescannedBlocks++;
      }
      const ancestorMerges = this._mergeAncestors(changed);
      merged = true;
      const elapsedMs = readClock() - started;
      return { scannedPrimitives, rescannedBlocks, discardedBlocks, ancestorMerges, pendingBlocks: this._dirty.size,
        initialDirtyBlocks, iteratedBlocks, blockedByPrimitiveBudget, elapsedMs, exact: this._dirty.size === 0 };
    } catch (error) {
      // Successfully tightened leaves must still reach their ancestors if a
      // later callback fails; otherwise a subsequent "exact" root stays stale.
      if (!merged) this._mergeAncestors(changed);
      throw error;
    } finally {
      // Preserve real scan work even if an injected clock/predicate throws.
      this._stats.rescanPrimitives += scannedPrimitives; this._stats.rescanBlocks += rescannedBlocks; this._stats.discardedRescans += discardedBlocks;
      this._stats.maintenanceIteratedBlocks += iteratedBlocks;
      this._maintenanceRunning = false;
    }
  }

  getBounds() {
    this._assertLive(); const at = 4;
    return { empty: !this._nonempty[1], minX: this._bounds[at], minY: this._bounds[at + 1],
      maxX: this._bounds[at + 2], maxY: this._bounds[at + 3], exact: this._dirty.size === 0,
      pendingBlocks: this._dirty.size, version: this.version };
  }
  getBlockVersion(block) {
    this._assertLive(); if (!Number.isSafeInteger(block) || block < 0 || block >= this.blockCount) throw new RangeError('invalid block');
    return this._blockVersions[block];
  }
  getStats() {
    const typedArrayBytes = this.destroyed ? 0 : this._bounds.byteLength + this._nonempty.byteLength + this._blockVersions.byteLength +
      this._ancestorMarks.byteLength + this._ancestorWork.byteLength + this._levelCounts.byteLength;
    return { ...this._stats, blockSize: this.blockSize, blocks: this.blockCount, vertexCapacity: this.vertexCapacity,
      primitives: this.indexedUntil / this.primitiveSize, pendingBlocks: this._dirty.size, exact: this._dirty.size === 0,
      version: this.version, typedArrayBytes, borrowedPositionsBytes: this.destroyed ? 0 : this.positions.byteLength,
      captureTypedArrayBytes: this._captureBytes, openCaptures: this._captures.size,
      totalOwnedTypedArrayBytes: typedArrayBytes + this._captureBytes, objectHeapBytes: null, destroyed: this.destroyed };
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true; this.positions = null; this.isRemoved = null; this._captures.clear(); this._captureBytes = 0; this._dirty.clear();
    this._bounds = this._nonempty = this._blockVersions = this._ancestorMarks = this._ancestorWork = this._levelCounts = null;
  }
}
