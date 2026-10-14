// Incremental, page-local spatial index. A reference is the start vertex of one
// complete point, line segment, or triangle; geometry is never split into cells.
// Querying a partially intersecting leaf deliberately permits false positives.
const BLOCK_PRIMITIVES = 1024;

export class PrimitiveSpatialIndex {
  constructor({ primitiveSize = 1, leafSize = 256, minExtent = 8, maxDepth = 16, maxSplitEntries = Infinity } = {}) {
    if (![1, 2, 3].includes(primitiveSize)) throw new RangeError('primitiveSize must be 1, 2, or 3');
    if (!Number.isSafeInteger(leafSize) || leafSize < 1) throw new RangeError('leafSize must be a positive integer');
    if (!Number.isFinite(minExtent) || minExtent < 0) throw new RangeError('minExtent must be finite and nonnegative');
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) throw new RangeError('maxDepth must be a nonnegative integer');
    if (maxSplitEntries !== Infinity && (!Number.isSafeInteger(maxSplitEntries) || maxSplitEntries < 1)) throw new RangeError('maxSplitEntries must be a positive integer or Infinity');
    this.maxSplitEntries = maxSplitEntries;
    this.splitLimitedLeaves = 0;
    this.primitiveSize = primitiveSize;
    this.leafSize = leafSize;
    this.minExtent = minExtent;
    this.maxDepth = maxDepth;
    this._root = null;
    // The original Float32 coordinates/bounds are copied into lazily allocated
    // blocks. A sparse high start offset allocates one block, not the gap.
    this._fields = primitiveSize === 1 ? 2 : 4;
    this._blocks = new Map();
    this._primitiveCount = 0;
    this._typedArrayBytes = 0;
    this._nodes = 0;
    this._leaves = 0;
  }

  // start/end are vertex offsets, with end exclusive. Ranges may arrive in any
  // order but cannot overlap. Coordinates are copied as bounds, not retained.
  // Validate the entire batch before changing the index.
  append(positions, start, end) {
    if (!(positions instanceof Float32Array) || positions.length % 2 !== 0) {
      throw new TypeError('positions must be a Float32Array of xy pairs');
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end < start || end > positions.length / 2
      || start % this.primitiveSize !== 0 || end % this.primitiveSize !== 0) {
      throw new RangeError('start/end must delimit complete primitives within positions');
    }
    const entries = [];
    for (let vertex = start; vertex < end; vertex += this.primitiveSize) {
      if (this._has(vertex)) throw new RangeError('a primitive cannot be appended twice');
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let offset = 0; offset < this.primitiveSize; offset++) {
        const x = positions[(vertex + offset) * 2];
        const y = positions[(vertex + offset) * 2 + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('coordinates must be finite');
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
      entries.push({ start: vertex, minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 });
    }
    for (const entry of entries) {
      this._store(entry);
      if (!this._root) {
        this._root = makeLeaf(0);
        this._nodes = 1;
        this._leaves = 1;
      }
      let node = this._root;
      while (true) {
        expand(node.bounds, entry);
        node.count++;
        if (node.entries) {
          addLeafEntry(node, entry);
          this._split(node);
          break;
        }
        node = entry[node.axis] < node.split ? node.left : node.right;
      }
      this._primitiveCount++;
    }
    return entries.length;
  }

  _has(start) {
    const address = start / this.primitiveSize;
    const block = this._blocks.get(Math.floor(address / BLOCK_PRIMITIVES));
    return block ? block.present[address % BLOCK_PRIMITIVES] === 1 : false;
  }

  _store(entry) {
    const address = entry.start / this.primitiveSize;
    const blockID = Math.floor(address / BLOCK_PRIMITIVES);
    let block = this._blocks.get(blockID);
    if (!block) {
      block = {
        geometry: new Float32Array(BLOCK_PRIMITIVES * this._fields),
        present: new Uint8Array(BLOCK_PRIMITIVES)
      };
      this._blocks.set(blockID, block);
      this._typedArrayBytes += block.geometry.byteLength + block.present.byteLength;
    }
    const local = address % BLOCK_PRIMITIVES;
    const offset = local * this._fields;
    block.geometry[offset] = entry.minX;
    block.geometry[offset + 1] = entry.minY;
    if (this._fields === 4) {
      block.geometry[offset + 2] = entry.maxX;
      block.geometry[offset + 3] = entry.maxY;
    }
    block.present[local] = 1;
  }

  _center(start, axis) {
    const address = start / this.primitiveSize;
    const block = this._blocks.get(Math.floor(address / BLOCK_PRIMITIVES));
    const offset = (address % BLOCK_PRIMITIVES) * this._fields + (axis === 'cx' ? 0 : 1);
    return this._fields === 2 ? block.geometry[offset] : (block.geometry[offset] + block.geometry[offset + 2]) / 2;
  }

  _restoreBounds(start) {
    const address = start / this.primitiveSize;
    const block = this._blocks.get(Math.floor(address / BLOCK_PRIMITIVES));
    const offset = (address % BLOCK_PRIMITIVES) * this._fields;
    const minX = block.geometry[offset], minY = block.geometry[offset + 1];
    const maxX = this._fields === 2 ? minX : block.geometry[offset + 2];
    const maxY = this._fields === 2 ? minY : block.geometry[offset + 3];
    // A transient split record; no per-primitive object is retained in the tree.
    return { start, minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }

  _split(node) {
    if (node.entries.length <= this.leafSize || node.depth >= this.maxDepth) return;
    const width = node.maxCX - node.minCX;
    const height = node.maxCY - node.minCY;
    // These extrema are maintained on append, so a degenerate leaf does not
    // repeatedly scan/sort its growing list just to discover identical centers.
    if (Math.max(width, height) <= this.minExtent) return;
    // A formerly degenerate leaf can contain many coincident centers before
    // one distant append makes it splittable. A progressive caller may cap
    // that one non-preemptible sort. Keeping the leaf permits false positives
    // but preserves every full primitive and exact bounds. Default is uncapped.
    if (node.entries.length > this.maxSplitEntries) {
      if (!node.splitLimited) { node.splitLimited = true; this.splitLimitedLeaves++; }
      return;
    }
    const axis = width >= height ? 'cx' : 'cy';
    // Restore each primitive once. Sorting and gap/tie checks then reuse
    // centers instead of doing repeated block Map lookups in comparisons.
    // These records are transient, as in redistribution; leaves still retain
    // only numeric start offsets and exact compact bounds.
    const entries = node.entries.map(start => this._restoreBounds(start));
    entries.sort((a, b) => a[axis] - b[axis] || a.start - b.start);
    const median = Math.floor(entries.length / 2);
    let boundary = median;
    let largestGap = 0, gapBoundary = 0;
    for (let position = 1; position < entries.length; position++) {
      const gap = entries[position][axis] - entries[position - 1][axis];
      if (gap > largestGap) {
        largestGap = gap;
        gapBoundary = position;
      }
    }
    // A median can strand one point from a distant cluster among the other
    // cluster's points. Separate a significant empty interval first; otherwise
    // retain balanced median subdivision for ordinary continuous distributions.
    if (largestGap > (axis === 'cx' ? width : height) * 0.25) boundary = gapBoundary;
    // Keep equal centers together. Choose the nearest distinct-center boundary
    // to the median, rather than placing identical centers in both children.
    if (entries[boundary - 1][axis] === entries[boundary][axis]) {
      let lower = boundary, upper = boundary;
      while (lower > 0 && entries[lower - 1][axis] === entries[lower][axis]) lower--;
      while (upper < entries.length && entries[upper - 1][axis] === entries[upper][axis]) upper++;
      if (lower === 0) boundary = upper;
      else if (upper === entries.length) boundary = lower;
      else boundary = median - lower < upper - median ? lower : upper;
    }
    if (boundary === 0 || boundary === entries.length) return;
    const left = makeLeaf(node.depth + 1);
    const right = makeLeaf(node.depth + 1);
    for (let index = 0; index < entries.length; index++) {
      const child = index < boundary ? left : right;
      const entry = entries[index];
      expand(child.bounds, entry);
      child.count++;
      addLeafEntry(child, entry);
    }
    node.axis = axis;
    // Use the first right-center itself. `< split` then routes all original
    // centers consistently even at floating-point extremes.
    node.split = entries[boundary][axis];
    node.left = left;
    node.right = right;
    node.entries = null;
    this._nodes += 2;
    this._leaves++;
    this._split(left);
    this._split(right);
  }

  // classifyBounds: -1 outside, 0 intersecting, 1 fully contained. For a
  // contained subtree its descendants need no further geometric classification.
  // visit(start) is called exactly once per selected primitive. Order is spatial;
  // callers needing stable transparency order must sort the selected starts.
  query(classifyBounds, visit) {
    if (typeof classifyBounds !== 'function' || typeof visit !== 'function') {
      throw new TypeError('query requires classifyBounds and visit callbacks');
    }
    const stats = { nodesTested: 0, leavesVisited: 0, primitivesSelected: 0 };
    if (!this._root) return stats;
    const stack = [{ node: this._root, contained: false }];
    while (stack.length) {
      const { node, contained } = stack.pop();
      let classification = 1;
      if (!contained) {
        stats.nodesTested++;
        classification = classifyBounds(node.bounds);
        if (![-1, 0, 1].includes(classification)) throw new RangeError('classifyBounds must return -1, 0, or 1');
      }
      if (classification === -1) continue;
      if (node.entries) {
        stats.leavesVisited++;
        for (const start of node.entries) {
          visit(start);
          stats.primitivesSelected++;
        }
      } else {
        const childContained = classification === 1;
        stack.push({ node: node.right, contained: childContained });
        stack.push({ node: node.left, contained: childContained });
      }
    }
    return stats;
  }

  // Count the same conservative candidates as query without enumerating them.
  // Fully contained nodes contribute their maintained count immediately. Here
  // leavesVisited measures leaf entry lists inspected, excluding descendants
  // of such shortcuts; it can therefore be smaller than query's leaf visits.
  count(classifyBounds) {
    if (typeof classifyBounds !== 'function') throw new TypeError('count requires a classifyBounds callback');
    const stats = { nodesTested: 0, leavesVisited: 0, primitivesSelected: 0 };
    if (!this._root) return stats;
    const stack = [this._root];
    while (stack.length) {
      const node = stack.pop();
      stats.nodesTested++;
      const classification = classifyBounds(node.bounds);
      if (![-1, 0, 1].includes(classification)) throw new RangeError('classifyBounds must return -1, 0, or 1');
      if (classification === -1) continue;
      if (classification === 1) {
        stats.primitivesSelected += node.count;
        continue;
      }
      if (node.entries) {
        stats.leavesVisited++;
        stats.primitivesSelected += node.entries.length;
      } else {
        stack.push(node.right, node.left);
      }
    }
    return stats;
  }

  getStats() {
    const primitives = this._primitiveCount;
    return {
      nodes: this._nodes,
      leaves: this._leaves,
      primitives,
      // Exact owned typed-array payload, including partially used blocks.
      typedArrayBytes: this._typedArrayBytes,
      // Planning estimate adds JS numeric-array slots, nodes, and block/Map
      // metadata. It is not a heap measurement; engine/layout/capacity vary.
      estimatedBytes: this._typedArrayBytes + primitives * 8 + this._nodes * 192 + this._blocks.size * 80
    };
  }
}

function makeLeaf(depth) {
  return {
    depth, count: 0, entries: [], left: null, right: null, axis: null, split: 0,
    bounds: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    minCX: Infinity, minCY: Infinity, maxCX: -Infinity, maxCY: -Infinity
  };
}

function expand(bounds, entry) {
  bounds.minX = Math.min(bounds.minX, entry.minX);
  bounds.minY = Math.min(bounds.minY, entry.minY);
  bounds.maxX = Math.max(bounds.maxX, entry.maxX);
  bounds.maxY = Math.max(bounds.maxY, entry.maxY);
}

function addLeafEntry(node, entry) {
  node.entries.push(entry.start);
  node.minCX = Math.min(node.minCX, entry.cx);
  node.minCY = Math.min(node.minCY, entry.cy);
  node.maxCX = Math.max(node.maxCX, entry.cx);
  node.maxCY = Math.max(node.maxCY, entry.cy);
}
