/**
 * Bounded, coalescing update queue for live feature streams.
 *
 * The question left open at the end of the 1.9 conversation was what to do when
 * updates arrive faster than the renderer drains them (lambda > mu). Dropping
 * everything loses alarms; queueing everything grows without bound and delays
 * the newest state. This queue states the policy explicitly:
 *
 *   - state updates are keyed by feature id and are latest-wins: a newer colour
 *     for the same device replaces the pending one instead of queueing behind it
 *   - critical transitions are events, not state: they are never coalesced away
 *     by a later normal update, and they survive at the highest priority
 *   - above the high-water mark the queue degrades: only critical events and
 *     still-fresh ordinary state are admitted, and the drop reason is counted
 *     rather than silently discarded
 *
 * The caller decides what "critical" means; the queue only guarantees the
 * ordering, the bound, and the accounting.
 */

const PRIORITY_CRITICAL = 2;
const PRIORITY_NORMAL = 0;

export class CoalescingUpdateQueue {
  constructor({ capacity = 4096, criticalCapacity = null, highWater = 0.75, hysteresis = 0.1 } = {}) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
    const critical = criticalCapacity ?? Math.max(1, Math.min(capacity, 512));
    if (!Number.isSafeInteger(critical) || critical < 1 || critical > capacity) {
      throw new RangeError('criticalCapacity must be within [1, capacity]');
    }
    if (!Number.isFinite(highWater) || highWater <= 0 || highWater > 1) throw new RangeError('highWater must be in (0,1]');
    if (!Number.isFinite(hysteresis) || hysteresis < 0 || hysteresis >= highWater) throw new RangeError('hysteresis must be in [0, highWater)');
    this.capacity = capacity;
    this.criticalCapacity = critical;
    this.highWater = highWater;
    this.hysteresis = hysteresis;
    this.pending = new Map();
    this.events = [];
    this.degraded = false;
    this.stats = {
      offered: 0, accepted: 0, coalesced: 0, dropped: 0, coalescedDrops: 0, criticalAdmitted: 0, eventsAdmitted: 0,
      drained: 0, maxBacklog: 0, degradedEpisodes: 0
    };
  }

  get backlog() { return this.pending.size + this.events.length; }

  /**
   * update: {id, color, priority?, critical?, at?}
   * Returns a small record describing what happened to this update.
   */
  offer(update) {
    if (!update || !Number.isInteger(update.id) || update.id < 0) throw new TypeError('update.id must be a non-negative integer');
    this.stats.offered++;
    const critical = Boolean(update.critical) || update.priority === PRIORITY_CRITICAL;
    const at = update.at ?? null;

    if (critical) {
      if (this.events.length >= this.criticalCapacity) {
        // Critical events are the last thing to go, but a bound is a bound.
        this.events.shift();
        this.stats.dropped++;
        this.stats.coalescedDrops++;
      }
      this.events.push({ id: update.id, color: update.color, priority: PRIORITY_CRITICAL, critical: true, at });
      this.stats.accepted++;
      this.stats.criticalAdmitted++;
      this.stats.eventsAdmitted++;
      this._refreshMode();
      return { id: update.id, outcome: 'event', backlog: this.backlog, degraded: this.degraded };
    }

    if (this.degraded) {
      const existing = this.pending.get(update.id);
      // In degraded mode an ordinary update is only worth keeping if it carries
      // state the feature does not already have queued, or replaces queued state.
      if (existing && existing.at !== null && at !== null && existing.at >= at) {
        this.stats.dropped++;
        return { id: update.id, outcome: 'stale-drop', backlog: this.backlog, degraded: true };
      }
      if (!existing && this.pending.size >= Math.floor(this.capacity * this.highWater)) {
        this.stats.dropped++;
        return { id: update.id, outcome: 'capacity-drop', backlog: this.backlog, degraded: true };
      }
    }

    const existing = this.pending.get(update.id);
    if (existing) this.stats.coalesced++;
    else if (this.pending.size >= this.capacity) {
      this.stats.dropped++;
      return { id: update.id, outcome: 'capacity-drop', backlog: this.backlog, degraded: this.degraded };
    }
    this.pending.set(update.id, { id: update.id, color: update.color, at, priority: PRIORITY_NORMAL });
    this.stats.accepted++;
    this._refreshMode();
    return { id: update.id, outcome: existing ? 'coalesced' : 'queued', backlog: this.backlog, degraded: this.degraded };
  }

  /** Critical events first, then the newest ordinary state, up to `limit`. */
  drain(limit = Infinity) {
    const out = [];
    while (this.events.length && out.length < limit) out.push(this.events.shift());
    if (out.length < limit && this.pending.size) {
      const entries = [...this.pending.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
      for (const entry of entries) {
        if (out.length >= limit) break;
        this.pending.delete(entry.id);
        out.push(entry);
      }
    }
    this.stats.drained += out.length;
    this._refreshMode();
    return out;
  }

  clear() {
    this.pending.clear();
    this.events.length = 0;
    this._refreshMode();
    return this.snapshot();
  }

  _refreshMode() {
    const wasDegraded = this.degraded;
    const ratio = this.backlog / this.capacity;
    if (!this.degraded && ratio >= this.highWater) this.degraded = true;
    else if (this.degraded && ratio <= this.highWater - this.hysteresis) this.degraded = false;
    if (!wasDegraded && this.degraded) this.stats.degradedEpisodes++;
    this.stats.maxBacklog = Math.max(this.stats.maxBacklog, this.backlog);
  }

  snapshot() {
    return {
      backlog: this.backlog, pending: this.pending.size, events: this.events.length,
      degraded: this.degraded, capacity: this.capacity, highWater: this.highWater,
      ...this.stats
    };
  }
}
