/**
 * Feedback controller, measured on the main thread. No inferred GPU/CPU percentages.
 *
 * Tuning profiles exist because the 1.8 loading experiment isolated a throughput
 * loss: on a high-refresh display the caller supplies the idle rAF interval
 * (~4.1 ms on 240 Hz) as the reference, so every ordinary frame looks like an
 * overrun. The controller then saturates at its batch floor, and the fixed
 * per-batch acknowledgement cost (main-thread receive, staging, GL submit
 * submission, worker scheduling) dominates: 2 872 batches / 17.923 s of ACK
 * waiting versus 489 batches / 5.905 s for the fixed pipeline.
 *
 * The three tunable axes below are the ones the 1.8 report asked to ablate:
 *   1. pressureReference - what counts as an overrun (raw / clamped / nominal)
 *   2. batchFloor        - how small a batch may become
 *   3. budgetRecovery    - how the staging budget comes back
 */

export const SCHEDULER_TUNING_PRESETS = Object.freeze({
  legacy: Object.freeze({
    name: 'legacy',
    pressureReference: 'raw',
    referenceFloorMs: 3,
    referenceCeilingMs: 33.4,
    batchFloor: 256,
    batchCeiling: 8192,
    budgetRecovery: 'legacy',
    recoveryGainMs: 0.2,
    recoveryFactor: 1,
    budgetFloorMs: 1
  }),
  // 1.10 candidate, chosen with tools/scheduler-ablation.mjs. In the streaming
  // regime every batch pays an irreducible acknowledgement (idle tick + one
  // batch submit ~= 9.2 ms), so a reference below that pins the controller at
  // its floor forever. Clamp the reference at 60 Hz, never shrink below 1 024
  // features, and recover the staging budget proportionally.
  tuned: Object.freeze({
    name: 'tuned',
    pressureReference: 'clamped',
    referenceFloorMs: 16.7,
    referenceCeilingMs: 33.4,
    batchFloor: 1024,
    batchCeiling: 8192,
    budgetRecovery: 'proportional',
    recoveryGainMs: 0.25,
    recoveryFactor: 1.25,
    budgetFloorMs: 1
  })
});

const PRESSURE_MODES = new Set(['raw', 'clamped', 'nominal']);
const RECOVERY_MODES = new Set(['legacy', 'linear', 'proportional']);
const NOMINAL_REFERENCE_MS = 16.7;

export function normalizeTuning(tuning) {
  const source = tuning && typeof tuning === 'object' ? tuning : SCHEDULER_TUNING_PRESETS.legacy;
  const next = { ...SCHEDULER_TUNING_PRESETS.legacy, ...source };
  if (!PRESSURE_MODES.has(next.pressureReference)) throw new RangeError('pressureReference 无效。');
  if (!RECOVERY_MODES.has(next.budgetRecovery)) throw new RangeError('budgetRecovery 无效。');
  if (!Number.isFinite(next.referenceFloorMs) || next.referenceFloorMs < 1 || next.referenceFloorMs > 33.4) {
    throw new RangeError('referenceFloorMs 须在 [1,33.4]。');
  }
  if (!Number.isFinite(next.referenceCeilingMs) || next.referenceCeilingMs < next.referenceFloorMs || next.referenceCeilingMs > 100) {
    throw new RangeError('referenceCeilingMs 须不低于下限且不超过 100。');
  }
  if (!Number.isInteger(next.batchFloor) || next.batchFloor < 128 || next.batchFloor > 8192) {
    throw new RangeError('batchFloor 须为 [128,8192] 的整数。');
  }
  if (!Number.isInteger(next.batchCeiling) || next.batchCeiling < next.batchFloor || next.batchCeiling > 65536) {
    throw new RangeError('batchCeiling 须不低于下限且不超过 65536。');
  }
  if (next.batchFloor % 128 || next.batchCeiling % 128) throw new RangeError('批量边界须为 128 的整数倍。');
  if (!Number.isFinite(next.recoveryGainMs) || next.recoveryGainMs <= 0 || next.recoveryGainMs > 8) {
    throw new RangeError('recoveryGainMs 须在 (0,8]。');
  }
  if (!Number.isFinite(next.recoveryFactor) || next.recoveryFactor < 1 || next.recoveryFactor > 4) {
    throw new RangeError('recoveryFactor 须在 [1,4]。');
  }
  if (!Number.isFinite(next.budgetFloorMs) || next.budgetFloorMs < 0.5 || next.budgetFloorMs > 8) {
    throw new RangeError('budgetFloorMs 须在 [0.5,8]。');
  }
  return Object.freeze(next);
}

export function effectiveReferenceMs(referenceMs, tuning) {
  const configured = Number.isFinite(referenceMs) ? referenceMs : NOMINAL_REFERENCE_MS;
  const t = normalizeTuning(tuning);
  if (t.pressureReference === 'nominal') return NOMINAL_REFERENCE_MS;
  if (t.pressureReference === 'clamped') {
    return Math.max(t.referenceFloorMs, Math.min(t.referenceCeilingMs, configured));
  }
  return Math.max(t.referenceFloorMs, Math.min(t.referenceCeilingMs, configured));
}

