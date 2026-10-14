import test from 'node:test';
import assert from 'node:assert/strict';
import { describeUpload, fitUploadCost, planUploadByCost, predictUploadCpu } from '../public/js/upload-cost-policy.js';
import { planUploadBySpan } from '../tools/fixtures/upload-span-policy-2.3.js';

const sample = (calls, bytes) => ({ calls, bytes, cpuMs: .1 + .01 * calls + .000001 * bytes });
const samples = [1, 4, 16].flatMap(calls => [256, 4096, 65536].map(bytes => sample(calls, bytes)));
const model = fitUploadCost(samples, { validation: [sample(2, 1024), sample(8, 32768)] });
test('CPU upload fit separates call and byte cost with held-out validation', () => {
  assert.equal(model.usable, true); assert.ok(Math.abs(model.alphaMsPerCall - .01) < 1e-10);
  assert.ok(Math.abs(model.betaMsPerByte - .000001) < 1e-12); assert.ok(Math.abs(model.interceptMs - .1) < 1e-10);
  assert.equal(model.validationSamples, 2); assert.ok(Math.abs(predictUploadCpu(model, { calls: 2, bytes: 8 }) - .120008) < 1e-10);
});
test('calibration rejects absent validation, singular features, negative slopes and noisy coefficients', () => {
  assert.equal(fitUploadCost(samples).usable, false);
  assert.equal(fitUploadCost(samples.slice(0, 3)).usable, false);
  assert.equal(fitUploadCost(samples.map(s => ({ ...s, bytes: s.calls * 8 })), { validation: [sample(2, 16)] }).usable, false);
  assert.equal(fitUploadCost(samples.map(s => ({ ...s, cpuMs: 1 - .01 * s.calls + .000001 * s.bytes })), { validation: [sample(2, 16)] }).usable, false);
  assert.equal(fitUploadCost(samples, { validation: [{ calls: 8, bytes: 32768, cpuMs: 20 }] }).usable, false);
});
test('optimal independent gap rule saves calls only below fitted break-even bytes', () => {
  const ranges = [[40000, 40004], [4, 8], [100, 104]], copy = structuredClone(ranges);
  const result = planUploadByCost(ranges, 262140, model);
  assert.equal(result.modelUsed, true); assert.deepEqual(result.ranges, [[4, 104], [40000, 40004]]);
  assert.deepEqual(ranges, copy); assert.deepEqual(describeUpload(result.ranges), { calls: 2, bytes: 104 });
});
test('no calibrated model uses existing fixed policy and keeps two far points at eight bytes', () => {
  const result = planUploadByCost([[400, 404], [200000, 200004]], 262140, { usable: false, reason: 'noisy' });
  assert.equal(result.choice, 'fallback-fixed'); assert.equal(result.reason, 'noisy'); assert.equal(result.predictedCpuMs, null);
  assert.deepEqual(result.ranges, [[400, 404], [200000, 200004]]);
});
test('empty dirty set uploads nothing; invalid spans cannot silently lose writes', () => {
  assert.deepEqual(planUploadByCost([], 0, model).ranges, []);
  assert.deepEqual(planUploadByCost([[1, 1]], 10, model).ranges, []);
  assert.throws(() => planUploadByCost([[0, 11]], 10, model), RangeError);
  assert.throws(() => planUploadByCost([[3, 2]], 10, model), RangeError);
  assert.throws(() => planUploadByCost([], -1, model), RangeError);
});
test('seeded model plans cover every dirty interval without enforcing a costly cap', () => {
  let seed = 77;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let t = 0; t < 200; t++) {
    const ranges = Array.from({ length: 50 }, () => { const start = Math.floor(random() * 200000); return [start, start + 4]; });
    const result = planUploadByCost(ranges, 262140, model).ranges;
    for (const [a, b] of ranges) assert.ok(result.some(([x, y]) => a >= x && b <= y));
  }
});
test('span policy preserves tiny updates and skips sorting large compact or widespread dirty sets', () => {
  assert.deepEqual(planUploadBySpan([[400, 404], [200000, 200004]], 262140).ranges, [[400, 404], [200000, 200004]]);
  const compact = Array.from({ length: 512 }, (_, i) => [4000 + i * 8, 4004 + i * 8]).reverse();
  const result = planUploadBySpan(compact, 262140); assert.equal(result.choice, 'span-envelope');
  assert.deepEqual(result.ranges, [[4000, 8092]]);
  const global = Array.from({ length: 512 }, (_, i) => [i * 512, i * 512 + 4]);
  assert.equal(planUploadBySpan(global, 262140).choice, 'span-full');
});
test('span options and invalid interval endpoints are rejected and empty dirty set uploads nothing', () => {
  assert.deepEqual(planUploadBySpan([], 0).ranges, []);
  assert.deepEqual(planUploadBySpan([[4, 4]], 10).ranges, []);
  for (const range of [[0, 11], [4, 3], [-1, 2], [1.5, 3]]) assert.throws(() => planUploadBySpan([range], 10), RangeError);
  assert.throws(() => planUploadBySpan([], 10, { minimumRanges: 0 }), RangeError);
  assert.throws(() => planUploadBySpan([], 10, { fullCoverage: 0 }), RangeError);
});
