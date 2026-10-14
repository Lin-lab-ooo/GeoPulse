/**
 * Scheduler parameter ablation for the loading pipeline.
 *
 * The 1.8 SDK runs observed two regimes with the *same* data and pipeline:
 *   fixed   - 489 batches, 5.905 s cumulative ACK wait, 7.729 s total
 *   adaptive- 2 872 batches, 17.923 s cumulative ACK wait, 19.307 s total
 * and the report asked for a causal ablation of the pressure reference, the
 * batch floor, and the budget recovery rule before touching anything else.
 *
 * A real 30-run browser comparison needs a visible window and an AK, so this
 * tool isolates the *controller* instead: it drives the shipped AdaptiveScheduler
 * with a deterministic frame model whose per-batch cost is calibrated on those
 * two observed runs (see COST_MODEL below). It answers "which parameter causes
 * the throughput loss, and how much does each axis recover" without claiming to
 * replace the browser protocol - the same protocol remains the acceptance test.
 *
 * Run:  node tools/scheduler-ablation.mjs
 * Write: reports/scheduler-ablation-1.10.json
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { AdaptiveScheduler, SCHEDULER_TUNING_PRESETS, percentile } from '../public/js/scheduler.js';

// Calibrated on the 1.8 SDK five-round medians (1 000 000 features ->
// 1 200 000 vertices; fixed: 489 batches / 5.905 s ACK / 7.729 s total;
// adaptive: 2 872 batches / 17.923 s ACK / 19.307 s total).
//
// The ACK wait itself scales with batch size, so two equations give its
// per-batch base and its per-vertex slope:
//   base + 2457.6 v = 12.08 ms      base + 417.8 v = 6.24 ms
//   -> v = 0.002863, base = 5.043
// The remaining per-batch cost is staging, from the two totals:
//   2457.6 s + 12.08 = 15.80 ms  and  417.8 s + 6.24 = 6.72 ms
//   -> s = 0.001589
// This reproduces both observed totals within ~3 %.
export const COST_MODEL = Object.freeze({
  fixedPerBatchMs: 5.043,
  perVertexAckMs: 0.002863,
  perVertexStagingMs: 0.001589,
  perVertexSubmitCpuMs: 0.0002,
  submitCpuBaseMs: 0.1,
  verticesPerFeature: 1.2,
  idleIntervalMs: 4.17,
  jitterMs: 0.35
});

/** Irreducible per-frame cost: one idle tick plus one batch acknowledgement. */
export function irreducibleFrameMs(cost = COST_MODEL) {
  return cost.idleIntervalMs + cost.fixedPerBatchMs;
}

export const ABLATION_DATASET = Object.freeze({ features: 1_000_000, vertices: 1_200_000 });

/** Deterministic low-amplitude jitter so runs are reproducible but not flat. */
function makeJitter(seed = 20261012) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return ((state / 4294967296) - 0.5) * 2;
  };
}

/**
 * Simulate one loading run. Returns the same aggregate quantities the browser
 * protocol reports for this question: total time, batch count, cumulative ACK
 * cost and frame-interval tail — split into idle and interacting windows so the
 * throughput/responsiveness trade-off stays visible.
 *
 * interaction: mirrors the loading protocol camera path (a command every
 * `everyMs`, the `interacting` flag held for `holdMs`).
 */
