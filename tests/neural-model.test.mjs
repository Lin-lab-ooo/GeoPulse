import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validateModel, inferWindow } from '../public/js/neural-model.js';
import { createNeuralReplay } from '../public/js/neural-worker.js';
const json = relative => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
const model = json('../public/ai/model.json');
const fixtures = json('../ml/parity-fixtures.json').fixtures;

test('deployed JS inference matches independently exported NumPy float64 predictions', () => {
  validateModel(model);
  for (const fixture of fixtures) {
    const result = inferWindow(model, fixture.readings);
    assert.ok(Math.abs(result.score - fixture.score) < 1e-9 * Math.max(1, Math.abs(fixture.score)));
    result.channelResiduals.forEach((value, i) => assert.ok(Math.abs(value - fixture.channelResiduals[i]) < 1e-9 * Math.max(1, Math.abs(value))));
  }
  assert.throws(() => inferWindow(model, fixtures[0].readings.slice(1)), /complete window/);
  const invalid = structuredClone(fixtures[0].readings); invalid[0][0] = NaN;
  assert.throws(() => inferWindow(model, invalid), /finite/);
});

test('training artifacts retain source hashes, three seeds, fixed calibration and negative results', () => {
  const sources = json('../ml/sources.json');
  for (const source of sources.files) {
    const bytes = readFileSync(new URL('../' + source.path, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
  }
  const report = json('../ml/evaluation.json');
  assert.deepEqual(report.runs.map(run => run.seed), [7, 19, 41]);
  assert.equal(report.protocol.testTuning, false);
  assert.equal(report.protocol.pointAdjustment, false);
  assert.equal(report.protocol.normalOnlyTraining, true);
  for (const run of report.runs) {
    assert.ok(run.history.length > 1);
    assert.ok(run.history.at(-1).trainingMSE < run.history[0].trainingMSE, 'actual iterative training reduces loss');
    assert.ok(run.overall.falsePositiveRate > .9, 'failed cross-operating-mode generalization remains disclosed');
  }
  const base = json('../ml/base-model.json');
  assert.equal(base.threshold, report.runs[0].overall.threshold);
  assert.deepEqual(model.layers, base.layers, 'exploratory calibration never retrains weights');
  assert.equal(model.experimental, true);
  assert.equal(model.evaluation.reliableAlarm, false);
  const calibration = json('../ml/exploratory-calibration.json');
  assert.equal(model.threshold, calibration.byFile['data/valve1/1.csv'].methods.mlp_ae_seed_7.threshold);
});

function harness(load) {
  const messages = [], timers = new Map(); let sequence = 0, clock = 0;
  const controller = createNeuralReplay({ postMessage: message => messages.push(message), load,
    setTimer: (fn, ms) => { timers.set(++sequence, { fn, ms }); return sequence; },
    clearTimer: id => timers.delete(id), now: () => (clock += .5) });
  const tick = () => { const [id, entry] = timers.entries().next().value; timers.delete(id); entry.fn(); };
  return { ...controller, messages, timers, tick };
}
function assets() {
  return { model: { ...model, calibration: undefined }, replay: { channels: model.channels, source: { dataset: 'test fixture' }, samples: Array.from({length: 40}, (_, i) => ({
    timestamp: new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString(), readings: fixtures[0].readings[i % model.windowSize], groundTruth: i > 20 ? 1 : 0
  })) } };
}

test('worker has one bounded timer, causal start history, no label-dependent inference and clean completion', async () => {
  const data = assets(); const h = harness(async () => data);
  await h.handle({ type: 'start', runId: 'a', startIndex: 15, intervalMs: 100 });
  const ready = h.messages[0]; assert.equal(ready.startIndex, 15);
  assert.match(ready.startSelection, /labels only/);
  assert.equal(h.timers.size, 1); h.tick();
  const first = h.messages.at(-1);
  assert.equal(first.index, 15); assert.equal(first.status, inferWindow(model, fixtures[0].readings).status);
  assert.ok(Math.abs(first.score - fixtures[0].score) < 1e-8);
  assert.equal(first.latencyMs, .5);
  const labelChanged = assets(); labelChanged.replay.samples.forEach(s => { s.groundTruth = 1 - s.groundTruth; });
  const other = harness(async () => labelChanged);
  await other.handle({ type: 'start', runId: 'b', startIndex: 15 }); other.tick();
  assert.equal(other.messages.at(-1).score, first.score);
  while (h.timers.size) { assert.equal(h.timers.size, 1); h.tick(); }
  assert.deepEqual(h.messages.at(-1), { type: 'done', runId: 'a', samples: 25 });
});

test('latest run wins asset-load races and stale stop cannot stop its successor', async () => {
  let resolve; const promise = new Promise(r => { resolve = r; }); const h = harness(() => promise);
  const old = h.handle({ type: 'start', runId: 'old' });
  const next = h.handle({ type: 'start', runId: 'next' });
  resolve(assets()); await Promise.all([old, next]);
  assert.equal(h.messages.filter(m => m.type === 'ready').length, 1);
  assert.equal(h.messages[0].runId, 'next');
  await h.handle({ type: 'stop', runId: 'old' }); assert.equal(h.timers.size, 1);
  h.tick(); assert.equal(h.messages.at(-1).status, 'warming'); assert.equal(h.messages.at(-1).score, null);
  await h.handle({ type: 'stop', runId: 'next' }); assert.equal(h.timers.size, 0);
  await h.handle({ type: 'start', runId: 'bad', startIndex: -1 });
  assert.equal(h.messages.at(-1).type, 'error'); assert.equal(h.timers.size, 0);
});

test('offline prefix calibration is never represented as past online predictions', async () => {
  const data = assets(); data.model.calibration = { evaluationSegmentStartsAt: 20 };
  const h = harness(async () => data);
  await h.handle({ type: 'start', runId: 'calibration', startIndex: 15 });
  while (h.timers.size) h.tick();
  const samples = h.messages.filter(m => m.type === 'sample');
  assert.ok(samples.filter(m => m.index < 35).every(m => m.status === 'warming' && m.score === null));
  assert.ok(Number.isFinite(samples.find(m => m.index === 35).score));
});

test('complete real replay reproduces Python evaluation timestamps, warming gaps and per-point scores', async () => {
  const replay = json('../public/ai/replay.json');
  const h = harness(async () => ({ model, replay }));
  await h.handle({ type: 'start', runId: 'real', startIndex: model.calibration.evaluationSegmentStartsAt });
  while (h.timers.size) h.tick();
  const scored = h.messages.filter(m => m.type === 'sample' && m.score !== null);
  const csv = readFileSync(new URL('../ml/exploratory-predictions.csv', import.meta.url), 'utf8').trim().split(/\r?\n/);
  const headers = csv.shift().split(',');
  const expected = csv.map(line => Object.fromEntries(line.split(',').map((v,i) => [headers[i],v])))
    .filter(row => row.method === 'mlp_ae_seed_7' && row.experiment === replay.source.experiment);
  assert.deepEqual(scored.map(m => m.index), expected.map(row => Number(row.index)));
  for (let i = 0; i < scored.length; i++) {
    assert.ok(Math.abs(scored[i].score - Number(expected[i].score)) < 1e-9 * Math.max(1, scored[i].score));
    assert.equal(scored[i].status === 'anomaly', expected[i].prediction === '1');
    assert.equal(scored[i].groundTruth, Number(expected[i].label));
  }
});

test('suggested demonstration start is opt-in and an explicit start always wins', async () => {
  const data = assets();
  data.replay.samples = Array.from({length: 120}, (_, i) => ({ timestamp: new Date(Date.UTC(2020,0,1,0,0,i)).toISOString(), readings: fixtures[0].readings[i % 16], groundTruth: i >= 95 ? 1 : 0 }));
  const normal = harness(async () => data);
  await normal.handle({ type:'start', runId:'default' }); normal.tick();
  assert.equal(normal.messages[0].startIndex, 0);
  assert.equal(normal.messages.at(-1).index, 0);
  const suggested = harness(async () => data);
  await suggested.handle({ type:'start', runId:'suggested', useSuggestedStart:true }); suggested.tick();
  assert.equal(suggested.messages[0].startIndex, 31);
  assert.equal(suggested.messages.at(-1).index, 31);
  assert.match(suggested.messages[0].startSelection, /never enter inference/);
  const expected = inferWindow(model, data.replay.samples.slice(16,32).map(s => s.readings));
  assert.equal(suggested.messages.at(-1).score, expected.score, 'suggested view uses ordinary causal inference');
  const explicit = harness(async () => data);
  await explicit.handle({ type:'start', runId:'explicit', useSuggestedStart:true, startIndex:7 }); explicit.tick();
  assert.equal(explicit.messages.at(-1).index, 7);
});
