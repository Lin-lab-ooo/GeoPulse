import test from 'node:test';
import assert from 'node:assert/strict';
import { loadingTrialPlan, loadingCameraView, loadingStageForProgress, LoadingTrialCollector,
  waitLoadingCamera } from '../public/js/loading-experiment.js';

const copy = value => JSON.parse(JSON.stringify(value));
const baseView = { mode: 'baidu', center: { lng: 121.5812, lat: 31.1959 }, zoom: 14, heading: 0, tilt: 0 };
const rect = { width: 800, height: 400, dpr: 1.5 };
const identity = () => Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function fixture(options = {}) {
  let now = 1000, actual = copy(baseView), currentRect = copy(rect);
  const listeners = new Set();
  const renderer = { matrix: identity(),
    getViewState: () => copy(actual),
    setViewState(view) { actual = copy(view); },
    subscribeFrames(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    paint() {
      this.matrix[0] = 1 + actual.heading / 360;
      this.matrix[12] = (actual.center.lng - baseView.center.lng) * 10000;
      for (const listener of listeners) listener({});
    }
  };
  const collector = new LoadingTrialCollector({ renderer, trial: { count: 100, mode: 'fixed', repeat: 1 },
    started: 1000, baseView, initialRect: rect, getRect: () => currentRect, clock: () => now,
    referenceMs: 10, ...options });
  const frame = (atMs, { features = 0, vertices = 0, drawCalls = 0 } = {}) => {
    now = atMs + 1000;
    collector.onBusinessFrame({ features, totalVertices: features, vertices, drawCalls,
      frameMs: 1, spatialBuildCpuMs: 0, stagingRevision: features, committedRevision: features }, now);
  };
  const sample = (atMs, shown = 0) => { now = atMs + 1000; collector.sampleRaf(now, { shown, uploadedVertices: shown }); };
  const finish = (dataDoneMs = 350, endedAtMs = 400, features = 100, status = 'completed') => {
    now = endedAtMs + 1000;
    return collector.finish({ status, endedAt: now, record: { metrics: { features, vertices: features, dataDoneMs } } });
  };
  return { renderer, collector, frame, sample, finish, listeners, setRect: value => { currentRect = value; }, setNow: value => { now = value; } };
}

function validTrial(options = {}) {
  const f = fixture(options);
  f.sample(10, 0); f.renderer.paint(); f.frame(20);
  f.sample(120, 5); f.renderer.paint(); f.frame(130, { features: 5, vertices: 5, drawCalls: 1 });
  f.sample(230, 25); f.renderer.paint(); f.frame(240, { features: 25, vertices: 25, drawCalls: 1 });
  f.sample(340, 100); f.renderer.paint(); f.frame(345, { features: 100, vertices: 100, drawCalls: 1 });
  f.collector.setEOF({ atMs: 300, source: 'worker-reader', acknowledgedConsumer: true });
  return f;
}

test('formal loading plan attempts two sizes, three methods, and five counterbalanced repeats serially', () => {
  const plan = loadingTrialPlan();
  assert.equal(plan.length, 30);
  assert.equal(new Set(plan.map(trial => trial.trialId)).size, 30);
  assert.deepEqual(plan.map(trial => trial.ordinal), Array.from({ length: 30 }, (_, index) => index + 1));
  assert.ok(plan.every(trial => trial.total === 30 && trial.protocolVersion === '2.6'));
  for (const count of [100000, 1000000]) {
    for (const mode of ['baseline', 'fixed', 'adaptive']) {
      const subset = plan.filter(trial => trial.count === count && trial.mode === mode);
      assert.equal(subset.length, 5);
      assert.deepEqual(subset.map(trial => trial.repeat), [1, 2, 3, 4, 5]);
      const positions = [1, 2, 3].map(position => subset.filter(trial => trial.position === position).length);
      assert.equal(Math.max(...positions) - Math.min(...positions), 1);
    }
  }
  assert.equal(plan[0].count, 100000);
  assert.equal(plan[6].count, 1000000);
});

test('invalid stream sizes/configurations and duplicate sizes cannot enter the formal plan', () => {
  for (const options of [{ sizes: [] }, { sizes: [1, 1] }, { sizes: [1000001] }, { repeats: 0 }, { repeats: 1.5 },
    { seed: -1 }, { delay: 1001 }, { chunk: 31 }]) assert.throws(() => loadingTrialPlan(options), RangeError);
});

test('loading camera path is deterministic, periodic, bounded, and preserves the base pose', () => {
  const original = copy(baseView);
  for (let atMs = 0; atMs <= 6000; atMs += 10) {
    const view = loadingCameraView(baseView, atMs);
    assert.ok(view.zoom >= 14 && view.zoom <= 14.2);
    assert.ok(view.tilt >= 0 && view.tilt <= 12);
    assert.ok(Math.abs(view.center.lng - baseView.center.lng) <= .000400001);
    assert.ok(Math.abs(view.center.lat - baseView.center.lat) <= .000300001);
    assert.ok(Math.min(view.heading, 360 - view.heading) <= 10.000001);
  }
  const start = loadingCameraView(baseView, 0), end = loadingCameraView(baseView, 6000);
  assert.ok(Math.abs(start.heading - end.heading) < 1e-9);
  assert.deepEqual(baseView, original);
  assert.throws(() => loadingCameraView(baseView, -1), RangeError);
});

test('sandbox path retains metres and radians and progress boundaries form disjoint stages', () => {
  const view = loadingCameraView({ mode: 'sandbox', x: 0, y: 0, scale: .1, heading: 0 }, 1500);
  assert.equal(view.x, 40);
  assert.ok(Math.abs(view.heading - Math.PI / 18) < 1e-12);
  assert.equal(loadingStageForProgress(0), '0-10');
  assert.equal(loadingStageForProgress(.09999), '0-10');
  assert.equal(loadingStageForProgress(.1), '10-50');
  assert.equal(loadingStageForProgress(.5), '50-100');
  assert.equal(loadingStageForProgress(1), '50-100');
  assert.equal(loadingStageForProgress(NaN), null);
});

test('collector rejects stale rAF stamps and records run-start-to-first callbacks without losing a stall', () => {
  const f = fixture();
  f.sample(-1); f.frame(-1);
  assert.equal(f.collector.rafSamples.length, 0);
  assert.equal(f.collector.businessSamples.length, 0);
  f.sample(500, 0); f.frame(510, { features: 100, vertices: 100, drawCalls: 1 });
  assert.equal(f.collector.rafSamples[0].intervalMs, 500);
  assert.equal(f.collector.businessSamples[0].intervalMs, 510);
  assert.equal(f.collector.rafSamples[0].intervalStartsAtRunStart, true);
  f.sample(500); f.frame(510);
  assert.equal(f.collector.rafSamples.length, 1);
  assert.equal(f.collector.businessSamples.length, 1);
});

test('a synchronous SDK getter is insufficient: changed commands need a changed fresh business MVP', () => {
  const f = fixture();
  f.sample(100);
  f.frame(110);
  assert.equal(f.collector.cameraCommands[0].status, 'pending');
  f.renderer.paint(); f.frame(120);
  assert.equal(f.collector.cameraCommands[0].status, 'observed');
  assert.equal(f.collector.cameraCommands[0].commandToBusinessFrameMs, 20);
  assert.equal(f.collector.firstVisibleMs, null);
});

test('coordinated timed Baidu command corrects zoom-anchor center drift before waiting for a business MVP', () => {
  const f = fixture();
  const originalSetViewState = f.renderer.setViewState;
  let calls = 0;
  f.renderer.setViewState = function(view) {
    const before = this.getViewState(); calls++;
    originalSetViewState.call(this, before.zoom === view.zoom ? view : {
      ...view, center: { lng: view.center.lng + .05, lat: view.center.lat - .02 }
    });
  };
  f.sample(1000);
  const command = f.collector.cameraCommands[0];
  assert.equal(calls, 2);
  assert.equal(command.coordinatedRendererCalls, 2);
  assert.notEqual(command.actualAfterScalars.center.lng, command.requestedView.center.lng);
  assert.deepEqual(command.actualAfterCommand, command.requestedView);
  assert.equal(command.status, 'pending');
  f.frame(1010); // Getter matches, but no updated matrix has been produced yet.
  assert.equal(command.status, 'pending');
  f.renderer.paint(); f.frame(1020);
  assert.equal(command.status, 'observed');
  assert.equal(command.commandToBusinessFrameMs, 20);
});

test('commands stay at most 10 Hz and unresolved requests are retained as superseded', () => {
  const f = fixture();
  f.sample(10); f.sample(50); f.sample(109); f.sample(110);
  assert.equal(f.collector.cameraCommands.length, 2);
  assert.equal(f.collector.cameraCommands[0].status, 'superseded');
  assert.equal(f.collector.cameraCommands[0].supersededAtMs, 110);
  assert.equal(f.collector.cameraCommands[1].status, 'pending');
  assert.throws(() => fixture({ commandIntervalMs: 99 }), RangeError);
});

test('completed trial verifies camera evidence, exact features, EOF, first draw, and stage summaries', () => {
  const f = validTrial();
  const result = f.finish();
  assert.equal(result.valid, true);
  assert.equal(result.expectedFeatures, 100);
  assert.equal(result.completedFeatures, 100);
  assert.equal(result.firstBusinessDrawMs, 130);
  assert.equal(result.firstBusinessDrawBeforeEOF, true);
  assert.equal(result.eofToDataReadyMs, 50);
  assert.equal(result.camera.observedCommands, 4);
  assert.equal(result.camera.observedMatrixChanges, 4);
  assert.equal(result.camera.observedPoseChanges, 4);
  assert.equal(result.stages[1].raf.samples, 1);
  assert.equal(result.stages[1].business.samples, 1);
  assert.equal(result.longTaskCount, null);
  assert.equal(f.collector.finish({ status: 'cancelled' }), result);
});

test('missing stage callbacks stay unknown; empty stages never become zero FPS or zero CPU', () => {
  const f = validTrial();
  f.collector.rafSamples = f.collector.rafSamples.filter(sample => sample.stage !== '10-50');
  f.collector.businessSamples = f.collector.businessSamples.filter(sample => sample.stage !== '10-50');
  const stage = f.finish().stages.find(stage => stage.id === '10-50');
  assert.equal(stage.raf.samples, 0);
  assert.equal(stage.raf.fpsMean, null);
  assert.equal(stage.raf.p95Ms, null);
  assert.equal(stage.businessFrameCpuP95Ms, null);
});

test('post-loading camera frames cannot repair a missing loading-period path', () => {
  const f = fixture();
  f.sample(1); f.frame(20, { features: 100, vertices: 100, drawCalls: 1 });
  f.sample(120); f.renderer.paint(); f.frame(130);
  f.collector.setEOF({ atMs: 50, source: 'main-response-text' });
  const result = f.finish(80, 150);
  assert.equal(result.valid, false);
  assert.equal(result.camera.observedMatrixChanges, 0);
  assert.equal(result.camera.observedCommands, 1);
  assert.ok(result.invalidReasons.some(reason => reason.code === 'camera-path-unobserved'));
});

test('one changed command verified against its before-pose and before-MVP is sufficient loading-path evidence', () => {
  const f = fixture();
  f.sample(100); f.renderer.paint(); f.frame(120, { features: 100, vertices: 100, drawCalls: 1 });
  f.collector.setEOF({ atMs: 110, source: 'worker-reader' });
  const result = f.finish(150, 180);
  assert.equal(result.valid, true);
  assert.equal(result.camera.observedCommands, 1);
  assert.equal(result.camera.observedPoseChanges, 1);
  assert.equal(result.camera.observedMatrixChanges, 1);
});

test('a command observed only after the loading boundary retains its unresolved boundary status', () => {
  const f = validTrial();
  f.sample(450); f.renderer.paint(); f.frame(470);
  f.sample(560); f.renderer.paint(); f.frame(570);
  const result = f.finish(460, 600);
  assert.equal(result.camera.requestedCommands, 5);
  assert.equal(result.camera.observedCommands, 4);
  assert.equal(result.camera.pendingCommands, 1);
  assert.equal(result.cameraCommands.at(-1).status, 'observed-after-loading-boundary');
  assert.ok(result.rafSamples.every(sample => sample.atMs <= 460));
  assert.ok(result.businessSamples.every(sample => sample.atMs <= 460));
});

test('a request superseded only after loading still counts as pending at that boundary', () => {
  const f = validTrial();
  f.sample(450); // Requested during loading but never observed.
  f.sample(560); // Supersedes the preceding request after loading ends.
  const result = f.finish(460, 600);
  assert.equal(result.camera.requestedCommands, 5);
  assert.equal(result.camera.supersededCommands, 0);
  assert.equal(result.camera.pendingCommands, 1);
  assert.equal(result.cameraCommands.at(-1).status, 'pending-at-boundary');
  assert.equal(result.cameraCommands.at(-1).supersededAtMs, 560);
});

test('unsupported long-task API stays unknown; supported intervals are clipped to the loading window', () => {
  const f = validTrial({ longTaskSupported: true });
  f.collector.addLongTask({ atMs: -20, duration: 60, name: 'self' });
  f.collector.addLongTask({ startTime: 1320, duration: 70 });
  f.collector.addLongTask({ atMs: 360, duration: 100 });
  const result = f.finish(350);
  assert.equal(result.longTaskCount, 2);
  assert.equal(result.longTaskDurationMs, 70);
  assert.equal(result.longTasks[0].atMs, -20);
});

test('cancellation and explicit interference remain invalid records with raw samples preserved', () => {
  const f = validTrial();
  f.collector.invalidate('trusted-input', 'Pointer moved by the user.', 200);
  const result = f.finish(250, 300, 25, 'cancelled');
  assert.equal(result.status, 'cancelled');
  assert.equal(result.valid, false);
  assert.ok(result.invalidReasons.some(reason => reason.code === 'trusted-input'));
  assert.ok(result.invalidReasons.some(reason => reason.code === 'trial-incomplete'));
  assert.ok(result.rafSamples.length > 0);
});

test('feature mismatch, missing EOF, inconsistent EOF, and viewport changes are explicit invalid reasons', () => {
  const f = validTrial();
  f.collector.setEOF({ atMs: 299, source: 'other-clock' });
  f.setRect({ ...rect, width: 810 }); f.sample(450);
  const result = f.finish(500, 550, 99);
  assert.equal(result.valid, false);
  for (const code of ['feature-count-mismatch', 'network-eof-changed', 'viewport-changed']) {
    assert.ok(result.invalidReasons.some(reason => reason.code === code));
  }
  const missing = validTrial(); missing.collector.networkEOF = null;
  assert.ok(missing.finish().invalidReasons.some(reason => reason.code === 'network-eof-missing'));
});

test('first nonempty draw occurring after loading remains recorded and invalidates that loading trial', () => {
  const f = fixture();
  f.sample(10); f.renderer.paint(); f.frame(20);
  f.sample(120); f.renderer.paint(); f.frame(130);
  f.frame(180, { features: 100, vertices: 100, drawCalls: 1 });
  f.collector.setEOF({ atMs: 100, source: 'reader' });
  const result = f.finish(150, 200);
  assert.equal(result.firstBusinessDrawMs, 180);
  assert.ok(result.invalidReasons.some(reason => reason.code === 'business-draw-after-loading'));
});

test('camera preparation requires fresh business frames and stable pose/MVP, and removes its subscription', async () => {
  const f = fixture();
  let now = 0, serial = 0, callbacks = new Map();
  const waiting = waitLoadingCamera(f.renderer, baseView, { clock: () => now, getRect: () => rect,
    raf: callback => { const id = ++serial; callbacks.set(id, callback); return id; }, cancelRaf: id => callbacks.delete(id) });
  const tick = (time, paint = true) => {
    now = time;
    if (paint) f.renderer.paint();
    const [id, callback] = callbacks.entries().next().value;
    callbacks.delete(id); callback(time);
  };
  tick(10); tick(40); tick(70); tick(100); tick(130);
  const result = await waiting;
  assert.equal(result.ready, true);
  assert.equal(result.elapsedMs, 130);
  assert.equal(result.stableDurationMs, 90);
  assert.equal(f.listeners.size, 0);
  assert.equal(callbacks.size, 0);
});

test('preparation times out when getters are stable but no business frames arrive', async () => {
  const f = fixture();
  let now = 0, callback;
  const waiting = waitLoadingCamera(f.renderer, baseView, { timeoutMs: 100, clock: () => now,
    raf: next => { callback = next; return 1; }, cancelRaf: () => {} });
  now = 100; callback(100);
  await assert.rejects(waiting, error => {
    assert.match(error.message, /fresh business frames/);
    const diagnostic = error.cameraPreparation;
    assert.equal(diagnostic.ready, false);
    assert.equal(diagnostic.renderFrames, 0);
    assert.equal(diagnostic.requestedPoseReached, true);
    assert.equal(diagnostic.checks.freshBusinessFrame, false);
    assert.equal(diagnostic.checks.requestedPoseMatches, true);
    assert.deepEqual(diagnostic.actualView, baseView);
    assert.deepEqual(diagnostic.requestedView, baseView);
    assert.equal(diagnostic.mvp.length, 16);
    assert.equal(diagnostic.trace.length, 1);
    assert.equal(diagnostic.elapsedMs, 100);
    return true;
  });
  assert.equal(f.listeners.size, 0);
});

test('preparation diagnostics distinguish a later SDK reset overriding the requested pose from missing frames', async () => {
  const f = fixture();
  let now = 0, callback;
  const waiting = waitLoadingCamera(f.renderer, baseView, { timeoutMs: 100, clock: () => now, getRect: () => rect,
    raf: next => { callback = next; return 1; }, cancelRaf: () => {} });
  f.renderer.setViewState({ ...baseView, zoom: 12 });
  now = 20; f.renderer.paint(); callback(20);
  now = 100; f.renderer.paint(); callback(100);
  await assert.rejects(waiting, error => {
    const diagnostic = error.cameraPreparation;
    assert.equal(diagnostic.ready, false);
    assert.equal(diagnostic.renderFrames, 2);
    assert.equal(diagnostic.actualView.zoom, 12);
    assert.equal(diagnostic.requestedView.zoom, 14);
    assert.equal(diagnostic.checks.requestedPoseMatches, false);
    assert.equal(diagnostic.checks.previousPoseStable, true);
    assert.equal(diagnostic.checks.previousMvpStable, true);
    assert.equal(diagnostic.peakStableFrames, 0);
    assert.equal(diagnostic.trace.at(-1).atMs, 100);
    return true;
  });
  assert.equal(f.listeners.size, 0);
});

test('bounded preparation reassertion corrects SDK center drift after sequential center/zoom commands', async () => {
  const f = fixture();
  const originalSetViewState = f.renderer.setViewState;
  let commandCount = 0, now = 0, callback;
  f.renderer.setViewState = function(view) {
    originalSetViewState.call(this, commandCount++ < 2 ? { ...view, center: { lng: view.center.lng + .05, lat: view.center.lat - .02 } } : view);
  };
  const waiting = waitLoadingCamera(f.renderer, baseView, { timeoutMs: 1000, clock: () => now, getRect: () => rect,
    raf: next => { callback = next; return 1; }, cancelRaf: () => {} });
  const tick = time => { now = time; f.renderer.paint(); callback(time); };
  tick(20); tick(100);
  assert.equal(commandCount, 4);
  tick(130); tick(160); tick(190); tick(220); tick(250);
  const result = await waiting;
  assert.equal(result.ready, true);
  assert.deepEqual(result.actualView, baseView);
  assert.equal(result.requestAttempts.length, 2);
  assert.equal(result.requestAttempts[0].kind, 'initial');
  assert.equal(result.requestAttempts[1].kind, 'pose-mismatch-reassertion');
  assert.equal(result.requestAttempts[1].atMs, 100);
  assert.equal(result.requestAttempts[1].actualBefore.zoom, 14);
  assert.equal(result.requestAttempts[1].actualBefore.center.lng, baseView.center.lng + .05);
  assert.equal(result.requestAttempts[1].actualAfter.center.lng, baseView.center.lng);
  assert.ok(result.stableDurationMs >= 80);
  assert.equal(f.listeners.size, 0);
});

test('preparation reassertions remain bounded when the SDK permanently refuses the requested pose', async () => {
  const f = fixture();
  const originalSetViewState = f.renderer.setViewState;
  let commandCount = 0, now = 0, callback;
  f.renderer.setViewState = function(view) { commandCount++; originalSetViewState.call(this, { ...view, zoom: 12 }); };
  const waiting = waitLoadingCamera(f.renderer, baseView, { timeoutMs: 500, clock: () => now, getRect: () => rect,
    raf: next => { callback = next; return 1; }, cancelRaf: () => {} });
  for (const time of [20, 100, 200, 300, 400, 500]) { now = time; f.renderer.paint(); callback(time); }
  await assert.rejects(waiting, error => {
    const diagnostic = error.cameraPreparation;
    assert.equal(diagnostic.ready, false);
    assert.equal(diagnostic.actualView.zoom, 12);
    assert.equal(diagnostic.checks.requestedPoseMatches, false);
    assert.equal(diagnostic.requestAttempts.length, 4);
    assert.deepEqual(diagnostic.requestAttempts.map(attempt => attempt.atMs), [0, 100, 200, 300]);
    assert.equal(diagnostic.maxReassertions, 3);
    return true;
  });
  assert.equal(commandCount, 8);
  assert.equal(f.listeners.size, 0);
});

test('preparation cancellation stops its own rAF and subscription without starting a timed trial', async () => {
  const f = fixture();
  let callback, cancelled = false, rafCancelled = false;
  const waiting = waitLoadingCamera(f.renderer, baseView, { isCancelled: () => cancelled ? 'User stopped.' : false,
    raf: next => { callback = next; return 9; }, cancelRaf: () => { rafCancelled = true; } });
  cancelled = true; callback(1);
  await assert.rejects(waiting, /User stopped/);
  assert.equal(f.listeners.size, 0);
  // The callback already running is no longer scheduled; no other rAF remains.
  assert.equal(rafCancelled, false);
});