export function simulateLoadingRun(tuning, {
  referenceMs = COST_MODEL.idleIntervalMs,
  dataset = ABLATION_DATASET,
  cost = COST_MODEL,
  interaction = { everyMs: 500, holdMs: 250 }
} = {}) {
  const scheduler = new AdaptiveScheduler('adaptive', { referenceMs, tuning });
  const jitter = makeJitter();
  let remainingVertices = dataset.vertices;
  let totalMs = 0;
  let ackMs = 0;
  let stagingMs = 0;
  let batches = 0;
  let now = 0;
  const frameIntervals = [];
  const idleIntervals = [];
  const interactionIntervals = [];

  while (remainingVertices > 0) {
    let frameStaging = 0;
    let frameAck = 0;
    // Mirrors app.js: one acknowledged batch per worker message; the staging
    // budget only decides how many batches share one rAF frame.
    for (;;) {
      const primitives = Math.min(scheduler.batchSize, remainingVertices / cost.verticesPerFeature);
      if (primitives <= 0) break;
      const vertices = primitives * cost.verticesPerFeature;
      const batchStaging = vertices * cost.perVertexStagingMs;
      // Every batch pays its own acknowledgement: receive, staging, GL submit
      // submission and worker scheduling. This is the 1.8-observed cost centre.
      const batchAck = cost.fixedPerBatchMs + vertices * cost.perVertexAckMs;
      const submitCpu = cost.submitCpuBaseMs + vertices * cost.perVertexSubmitCpuMs;
      frameStaging += batchStaging;
      frameAck += batchAck;
      stagingMs += batchStaging;
      ackMs += batchAck;
      scheduler.recordUpload(batchStaging + submitCpu);
      remainingVertices -= vertices;
      batches++;
      if (frameStaging >= scheduler.budgetMs || remainingVertices <= 0) break;
    }
    const frameWork = frameStaging + frameAck;
    totalMs += frameWork;
    const interval = Math.max(cost.idleIntervalMs, cost.idleIntervalMs + frameWork + jitter() * cost.jitterMs);
    frameIntervals.push(interval);
    if (frameIntervals.length > 120) frameIntervals.shift();
    const interacting = interaction !== null && (now % interaction.everyMs) < interaction.holdMs;
    (interacting ? interactionIntervals : idleIntervals).push(interval);
    now += interval;
    const p95 = percentile(frameIntervals.slice(-60), .95) ?? scheduler.referenceMs;
    scheduler.update({ p95, interacting, now });
  }

  const sorted = [...frameIntervals].sort((a, b) => a - b);
  return {
    tuning: scheduler.describe(),
    totalMs,
    ackMs,
    stagingMs,
    batches,
    meanBatchFeatures: dataset.features / batches,
    p95FrameMs: percentile(sorted, .95),
    maxFrameMs: sorted[sorted.length - 1],
    p95IdleMs: percentile(idleIntervals, .95),
    p95InteractingMs: percentile(interactionIntervals, .95),
    maxInteractingMs: interactionIntervals.length ? Math.max(...interactionIntervals) : null,
    finalBatchSize: scheduler.batchSize,
    finalBudgetMs: scheduler.budgetMs,
    batchChanges: scheduler.changes.length
  };
}

function tuningFrom({ pressureReference, referenceFloorMs = 3, batchFloor, budgetRecovery, budgetFloorMs = 1 }) {
  const recover = budgetRecovery === 'proportional'
    ? { budgetRecovery: 'proportional', recoveryFactor: 1.25, recoveryGainMs: 0.25 }
    : { budgetRecovery: 'legacy', recoveryGainMs: 0.2 };
  return {
    name: `${pressureReference}${referenceFloorMs > 3 ? `@${referenceFloorMs}` : ''}/floor${batchFloor}/${budgetRecovery}${budgetFloorMs > 1 ? `-min${budgetFloorMs}` : ''}`,
    pressureReference,
    referenceFloorMs,
    batchFloor,
    ...recover,
    budgetFloorMs
  };
}

export const AXES = Object.freeze({
  pressureReference: [
    { key: 'raw', referenceFloorMs: 3, referenceMs: 4.17, note: 'idle rAF interval as reported by the 240 Hz display (1.9 behaviour)' },
    { key: 'clamped', referenceFloorMs: 12, referenceMs: 4.17, note: 'clamp just above idle tick + one batch ACK (9.21 ms)' },
    { key: 'clamped', referenceFloorMs: 16.7, referenceMs: 4.17, note: 'clamp at 60 Hz - above one acknowledged batch frame' },
    { key: 'nominal', referenceFloorMs: 3, referenceMs: 16.7, note: 'fixed 60 Hz reference (equivalent to the 16.7 clamp here)' }
  ],
  batchFloor: [256, 1024, 2048],
  budgetRecovery: [
    { key: 'legacy', budgetFloorMs: 1, note: '+0.2 ms per decision, 0.8x decrease, floor 1 ms' },
    { key: 'proportional', budgetFloorMs: 1, note: '+25% per decision, floor 1 ms' },
    { key: 'proportional', budgetFloorMs: 2, note: '+25% per decision, floor 2 ms' }
  ]
});

export function runMatrix({ dataset = ABLATION_DATASET } = {}) {
  const rows = [];
  for (const pressure of AXES.pressureReference) {
    for (const floor of AXES.batchFloor) {
      for (const recovery of AXES.budgetRecovery) {
        const tuning = tuningFrom({
          pressureReference: pressure.key,
          referenceFloorMs: pressure.referenceFloorMs,
          batchFloor: floor,
          budgetRecovery: recovery.key,
          budgetFloorMs: recovery.budgetFloorMs
        });
        const result = simulateLoadingRun(tuning, { referenceMs: pressure.referenceMs, dataset });
        rows.push({
          tuning: tuning.name,
          axes: {
            pressureReference: pressure.key,
            referenceFloorMs: pressure.referenceFloorMs,
            batchFloor: floor,
            budgetRecovery: recovery.key,
            budgetFloorMs: recovery.budgetFloorMs
          },
          totalMs: result.totalMs,
          ackMs: result.ackMs,
          batches: result.batches,
          meanBatchFeatures: result.meanBatchFeatures,
          p95FrameMs: result.p95FrameMs,
          p95IdleMs: result.p95IdleMs,
          p95InteractingMs: result.p95InteractingMs,
          maxInteractingMs: result.maxInteractingMs,
          maxFrameMs: result.maxFrameMs,
          finalBatchSize: result.finalBatchSize,
          finalBudgetMs: result.finalBudgetMs
        });
      }
    }
  }
  return rows;
}

