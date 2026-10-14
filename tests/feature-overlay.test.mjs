import test from 'node:test';
import assert from 'node:assert/strict';
import { FeatureOverlay } from '../public/js/feature-overlay.js';

test('a move is recorded once and resolves to the newest position', () => {
  const overlay = new FeatureOverlay();
  assert.equal(overlay.setPosition(4, 10, 20), null, 'the first move has no previous position');
  assert.deepEqual(overlay.resolve(4), { moved: { x: 10, y: 20 } });
  const previous = overlay.setPosition(4, 30, 40);
  assert.deepEqual(previous, { x: 10, y: 20 });
  assert.deepEqual(overlay.resolve(4), { moved: { x: 30, y: 40 } });
  assert.equal(overlay.movedCount, 1, 'the overlay keys by feature, not by update');
  assert.equal(overlay.stats.positionUpdates, 2);
  assert.equal(overlay.stats.moves, 1);
});

test('removal tombstones a feature and drops any pending move', () => {
  const overlay = new FeatureOverlay();
  overlay.setPosition(1, 5, 5);
  assert.equal(overlay.remove(1), true);
  assert.equal(overlay.remove(1), false, 'removing twice is a no-op');
  assert.deepEqual(overlay.resolve(1), { removed: true });
  assert.equal(overlay.isMoved(1), false);
  assert.equal(overlay.stats.removalsOfMoved, 1);
  // A removed feature refuses new positions until it is restored.
  assert.equal(overlay.setPosition(1, 9, 9), null);
  assert.equal(overlay.stats.rejects, 1);
  assert.equal(overlay.restore(1), true);
  assert.equal(overlay.resolve(1), null);
  assert.equal(overlay.setPosition(1, 9, 9), null, 'the first move after a restore has no previous position');
  assert.deepEqual(overlay.resolve(1), { moved: { x: 9, y: 9 } });
});

test('unknown features resolve to null so callers can keep the base index', () => {
  const overlay = new FeatureOverlay();
  assert.equal(overlay.resolve(999), null);
  assert.equal(overlay.isMoved(999), false);
  assert.equal(overlay.isRemoved(999), false);
});

test('movedWithin reports only features whose new position is in the box', () => {
  const overlay = new FeatureOverlay();
  overlay.setPosition(1, 0, 0);
  overlay.setPosition(2, 50, 50);
  overlay.setPosition(3, 200, 200);
  overlay.remove(4);
  overlay.setPosition(5, 60, 40);
  const inside = overlay.movedWithin({ minX: 40, minY: 40, maxX: 100, maxY: 100 }).sort();
  assert.deepEqual(inside, [2, 5]);
  assert.deepEqual(overlay.removedIds(), [4]);
  assert.deepEqual(overlay.movedIds().sort(), [1, 2, 3, 5]);
});

test('capacity limits fail loudly instead of silently dropping edits', () => {
  const overlay = new FeatureOverlay({ movedCapacity: 2, removedCapacity: 1 });
  overlay.setPosition(1, 0, 0);
  overlay.setPosition(2, 0, 0);
  assert.throws(() => overlay.setPosition(3, 0, 0), /capacity/);
  assert.equal(overlay.setPosition(1, 7, 7).x, 0, 'existing features stay editable at capacity');
  overlay.remove(10);
  assert.throws(() => overlay.remove(11), /capacity/);
  overlay.restore(10);
  assert.equal(overlay.removedCount, 0);
});

test('clearPosition reverts a feature to its stored geometry', () => {
  const overlay = new FeatureOverlay();
  overlay.setPosition(7, 1, 2);
  assert.equal(overlay.clearPosition(7), true);
  assert.equal(overlay.clearPosition(7), false);
  assert.equal(overlay.resolve(7), null);
  assert.equal(overlay.stats.reverts, 1);
});

test('invalid coordinates are rejected atomically', () => {
  const overlay = new FeatureOverlay();
  assert.throws(() => overlay.setPosition(1, NaN, 0), /finite/);
  assert.throws(() => overlay.setPosition(1, 0, Infinity), /finite/);
  assert.equal(overlay.size, 0);
});
