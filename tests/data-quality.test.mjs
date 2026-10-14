import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetector, generateRecords } from '../public/js/data.js';

const SEED = 20261009;

// Detection receives only observations. Labels are consumed afterwards by this evaluator.
function evaluateSimulation(count, seed = SEED) {
  const detectors = { fixed: createDetector({ mode: 'fixed' }), adaptive: createDetector() };
  const results = Object.fromEntries(Object.keys(detectors).map(mode => [mode, {
    tp: 0, fp: 0, fn: 0, tn: 0, criticalTruth: 0, criticalDetected: 0,
    warmupObservations: 0, allRegionsWarmAt: null,
  }]));
  let index = 0;
  for (const record of generateRecords({ count, seed })) {
    index += 1;
    const observation = Object.freeze({ value: record.value, region: record.region });
    for (const [mode, detector] of Object.entries(detectors)) {
      const prediction = detector.observe(observation);
      const stats = results[mode];
      if (!prediction.trained) stats.warmupObservations += 1;
      if (stats.allRegionsWarmAt === null && detector.snapshot().warmedRegions === 8) stats.allRegionsWarmAt = index;
      const predictedPositive = prediction.status !== 'normal';
      const labelledPositive = record.groundTruth !== 'normal';
      stats[labelledPositive ? predictedPositive ? 'tp' : 'fn' : predictedPositive ? 'fp' : 'tn'] += 1;
      if (record.groundTruth === 'critical') {
        stats.criticalTruth += 1;
        if (predictedPositive) stats.criticalDetected += 1;
      }
    }
  }
  for (const stats of Object.values(results)) {
    stats.precision = stats.tp / (stats.tp + stats.fp);
    stats.recall = stats.tp / (stats.tp + stats.fn);
    stats.falsePositiveRate = stats.fp / (stats.fp + stats.tn);
    stats.criticalRecall = stats.criticalDetected / stats.criticalTruth;
  }
  return results;
}

for (const count of [10000, 100000]) {
  test(`fair labelled simulation: ${count} records, seed ${SEED}`, context => {
    const result = evaluateSimulation(count);
    context.diagnostic(JSON.stringify({ count, seed: SEED, detectionAblation: result }));
    for (const stats of Object.values(result)) {
      assert.equal(stats.tp + stats.fp + stats.fn + stats.tn, count);
      assert.ok(stats.criticalTruth > 0);
      assert.ok(stats.criticalRecall >= 0.99, 'strong simulated faults should usually be detected');
    }
    // Acceptance floors describe useful outcomes, rather than exact implementation counters.
    assert.ok(result.adaptive.precision >= 0.90, 'self-learning alerts should mostly match injected faults');
    assert.ok(result.adaptive.recall >= 0.95, 'self-learning should recover most injected faults');
    assert.ok(result.adaptive.falsePositiveRate <= 0.003, 'normal simulated records should rarely trigger an alert');
    assert.ok(result.adaptive.recall >= result.fixed.recall + 0.25, 'regional learning should recover mild faults missed by a global threshold');
    assert.ok(result.adaptive.allRegionsWarmAt < 512, 'the generated clean prefix should warm all regions before injected faults');
  });
}

test('different normal regional means do not create systematic false alerts after training', () => {
  const adaptive = createDetector();
  const fixed = createDetector({ mode: 'fixed' });
  const regions = [{ region: 'cool-unit', mean: 20 }, { region: 'hot-unit', mean: 80 }];
  const alerts = { adaptive: 0, fixed: 0, evaluated: 0 };
  for (let i = 0; i < 160; i += 1) {
    for (const region of regions) {
      const observation = { region: region.region, value: region.mean + 2 * Math.sin(i * 1.7) };
      const learned = adaptive.observe(observation);
      const constant = fixed.observe(observation);
      if (i >= 40) {
        alerts.evaluated += 1;
        if (learned.status !== 'normal') alerts.adaptive += 1;
        if (constant.status !== 'normal') alerts.fixed += 1;
      }
    }
  }
  assert.ok(alerts.adaptive / alerts.evaluated <= 0.01, 'region-specific normal behaviour should remain normal');
  assert.ok(alerts.fixed / alerts.evaluated >= 0.40, 'a global threshold should expose its mismatch with the hot normal region');
});

test('training suppresses premature claims and a strong later fault is reported', () => {
  const detector = createDetector({ warmup: 24 });
  for (let i = 0; i < 24; i += 1) {
    const result = detector.observe({ region: 'new-site', value: 50 + Math.sin(i) });
    assert.equal(result.status, 'normal');
    assert.equal(result.trained, false);
  }
  const fault = detector.observe({ region: 'new-site', value: 90 });
  assert.equal(fault.trained, true);
  assert.equal(fault.status, 'critical');
  assert.ok(fault.score > 5);
});

test('strong faults across low and high baseline regions retain high recall', () => {
  const detector = createDetector();
  const regions = [{ region: 'cold', mean: 15 }, { region: 'warm', mean: 55 }, { region: 'hot', mean: 105 }];
  for (let i = 0; i < 96; i += 1) for (const region of regions) detector.observe({ region: region.region, value: region.mean + 3 * Math.sin(i * 0.9) });
  let detected = 0;
  let total = 0;
  for (let i = 0; i < 60; i += 1) {
    for (const region of regions) {
      const result = detector.observe({ region: region.region, value: region.mean + 30 + 2 * Math.cos(i) });
      total += 1;
      if (result.status === 'critical') detected += 1;
    }
  }
  assert.ok(detected / total >= 0.99);
});

test('repeated extreme faults do not redefine the learned normal baseline', () => {
  const detector = createDetector();
  for (let i = 0; i < 128; i += 1) detector.observe({ region: 'protected', value: 50 + 2 * Math.sin(i) });
  for (let i = 0; i < 100; i += 1) {
    const extreme = detector.observe({ region: 'protected', value: 1e12 + i });
    assert.equal(extreme.status, 'critical');
    assert.ok(Number.isFinite(extreme.mean) && Number.isFinite(extreme.deviation) && Number.isFinite(extreme.score));
  }
  const returnedToNormal = detector.observe({ region: 'protected', value: 51 });
  assert.equal(returnedToNormal.status, 'normal');
  assert.ok(returnedToNormal.mean >= 48 && returnedToNormal.mean <= 52);
  assert.ok(returnedToNormal.deviation < 5, 'repeated rejected extremes must not inflate normal variability');
});