export class AdaptiveScheduler {
  constructor(mode = 'adaptive', { referenceMs = NOMINAL_REFERENCE_MS, tuning = SCHEDULER_TUNING_PRESETS.legacy } = {}) {
    this.mode = mode;
    this.tuning = normalizeTuning(tuning);
    this.rawReferenceMs = Number.isFinite(referenceMs) ? referenceMs : NOMINAL_REFERENCE_MS;
    this.referenceMs = effectiveReferenceMs(this.rawReferenceMs, this.tuning);
    this.batchSize = 2048;
    this.budgetMs = Math.min(4, this.referenceMs * .35);
    this.budgetCapMs = Math.min(6, this.referenceMs * .5);
    this.lastDecision = 0;
    this.reason = '等待帧间隔与提交成本采样';
    this.pressure = 0;
    this.changes = [];
    this.uploadEWMA = 0;
  }

  setTuning(tuning) {
    this.tuning = normalizeTuning(tuning);
    this.referenceMs = effectiveReferenceMs(this.rawReferenceMs, this.tuning);
    this.budgetCapMs = Math.min(6, this.referenceMs * .5);
    this.budgetMs = Math.min(this.budgetMs, this.budgetCapMs);
    this.lastDecision = 0;
    this.reason = '调参已切换：' + this.tuning.name;
    return this.snapshot();
  }

  recordUpload(ms) { this.uploadEWMA = this.uploadEWMA ? this.uploadEWMA * .8 + ms * .2 : ms; }

  update({ p95 = NOMINAL_REFERENCE_MS, interacting = false, now = performance.now() } = {}) {
    this.pressure = Math.min(1, Math.max(0, (p95 / this.referenceMs - 1) / 1.8, this.uploadEWMA / this.referenceMs));
    if (this.mode !== 'adaptive') {
      this.batchSize = 2048;
      this.budgetMs = 8;
      this.reason = this.mode === 'baseline' ? '全量下载后主线程统一解析' : '固定 2,048 条解析批次';
      return this.snapshot();
    }
    if (now - this.lastDecision < 450) return this.snapshot();
    this.lastDecision = now;
    const t = this.tuning;
    const before = this.batchSize;
    if (p95 > this.referenceMs * 1.45 || this.uploadEWMA > this.referenceMs * .42 || (interacting && p95 > this.referenceMs * 1.1)) {
      this.batchSize = Math.max(t.batchFloor, Math.floor(this.batchSize * .65 / 128) * 128);
      this.budgetMs = Math.max(t.budgetFloorMs, this.budgetMs * .8);
      this.reason = interacting ? '正在交互：降低批次，为地图留出响应时间' : '帧间隔或提交耗时升高：降低批次，收紧暂存预算';
    } else if (p95 < this.referenceMs * 1.17 && this.uploadEWMA < this.referenceMs * .21) {
      this.batchSize = Math.min(t.batchCeiling, this.batchSize + 256);
      this.budgetMs = this._recoverBudget();
      this.reason = '帧间隔稳定：逐步增大批次，提高持续吞吐';
    } else this.reason = '运行接近当前预算：保持批次，避免来回震荡';
    if (before !== this.batchSize) this.changes.push({ at: now, batchSize: this.batchSize, budgetMs: this.budgetMs, p95, uploadEWMA: this.uploadEWMA, reason: this.reason });
    return this.snapshot();
  }

  _recoverBudget() {
    const t = this.tuning;
    if (t.budgetRecovery === 'proportional') {
      const grown = Math.max(this.budgetMs * t.recoveryFactor, this.budgetMs + t.recoveryGainMs);
      return Math.min(this.budgetCapMs, grown);
    }
    // 'linear' and 'legacy' share the additive step; legacy is kept as the
    // frozen 1.9 behaviour so both sides of the ablation stay reproducible.
    return Math.min(this.budgetCapMs, this.budgetMs + t.recoveryGainMs);
  }

  snapshot() {
    return {
      batchSize: this.batchSize,
      budgetMs: this.budgetMs,
      pressure: this.pressure,
      reason: this.reason,
      effectiveReferenceMs: this.referenceMs,
      tuning: this.tuning.name
    };
  }

  describe() {
    return {
      mode: this.mode,
      tuning: this.tuning.name,
      rawReferenceMs: this.rawReferenceMs,
      effectiveReferenceMs: this.referenceMs,
      pressureReference: this.tuning.pressureReference,
      batchFloor: this.tuning.batchFloor,
      batchCeiling: this.tuning.batchCeiling,
      budgetRecovery: this.tuning.budgetRecovery,
      budgetMs: this.budgetMs,
      batchSize: this.batchSize
    };
  }
}

export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function summarize(values) {
  if (!values.length) return { n: 0, mean: null, stddev: null };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { n: values.length, mean, stddev: values.length > 1 ? Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1)) : 0 };
}
