import test from 'node:test';
import assert from 'node:assert/strict';
import { CoalescingUpdateQueue } from '../public/js/update-queue.js';

test('state updates coalesce per feature instead of queueing behind each other', () => {
  const queue = new CoalescingUpdateQueue({ capacity: 100 });
  for (let i = 0; i < 50; i++) queue.offer({ id: 7, color: [i, 0, 0, 255], at: i });
  queue.offer({ id: 8, color: [0, 1, 0, 255], at: 1 });
  assert.equal(queue.backlog, 2);
  assert.equal(queue.stats.coalesced, 49);
  const drained = queue.drain(10);
  // Newest ordinary state first.
  assert.equal(drained.length, 2);
  assert.equal(drained[0].id, 7);
  assert.deepEqual(drained[0].color, [49, 0, 0, 255]);
  assert.equal(queue.backlog, 0);
});

test('critical events are never coalesced away and drain first', () => {
  const queue = new CoalescingUpdateQueue({ capacity: 100 });
  queue.offer({ id: 1, color: [1, 1, 1, 255], at: 1 });
  queue.offer({ id: 2, color: [9, 0, 0, 255], at: 2, critical: true });
  queue.offer({ id: 3, color: [0, 0, 9, 255], at: 3 });
  queue.offer({ id: 2, color: [0, 9, 0, 255], at: 4 });
  // The ordinary update for the same id cannot displace the critical event,
  // and the later critical event for id 2 is preserved as its own event.
  queue.offer({ id: 2, color: [0, 0, 9, 255], at: 5, critical: true });
  const drained = queue.drain(10);
  assert.equal(drained.filter(entry => entry.critical).length, 2);
  assert.ok(drained[0].critical && drained[1].critical, 'critical events come first');
  assert.equal(queue.stats.criticalAdmitted, 2);
  assert.equal(queue.stats.eventsAdmitted, 2);
});

test('the backlog is bounded and drops are counted with a reason', () => {
  const queue = new CoalescingUpdateQueue({ capacity: 4, criticalCapacity: 2, highWater: 1 });
  const outcomes = [];
  for (let i = 0; i < 10; i++) outcomes.push(queue.offer({ id: 100 + i, color: [i, 0, 0, 255], at: i }).outcome);
  assert.equal(queue.pending.size, 4);
  assert.equal(outcomes.filter(o => o === 'capacity-drop').length, 6);
  assert.equal(queue.stats.dropped, 6);
  assert.equal(queue.stats.accepted, 4);
  // Critical events have their own bound and evict the oldest event.
  for (let i = 0; i < 5; i++) queue.offer({ id: 900 + i, color: [0, 0, i, 255], at: i, critical: true });
  assert.equal(queue.events.length, 2);
  assert.ok(queue.stats.coalescedDrops >= 3);
});

test('lambda greater than mu degrades the queue instead of growing without bound', () => {
  const queue = new CoalescingUpdateQueue({ capacity: 100, highWater: 0.5, hysteresis: 0.1 });
  // Fill past the high-water mark.
  for (let i = 0; i < 60; i++) queue.offer({ id: i, color: [i, 0, 0, 255], at: i });
  assert.equal(queue.degraded, true, 'the queue reports degraded mode');
  assert.equal(queue.stats.degradedEpisodes, 1);
  // While degraded, an older ordinary update is dropped as stale...
  const stale = queue.offer({ id: 10, color: [0, 0, 0, 255], at: 0 });
  assert.equal(stale.outcome, 'stale-drop');
  // ...but a newer one still replaces queued state, and critical work is admitted.
  assert.equal(queue.offer({ id: 10, color: [1, 1, 1, 255], at: 999 }).outcome, 'coalesced');
  assert.equal(queue.offer({ id: 5, color: [9, 9, 9, 255], at: 1000, critical: true }).outcome, 'event');
  // Draining below highWater - hysteresis leaves degraded mode.
  queue.drain(45);
  assert.equal(queue.degraded, false);
  assert.equal(queue.stats.degradedEpisodes, 1, 'no flapping on the way down');
});

test('backlog never exceeds capacity under sustained overload', () => {
  const queue = new CoalescingUpdateQueue({ capacity: 32, highWater: 0.5 });
  for (let i = 0; i < 5000; i++) {
    queue.offer({ id: i % 900, color: [i % 256, 0, 0, 255], at: i });
    if (i % 7 === 0) queue.drain(3);
  }
  assert.ok(queue.backlog <= 32, `backlog ${queue.backlog}`);
  assert.ok(queue.stats.drained > 0);
  assert.ok(queue.stats.dropped > 0, 'drops are explicit, not silent');
});

test('invalid input is rejected before touching the queue', () => {
  const queue = new CoalescingUpdateQueue();
  assert.throws(() => queue.offer(null), /id/);
  assert.throws(() => queue.offer({ id: -1 }), /id/);
  assert.throws(() => queue.offer({ id: 1.5 }), /id/);
  assert.equal(queue.backlog, 0);
  assert.throws(() => new CoalescingUpdateQueue({ capacity: 0 }), /capacity/);
  assert.throws(() => new CoalescingUpdateQueue({ capacity: 4, criticalCapacity: 9 }), /criticalCapacity/);
  assert.throws(() => new CoalescingUpdateQueue({ highWater: 1.5 }), /highWater/);
});
