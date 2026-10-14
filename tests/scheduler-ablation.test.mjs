/**
 * Scheduler ablation expectations.
 *
 * These assertions pin the *mechanism* the 1.8 loading report identified, so a
 * future edit cannot silently reintroduce the throughput loss. They run against
 * the calibrated controller simulation in tools/scheduler-ablation.mjs, not
 * against a browser: the browser protocol stays the acceptance test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveScheduler, SCHEDULER_TUNING_PRESETS, effectiveReferenceMs } from '../public/js/scheduler.js';
import {
  COST_MODEL, OBSERVED_1_8, irreducibleFrameMs,
  simulateLoadingRun, simulateFixedPipeline, runMatrix, summarizeMatrix
} from '../tools/scheduler-ablation.mjs';

const legacy = { ...SCHEDULER_TUNING_PRESETS.legacy, name: 'legacy' };
const rawish = { ...legacy, pressureReference: 'raw', referenceFloorMs: 3 };

test('the calibrated model reproduces both observed 1.8 regimes', () => {
  const fixed = simulateFixedPipeline();
  assert.equal(fixed.batches, OBSERVED_1_8.fixed.batches);
  // Modelled total within 5 % of the observed fixed-pipeline median.
  assert.ok(Math.abs(fixed.totalMs - OBSERVED_1_8.fixed.totalMs) / OBSERVED_1_8.fixed.totalMs < 0.05,
    `fixed model ${fixed.totalMs} vs observed ${OBSERVED_1_8.fixed.totalMs}`);
  const baseline = simulateLoadingRun({ ...rawish, batchFloor: 256 }, { referenceMs: 4.17 });
  // The adaptive pathology: thousands of small batches, ACK dominated.
  assert.ok(baseline.batches > 2800, `baseline batches ${baseline.batches}`);
  assert.ok(baseline.ackMs / baseline.totalMs > 0.85, 'ACK dominates the baseline run');
  assert.ok(Math.abs(baseline.totalMs - OBSERVED_1_8.adaptive.totalMs) / OBSERVED_1_8.adaptive.totalMs < 0.5,
    `adaptive model ${baseline.totalMs} vs observed ${OBSERVED_1_8.adaptive.totalMs}`);
});

test('irreducible per-frame cost is the idle tick plus one batch acknowledgement', () => {
  assert.equal(Number(irreducibleFrameMs().toFixed(2)), 9.21);
});

test('a reference below the irreducible cost can never recover', () => {
  const pinned = { ...legacy, pressureReference: 'clamped', referenceFloorMs: 8.4, batchFloor: 1024 };
  const above = { ...legacy, pressureReference: 'clamped', referenceFloorMs: 16.7, batchFloor: 1024 };
  const low = simulateLoadingRun(pinned, { referenceMs: 4.17 });
  const high = simulateLoadingRun(above, { referenceMs: 4.17 });
  assert.ok(low.batches >= 900, `clamped@8.4 stays at the floor: ${low.batches}`);
  assert.ok(high.batches < low.batches, `clamped@16.7 grows past the floor: ${high.batches} < ${low.batches}`);
  assert.ok(high.totalMs < low.totalMs);
});

test('the batch floor is the dominant throughput lever', () => {
  const base = { ...legacy, pressureReference: 'clamped', referenceFloorMs: 16.7 };
  const at = floor => simulateLoadingRun({ ...base, batchFloor: floor }, { referenceMs: 4.17 });
  const [f256, f1024, f2048] = [256, 1024, 2048].map(at);
  assert.ok(f256.totalMs > f1024.totalMs, `${f256.totalMs} > ${f1024.totalMs}`);
  assert.ok(f1024.totalMs > f2048.totalMs, `${f1024.totalMs} > ${f2048.totalMs}`);
  // A 2 048 floor is batch-size parity with the shipped fixed pipeline.
  assert.equal(f2048.batches, simulateFixedPipeline().batches);
  // Fewer batches also improves the interaction tail: no trade-off in this regime.
  assert.ok(f2048.p95InteractingMs < f256.p95InteractingMs);
});

test('the tuned preset at least halves the simulated loading time', () => {
  const baseline = simulateLoadingRun({ ...rawish, batchFloor: 256 }, { referenceMs: 4.17 });
  const tuned = simulateLoadingRun(SCHEDULER_TUNING_PRESETS.tuned, { referenceMs: 4.17 });
  assert.ok(tuned.totalMs < baseline.totalMs * 0.5,
    `tuned ${tuned.totalMs} vs baseline ${baseline.totalMs}`);
  assert.ok(tuned.batches < baseline.batches * 0.4);
  assert.equal(tuned.tuning.tuning, 'tuned');
});

test('tuning profile reaches the controller and is reported', () => {
  assert.equal(effectiveReferenceMs(4.17, SCHEDULER_TUNING_PRESETS.tuned), 16.7);
  assert.equal(effectiveReferenceMs(4.17, SCHEDULER_TUNING_PRESETS.legacy), 4.17);
  assert.equal(effectiveReferenceMs(33.3, SCHEDULER_TUNING_PRESETS.tuned), 33.3);
  const s = new AdaptiveScheduler('adaptive', { referenceMs: 4.17, tuning: SCHEDULER_TUNING_PRESETS.tuned });
  const described = s.describe();
  assert.equal(described.tuning, 'tuned');
  assert.equal(described.batchFloor, 1024);
  assert.equal(described.effectiveReferenceMs, 16.7);
  for (let i = 1; i <= 20; i++) s.update({ p95: 60, now: i * 500 });
  assert.equal(s.batchSize, 1024, 'tuned floor holds under heavy pressure');
  const back = s.setTuning(SCHEDULER_TUNING_PRESETS.legacy);
  assert.equal(back.tuning, 'legacy');
});

test('the full three-axis matrix stays self-consistent', () => {
  const rows = runMatrix();
  assert.equal(rows.length, 36);
  const summary = summarizeMatrix(rows);
  assert.ok(summary.baselineRow && summary.bestRow && summary.worstRow);
  assert.ok(summary.bestRow.totalMs < summary.worstRow.totalMs);
  const batchFloorAxis = summary.byAxis.batchFloor;
  const median = level => batchFloorAxis.find(row => row.level === level).medianTotalMs;
  assert.ok(median(256) > median(1024) && median(1024) > median(2048));
  for (const row of rows) {
    assert.ok(row.totalMs > 0 && Number.isFinite(row.p95InteractingMs));
    assert.ok(row.batches > 0);
  }
});
