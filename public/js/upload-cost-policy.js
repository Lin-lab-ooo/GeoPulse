/** Experimental CPU upload advisor. Does not change production defaults.
 * The model predicts bufferSubData CPU submission, never GPU completion.
 */
import { planDirtyRanges } from './dirty-ranges.js';

export const DEFAULT_UPLOAD_POLICY = Object.freeze({ mergeGapBytes: 64, maxRanges: 32 });
export function describeUpload(ranges) {
  return { calls: ranges.length, bytes: ranges.reduce((n, [a, b]) => n + b - a, 0) };
}

/** Fit t = intercept + alpha*calls + beta*bytes from median block CPU samples.
 * Unconstrained least squares is deliberately rejected when either coefficient
 * is nonpositive. Clipping a negative noisy slope would create false savings.
 */
export function fitUploadCost(samples, { minimumR2 = .8, maximumRelativeError = .35, validation = [] } = {}) {
  if (!Array.isArray(samples) || samples.length < 6) return { usable: false, reason: 'insufficient calibration samples' };
  const rows = samples.filter(s => Number.isFinite(s.calls) && s.calls > 0 && Number.isFinite(s.bytes)
    && s.bytes > 0 && Number.isFinite(s.cpuMs) && s.cpuMs > 0);
  if (rows.length !== samples.length) return { usable: false, reason: 'invalid calibration sample' };
  const mean = field => rows.reduce((n, s) => n + s[field], 0) / rows.length;
  const mx = mean('calls'), my = mean('bytes'), mt = mean('cpuMs');
  let xx = 0, yy = 0, xy = 0, xt = 0, yt = 0;
  for (const s of rows) {
    const x = s.calls - mx, y = s.bytes - my, t = s.cpuMs - mt;
    xx += x * x; yy += y * y; xy += x * y; xt += x * t; yt += y * t;
  }
  const determinant = xx * yy - xy * xy;
  if (!(xx > 0 && yy > 0 && determinant / (xx * yy) > 1e-6)) {
    return { usable: false, reason: 'call and byte features are singular or collinear' };
  }
  const alphaMsPerCall = (xt * yy - yt * xy) / determinant;
  const betaMsPerByte = (yt * xx - xt * xy) / determinant;
  const interceptMs = mt - alphaMsPerCall * mx - betaMsPerByte * my;
  const model = { usable: false, interceptMs, alphaMsPerCall, betaMsPerByte,
    breakEvenGapBytes: alphaMsPerCall / betaMsPerByte, calibrationSamples: rows.length };
  if (!(alphaMsPerCall > 0 && betaMsPerByte > 0 && Number.isFinite(model.breakEvenGapBytes))) {
    return { ...model, reason: 'nonpositive or nonfinite fitted coefficient' };
  }
  let sse = 0, total = 0;
  for (const s of rows) { sse += (s.cpuMs - predictUploadCpu(model, s)) ** 2; total += (s.cpuMs - mt) ** 2; }
  const r2 = total > 0 ? 1 - sse / total : 0;
  const residualVariance = sse / (rows.length - 3);
  const alphaStandardError = Math.sqrt(residualVariance * yy / determinant);
  const betaStandardError = Math.sqrt(residualVariance * xx / determinant);
  const errors = validation.map(s => Math.abs(predictUploadCpu(model, s) - s.cpuMs) / Math.max(s.cpuMs, 1e-9));
  const validationMeanRelativeError = errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null;
  Object.assign(model, { r2, alphaStandardError, betaStandardError, validationSamples: validation.length,
    validationMeanRelativeError });
  if (r2 < minimumR2) return { ...model, reason: 'calibration R2 below acceptance threshold' };
  if (alphaMsPerCall <= 2 * alphaStandardError || betaMsPerByte <= 2 * betaStandardError) {
    return { ...model, reason: 'coefficient uncertainty reaches zero' };
  }
  if (!validation.length || validationMeanRelativeError > maximumRelativeError) {
    return { ...model, reason: validation.length ? 'held-out calibration prediction error too high' : 'missing held-out calibration' };
  }
  return { ...model, usable: true, reason: 'positive stable coefficients and held-out calibration passed' };
}

export function predictUploadCpu(model, features) {
  return model.interceptMs + model.alphaMsPerCall * features.calls + model.betaMsPerByte * features.bytes;
}

/** Optimal additive upload plan closes an independent gap g exactly when
 * beta*g <= alpha. There is no forced call cap; forcing one could undo the
 * model objective. Full upload is considered separately. Planning CPU is not
 * represented by this model, and must be included by the experiment timer.
 */
export function planUploadByCost(ranges, bufferBytes, model, { fallback = DEFAULT_UPLOAD_POLICY } = {}) {
  if (!Number.isSafeInteger(bufferBytes) || bufferBytes < 0) throw new RangeError('bufferBytes must be a nonnegative safe integer');
  if (!Array.isArray(ranges)) throw new TypeError('ranges must be an array');
  for (const range of ranges) if (!Array.isArray(range) || range.length !== 2
    || !Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1])
    || range[0] < 0 || range[1] < range[0] || range[1] > bufferBytes) throw new RangeError('dirty range lies outside buffer');
  if (!ranges.some(([a, b]) => a < b)) return { ranges: [], choice: 'empty', modelUsed: false, predictedCpuMs: 0 };
  if (!model?.usable) return { ranges: planDirtyRanges(ranges, fallback), choice: 'fallback-fixed', modelUsed: false,
    reason: model?.reason || 'missing calibrated model', predictedCpuMs: null };
  const gap = Math.min(bufferBytes, Math.max(0, Math.floor(model.breakEvenGapBytes)));
  const partial = planDirtyRanges(ranges, { mergeGapBytes: gap, maxRanges: Math.max(1, ranges.length) });
  const full = [[0, bufferBytes]], partialCpu = predictUploadCpu(model, describeUpload(partial));
  const fullCpu = predictUploadCpu(model, describeUpload(full));
  const useFull = fullCpu < partialCpu;
  return { ranges: useFull ? full : partial, choice: useFull ? 'model-full' : 'model-gap', modelUsed: true,
    mergeGapBytes: gap, predictedCpuMs: useFull ? fullCpu : partialCpu };
}
