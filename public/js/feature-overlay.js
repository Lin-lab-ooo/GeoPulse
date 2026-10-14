/**
 * Patch layer for live feature edits on top of append-only storage.
 *
 * GPU pages and the fine spatial tree are append-only by design: paging keeps
 * the first paint early, and rebuilding the tree after every edit would cost
 * more than the edit. So the renderer keeps two structures:
 *
 *   stable base index  - the append-only tree, never rewritten after an edit
 *   change index       - this overlay: moved and removed feature ids
 *
 * A moved feature keeps its vertex slot (so its bytes can be rewritten with one
 * 8-byte upload) but its old position stays in the tree. That is conservative
 * in the safe direction: the tree may offer it when the *old* position is
 * visible, and the overlay forces it back in whenever the new position may be
 * visible. A removed feature is tombstoned instead of compacted.
 *
 * Nothing here knows about GL; it is pure bookkeeping so the semantics can be
 * tested directly.
 */

export class FeatureOverlay {
  constructor({ movedCapacity = Infinity, removedCapacity = Infinity } = {}) {
    if (!(movedCapacity > 0)) throw new RangeError('movedCapacity must be positive');
    if (!(removedCapacity > 0)) throw new RangeError('removedCapacity must be positive');
    this.movedCapacity = movedCapacity;
    this.removedCapacity = removedCapacity;
    this.moved = new Map();
    this.removed = new Set();
    this.stats = { positionUpdates: 0, moves: 0, removals: 0, removalsOfMoved: 0, restorations: 0, reverts: 0, rejects: 0 };
  }

  get movedCount() { return this.moved.size; }
  get removedCount() { return this.removed.size; }
  get size() { return this.moved.size + this.removed.size; }

  isRemoved(id) { return this.removed.has(id); }
  isMoved(id) { return this.moved.has(id); }

  /**
   * Records a new position. Returns the previous one when the feature had
   * already moved (the caller uses it to decide whether the old slot must be
   * rewritten), or null when this is the first move.
   */
  setPosition(id, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('position must be finite');
    if (this.removed.has(id)) { this.stats.rejects++; return null; }
    const previous = this.moved.get(id) ?? null;
    if (!previous && this.moved.size >= this.movedCapacity) throw new RangeError('moved feature capacity reached');
    this.moved.set(id, { x, y });
    this.stats.positionUpdates++;
    if (!previous) this.stats.moves++;
    return previous;
  }

  /** Reverts a feature to its stored position and forgets the move. */
  clearPosition(id) {
    const existed = this.moved.delete(id);
    if (existed) this.stats.reverts++;
    return existed;
  }

  remove(id) {
    if (this.removed.has(id)) return false;
    if (this.removed.size >= this.removedCapacity) throw new RangeError('removed feature capacity reached');
    if (this.moved.delete(id)) this.stats.removalsOfMoved++;
    this.removed.add(id);
    this.stats.removals++;
    return true;
  }

  restore(id, { position = null } = {}) {
    if (position && (!Number.isFinite(position.x) || !Number.isFinite(position.y))) throw new RangeError('position must be finite');
    if (!this.removed.has(id)) return false;
    if (position && !this.moved.has(id) && this.moved.size >= this.movedCapacity) throw new RangeError('moved feature capacity reached');
    this.removed.delete(id);
    if (position) this.moved.set(id, { x: position.x, y: position.y });
    this.stats.restorations++;
    return true;
  }

  /** {moved: {x,y}} | {removed: true} | null */
  resolve(id) {
    if (this.removed.has(id)) return { removed: true };
    const moved = this.moved.get(id);
    return moved ? { moved: { ...moved } } : null;
  }

  movedIds() { return [...this.moved.keys()]; }
  removedIds() { return [...this.removed]; }

  /** Ids whose new position may intersect the box, for widening a candidate set. */
  movedWithin({ minX, minY, maxX, maxY }) {
    const out = [];
    for (const [id, point] of this.moved) {
      if (point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY) out.push(id);
    }
    return out;
  }

  clear() {
    this.moved.clear();
    this.removed.clear();
    return this.snapshot();
  }

  snapshot() {
    return { moved: this.moved.size, removed: this.removed.size, ...this.stats };
  }
}