/** The shipped fixed pipeline, for side-by-side reading (2 048-feature batches). */
export function simulateFixedPipeline({ dataset = ABLATION_DATASET, batchSize = 2048 } = {}) {
  const cost = COST_MODEL;
  const vertices = dataset.vertices;
  const batches = Math.ceil(vertices / (batchSize * cost.verticesPerFeature));
  const stagingMs = vertices * cost.perVertexStagingMs;
  const ackMs = batches * cost.fixedPerBatchMs + vertices * cost.perVertexAckMs;
  return { batches, stagingMs, ackMs, totalMs: stagingMs + ackMs };
}

export function summarizeMatrix(rows) {
  const byTotal = [...rows].sort((a, b) => a.totalMs - b.totalMs);
  const baselineRow = rows.find(row => row.axes.pressureReference === 'raw'
    && row.axes.batchFloor === 256 && row.axes.budgetRecovery === 'legacy') ?? null;
  const axisEffect = (select, levels) => levels.map(level => {
    const subset = rows.filter(row => select(level, row));
    const totals = subset.map(row => row.totalMs).sort((a, b) => a - b);
    const batches = subset.map(row => row.batches).sort((a, b) => a - b);
    const acks = subset.map(row => row.ackMs).sort((a, b) => a - b);
    return {
      level,
      runs: subset.length,
      medianTotalMs: totals.length ? totals[Math.floor(totals.length / 2)] : null,
      medianBatches: batches.length ? batches[Math.floor(batches.length / 2)] : null,
      medianAckMs: acks.length ? acks[Math.floor(acks.length / 2)] : null,
      minTotalMs: totals[0] ?? null
    };
  });
  return {
    baselineRow,
    bestRow: byTotal[0] ?? null,
    worstRow: byTotal[byTotal.length - 1] ?? null,
    byAxis: {
      pressureReference: axisEffect(
        (level, row) => row.axes.pressureReference === level.key && row.axes.referenceFloorMs === level.referenceFloorMs,
        AXES.pressureReference.map(level => ({ key: level.key, referenceFloorMs: level.referenceFloorMs, label: `${level.key}@${level.referenceFloorMs}` }))
      ),
      batchFloor: axisEffect((level, row) => row.axes.batchFloor === level, AXES.batchFloor),
      budgetRecovery: axisEffect(
        (level, row) => row.axes.budgetRecovery === level && row.axes.budgetFloorMs === (level === 'proportional' ? 2 : 1),
        ['legacy', 'proportional']
      )
    }
  };
}

// 1.8 SDK five-round medians, for side-by-side reading of the model output.
export const OBSERVED_1_8 = Object.freeze({
  fixed: { batches: 489, ackMs: 5905, totalMs: 7729 },
  adaptive: { batches: 2872, ackMs: 17923, totalMs: 19307 }
});

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  const rows = runMatrix();
  const summary = summarizeMatrix(rows);
  const fixed = simulateFixedPipeline();
  const report = {
    generatedAt: new Date().toISOString(),
    tool: 'tools/scheduler-ablation.mjs',
    scope: 'controller simulation calibrated on the 1.8 SDK five-round medians; not a browser measurement',
    costModel: COST_MODEL,
    irreducibleFrameMs: irreducibleFrameMs(),
    dataset: ABLATION_DATASET,
    observed1_8: OBSERVED_1_8,
    fixedPipelineModel: fixed,
    rows,
    summary
  };
  mkdirSync('reports', { recursive: true });
  const path = 'reports/scheduler-ablation-1.10.json';
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(`rows=${rows.length} irreducibleFrame=${irreducibleFrameMs().toFixed(2)}ms`);
  console.log(`model fixed pipeline total=${Math.round(fixed.totalMs)}ms batches=${fixed.batches} ack=${Math.round(fixed.ackMs)}ms (observed 7729ms/489)`);
  console.log(`baseline(raw/floor256/legacy) total=${Math.round(summary.baselineRow.totalMs)}ms batches=${summary.baselineRow.batches} ack=${Math.round(summary.baselineRow.ackMs)}ms (observed 19307ms/2872)`);
  console.log(`best ${summary.bestRow.tuning} total=${Math.round(summary.bestRow.totalMs)}ms batches=${summary.bestRow.batches} ack=${Math.round(summary.bestRow.ackMs)}ms`);
  for (const [axis, effects] of Object.entries(summary.byAxis)) {
    for (const effect of effects) {
      console.log(`  ${axis}=${effect.level} runs=${effect.runs} medianTotal=${Math.round(effect.medianTotalMs)}ms batches=${effect.medianBatches} ack=${Math.round(effect.medianAckMs)}ms best=${Math.round(effect.minTotalMs)}ms`);
    }
  }
  console.log(`written ${path}`);
}
