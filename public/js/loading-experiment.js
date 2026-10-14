import {IMPLEMENTATION_VERSION} from './version.js';
import {samplingWindowCoverage} from './sampling-window.js';
import { percentile } from './scheduler.js';
import { mapCameraPoseMatches } from './map-frame-experiment.js';

export const LOADING_PROTOCOL_VERSION = IMPLEMENTATION_VERSION;
export const LOADING_STAGES = Object.freeze([
  { id: '0-10', label: '0–10%', lower: 0, upper: .1 },
  { id: '10-50', label: '10–50%', lower: .1, upper: .5 },
  { id: '50-100', label: '50–100%', lower: .5, upper: 1 }
].map(stage => Object.freeze(stage)));
const MODES = ['baseline', 'fixed', 'adaptive'];
const ORDERS = [
  ['baseline', 'fixed', 'adaptive'], ['fixed', 'adaptive', 'baseline'],
  ['adaptive', 'baseline', 'fixed'], ['baseline', 'adaptive', 'fixed'],
  ['fixed', 'baseline', 'adaptive'], ['adaptive', 'fixed', 'baseline']
];
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const finite = value => Number.isFinite(value) ? value : null;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

/** Five repeats leave one of six permutations unused; positions differ by at most one. */
export function loadingTrialPlan({ sizes = [100000, 1000000], repeats = 5, seed = 20261009,
  delay = 4, chunk = 1024 } = {}) {
  if (!Array.isArray(sizes) || !sizes.length || new Set(sizes).size !== sizes.length ||
      sizes.some(count => !Number.isInteger(count) || count < 1 || count > 1000000)) {
    throw new RangeError('Loading trial sizes must be distinct integers in 1–1,000,000.');
  }
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 12) throw new RangeError('Loading repeats must be in 1–12.');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isInteger(delay) || delay < 0 || delay > 1000 ||
      !Number.isInteger(chunk) || chunk < 32 || chunk > 8192) throw new RangeError('Invalid loading stream configuration.');
  const plan = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const sizeOrder = repeat % 2 ? sizes : [...sizes].reverse();
    for (const count of sizeOrder) {
      const order = ORDERS[(repeat - 1) % ORDERS.length];
      for (let position = 0; position < order.length; position++) {
        const mode = order[position];
        plan.push({ trialId: `loading-${count}-${mode}-r${repeat}`, count, mode, repeat,
          position: position + 1, seed, delay, chunk, ordinal: plan.length + 1 });
      }
    }
  }
  return plan.map(trial => ({ ...trial, total: plan.length, repeats,
    protocolVersion: LOADING_PROTOCOL_VERSION, methodOrder: [...ORDERS[(trial.repeat - 1) % ORDERS.length]] }));
}

/** An identical wall-time path, modest enough to avoid a queue of SDK easing animations. */
export function loadingCameraView(baseView, elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new RangeError('Elapsed loading time must be nonnegative.');
  const angle = elapsedMs / 6000 * Math.PI * 2;
  if (baseView?.mode === 'baidu') {
    return { ...baseView, center: {
      lng: baseView.center.lng + .0004 * Math.sin(angle),
      lat: baseView.center.lat + .0003 * Math.sin(angle * 2)
    }, zoom: clamp(baseView.zoom + .1 * (1 - Math.cos(angle)), 3, 21),
    heading: ((baseView.heading + 10 * Math.sin(angle)) % 360 + 360) % 360,
    tilt: clamp(baseView.tilt + 6 * (1 - Math.cos(angle)), 0, 73) };
  }
  if (baseView?.mode === 'sandbox') {
    return { ...baseView, x: baseView.x + 40 * Math.sin(angle), y: baseView.y + 30 * Math.sin(angle * 2),
      scale: clamp(baseView.scale * Math.pow(2, .1 * (1 - Math.cos(angle))), .0005, 16),
      heading: baseView.heading + Math.PI / 18 * Math.sin(angle) };
  }
  throw new TypeError('A Baidu or sandbox base view is required.');
}

export function loadingStageForProgress(progress) {
  if (!Number.isFinite(progress)) return null;
  if (progress < .1) return '0-10';
  if (progress < .5) return '10-50';
  return '50-100';
}

function matrixSnapshot(renderer) {
  const matrix = Array.from(renderer.matrix || []);
  return matrix.length === 16 && matrix.every(Number.isFinite) ? matrix : null;
}

function sameMatrix(left, right) {
  return Boolean(left?.length === 16 && right?.length === 16 && left.every((value, index) =>
    Math.abs(value - right[index]) <= 1e-6 * Math.max(1, Math.abs(value), Math.abs(right[index]))));
}

function sameRect(left, right, tolerance = .5) {
  return !left && !right || Boolean(left && right && Number.isFinite(right.width) && Number.isFinite(right.height) &&
    right.width > 0 && right.height > 0 && Math.abs(left.width - right.width) <= tolerance &&
    Math.abs(left.height - right.height) <= tolerance && left.dpr === right.dpr);
}

function applyLoadingCamera(renderer, view) {
  // A Baidu zoom change can move the map center around its zoom anchor.
  // Apply scalar pose first, then correct the center at the resulting zoom.
  // Acceptance still comes from a later fresh business frame and its MVP.
  if (view.mode === 'baidu') {
    const current = renderer.getViewState();
    renderer.setViewState({ ...view, center: { ...current.center } });
    const actualAfterScalars = renderer.getViewState();
    renderer.setViewState(view);
    return { coordinatedRendererCalls: 2, actualAfterScalars: copy(actualAfterScalars), actualAfterCommand: copy(renderer.getViewState()) };
  }
  renderer.setViewState(view);
  return { coordinatedRendererCalls: 1, actualAfterCommand: copy(renderer.getViewState()) };
}

/** Only preparation owns a rAF. The timed collector is driven by existing app hooks. */
export function waitLoadingCamera(renderer, view, { isCancelled = () => false, getRect = () => null,
  timeoutMs = 5000, clock = () => performance.now(), raf = callback => requestAnimationFrame(callback),
  cancelRaf = id => cancelAnimationFrame(id) } = {}) {
  if (!renderer || typeof renderer.subscribeFrames !== 'function') return Promise.reject(new TypeError('Frame subscription required.'));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new RangeError('Camera timeout must be positive.'));
  return new Promise((resolve, reject) => {
    const begun = clock();
    let serial = 0, lastSerial = 0, rafId = null, unsubscribe = null, settled = false;
    let previousMatrix = null, previousActual = null, previousRect = null, stableFrames = 0, stableSince = null;
    let latestActual = null, latestMatrix = null, latestRect = null, latestChecks = null,
      lastTraceAtMs = -Infinity, peakStableFrames = 0, poseReached = false;
    const trace = [], requestAttempts = [];
    const requestTarget = kind => {
      const actualBefore = renderer.getViewState(), atMs = clock() - begun;
      const attempt = { sequence: requestAttempts.length + 1, kind, atMs,
        requestedView: copy(view), actualBefore: copy(actualBefore), renderFramesBefore: serial };
      requestAttempts.push(attempt);
      const applied = applyLoadingCamera(renderer, view);
      Object.assign(attempt, applied, { actualAfter: copy(applied.actualAfterCommand) });
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      if (rafId !== null) cancelRaf(rafId);
      if (error) {
        if (!(error instanceof Error)) error = new Error(String(error));
        error.cameraPreparation = { ready: false, requestedView: copy(view), actualView: copy(latestActual),
          mvp: copy(latestMatrix), mapRect: copy(latestRect), elapsedMs: clock() - begun,
          renderFrames: serial, stableFrames, peakStableFrames, requestedPoseReached: poseReached,
          stableDurationMs: stableSince === null ? 0 : clock() - stableSince,
          timeoutMs, failure: error.message, checks: copy(latestChecks), trace: copy(trace),
          requestAttempts: copy(requestAttempts), maxReassertions: 3, reassertIntervalMs: 100,
          poseTolerance: { centerDegrees: 1e-6, zoom: 1e-3, headingDegrees: .1, tiltDegrees: .1 },
          mvpRelativeTolerance: 1e-6,
          interpretation: 'Diagnostic observations before fetch and before the timed loading window. No data or performance sample is substituted for a failed preparation.' };
        reject(error);
      } else resolve(result);
    };
    const tick = () => {
      rafId = null;
      try {
        const now = clock(), cancelled = isCancelled();
        if (cancelled) throw new Error(typeof cancelled === 'string' ? cancelled : 'Loading camera preparation cancelled.');
        const actual = renderer.getViewState(), matrix = matrixSnapshot(renderer), rect = getRect();
        latestActual = copy(actual); latestMatrix = matrix; latestRect = copy(rect);
        const requestedPoseMatches = mapCameraPoseMatches(view, actual);
        poseReached ||= requestedPoseMatches;
        latestChecks = { freshBusinessFrame: serial !== lastSerial, requestedPoseMatches,
          previousPoseStable: Boolean(previousActual && mapCameraPoseMatches(previousActual, actual)),
          mvpValid: Boolean(matrix), previousMvpStable: sameMatrix(previousMatrix, matrix),
          previousRectStable: sameRect(previousRect, rect) };
        if (serial !== lastSerial) {
          const ready = latestChecks.requestedPoseMatches && latestChecks.previousPoseStable &&
            latestChecks.previousMvpStable && latestChecks.previousRectStable;
          if (ready) { stableFrames++; if (stableSince === null) stableSince = now; }
          else { stableFrames = 0; stableSince = null; }
          peakStableFrames = Math.max(peakStableFrames, stableFrames);
          previousActual = copy(actual); previousMatrix = matrix; previousRect = copy(rect); lastSerial = serial;
          if (stableFrames >= 3 && now - stableSince >= 80) {
            finish(null, { ready: true, requestedView: copy(view), actualView: copy(actual), mvp: matrix,
              elapsedMs: now - begun, renderFrames: serial, stableFrames, stableDurationMs: now - stableSince,
              mapRect: copy(rect), timeoutMs, poseTolerance: { centerDegrees: 1e-6, zoom: 1e-3, headingDegrees: .1, tiltDegrees: .1 },
              mvpRelativeTolerance: 1e-6, requestAttempts: copy(requestAttempts), maxReassertions: 3, reassertIntervalMs: 100 });
            return;
          }
        }
        if (now - begun - lastTraceAtMs >= 100 || now - begun >= timeoutMs) {
          trace.push({ atMs: now - begun, renderFrames: serial, stableFrames,
            actualView: copy(actual), checks: copy(latestChecks), mvp: copy(matrix), mapRect: copy(rect), requestAttempts: requestAttempts.length });
          if (trace.length > 64) trace.shift();
          lastTraceAtMs = now - begun;
        }
        if (now - begun >= timeoutMs) throw new Error('Actual camera pose, fresh business frames, and MVP did not stabilize before loading.');
        // SDK center/zoom setters can apply sequentially: changing zoom may
        // shift a previously requested center. Reassert only during untimed
        // preparation, with a fixed bound, then require new business frames.
        if (!requestedPoseMatches && requestAttempts.length < 4 && now - begun - requestAttempts.at(-1).atMs >= 100) {
          requestTarget('pose-mismatch-reassertion');
          stableFrames = 0; stableSince = null;
          previousActual = null; previousMatrix = null; previousRect = null; lastSerial = serial;
        }
        rafId = raf(tick);
      } catch (error) { finish(error); }
    };
    try {
      unsubscribe = renderer.subscribeFrames(() => { serial++; });
      requestTarget('initial');
      rafId = raf(tick);
    } catch (error) { finish(error); }
  });
}

function cadence(samples, referenceMs) {
  const intervals = samples.map(sample => sample.intervalMs).filter(value => Number.isFinite(value) && value > 0);
  const mean = average(intervals), threshold = Number.isFinite(referenceMs) && referenceMs > 0 ? referenceMs * 1.5 : null;
  return { samples: intervals.length, meanMs: mean, fpsMean: mean > 0 ? 1000 / mean : null,
    p95Ms: percentile(intervals, .95), p99Ms: percentile(intervals, .99), maxMs: intervals.length ? Math.max(...intervals) : null,
    slowThresholdMs: threshold, slowFrames: threshold === null ? null : intervals.filter(value => value > threshold).length };
}

/** This records SDK command-to-observed-pose/GL-callback latency, never physical input/presentation latency. */
export class LoadingTrialCollector {
  constructor({ renderer, trial, started, baseView, referenceMs = null, initialRect = null,
    getRect = () => initialRect, clock = () => performance.now(), longTaskSupported = false, commandIntervalMs = 100 } = {}) {
    if (!renderer || typeof renderer.getViewState !== 'function' || typeof renderer.setViewState !== 'function') throw new TypeError('Renderer camera API required.');
    if (!trial || !MODES.includes(trial.mode) || !Number.isInteger(trial.count) || trial.count < 1 || !Number.isFinite(started)) throw new TypeError('Loading trial and monotonic start required.');
    if (!mapCameraPoseMatches(baseView, baseView)) throw new TypeError('Finite Baidu or sandbox base view required.');
    if (!Number.isFinite(commandIntervalMs) || commandIntervalMs < 100) throw new RangeError('SDK camera commands must be limited to at most 10 Hz.');
    this.renderer = renderer; this.trial = copy(trial); this.started = started; this.baseView = copy(baseView);
    this.referenceMs = referenceMs; this.initialRect = copy(initialRect); this.getRect = getRect; this.clock = clock;
    this.longTaskSupported = Boolean(longTaskSupported); this.commandIntervalMs = commandIntervalMs;
    this.rafSamples = []; this.businessSamples = []; this.cameraCommands = []; this.longTasks = []; this.invalidReasons = [];
    this.networkEOF = null; this.firstVisibleMs = null; this.lastRaf = started; this.lastBusiness = started;
    this.lastCommandAtMs = -Infinity; this.pendingCommand = null; this.lastObservedMvp = null;
    this.observedMatrixChanges = 0; this.observedPoseChanges = 0; this.lastObservedPose = null;
    this.finished = false; this.businessSerial = 0;
  }

  get valid() { return this.invalidReasons.length === 0; }

  invalidate(code, detail = code, atMs = this.clock() - this.started) {
    if (this.finished || this.invalidReasons.some(reason => reason.code === code && reason.detail === detail)) return;
    this.invalidReasons.push({ code, detail: String(detail), atMs: finite(atMs) });
  }

  sampleRaf(now, { shown = 0, uploadedVertices = 0 } = {}) {
    const atMs = now - this.started;
    // An already queued rAF can carry a timestamp earlier than an event-handler start.
    if (this.finished || !Number.isFinite(atMs) || atMs < 0) return;
    if (this.lastRaf !== null && now <= this.lastRaf) return;
    const progress = clamp(shown / this.trial.count, 0, 1);
    this.rafSamples.push({ atMs, intervalMs: now - this.lastRaf, intervalStartsAtRunStart: this.rafSamples.length === 0,
      shown, uploadedVertices, progress, stage: loadingStageForProgress(progress) });
    this.lastRaf = now;
    if (atMs - this.lastCommandAtMs < this.commandIntervalMs) return;
    try {
      if (!sameRect(this.initialRect, this.getRect())) this.invalidate('viewport-changed', 'Map dimensions or device pixel ratio changed.', atMs);
      const beforePose = this.renderer.getViewState(), beforeMvp = matrixSnapshot(this.renderer);
      if (beforePose.mode !== this.baseView.mode) throw new Error('Map mode changed during loading.');
      const requestedView = loadingCameraView(this.baseView, atMs);
      if (this.pendingCommand) {
        this.pendingCommand.status = 'superseded'; this.pendingCommand.supersededAtMs = atMs;
      }
      const command = { sequence: this.cameraCommands.length + 1, requestedAtMs: atMs,
        requestedView: copy(requestedView), beforeView: copy(beforePose), beforeMvp,
        changesPose: !mapCameraPoseMatches(requestedView, beforePose), status: 'pending', businessSerialAtRequest: this.businessSerial };
      this.cameraCommands.push(command); this.pendingCommand = command; this.lastCommandAtMs = atMs;
      Object.assign(command, applyLoadingCamera(this.renderer, requestedView));
    } catch (error) { this.invalidate('camera-command-error', error.message, atMs); }
  }

  onBusinessFrame(info, now = this.clock()) {
    const atMs = now - this.started;
    if (this.finished || !Number.isFinite(atMs) || atMs < 0 || this.lastBusiness !== null && now <= this.lastBusiness) return;
    this.businessSerial++;
    const features = finite(info.features), progress = features === null ? null : clamp(features / this.trial.count, 0, 1);
    this.businessSamples.push({ atMs, intervalMs: now - this.lastBusiness, intervalStartsAtRunStart: this.businessSamples.length === 0,
      features, totalVertices: finite(info.totalVertices), vertices: finite(info.vertices), drawCalls: finite(info.drawCalls),
      frameCpuMs: finite(info.frameMs), spatialBuildCpuMs: finite(info.spatialBuildCpuMs),
      progress, stage: loadingStageForProgress(progress), stagingRevision: finite(info.stagingRevision), committedRevision: finite(info.committedRevision) });
    this.lastBusiness = now;
    if (this.firstVisibleMs === null && info.vertices > 0 && info.drawCalls > 0) this.firstVisibleMs = atMs;
    if (info.contextLost || info.lastError) this.invalidate('render-error', info.lastError || 'WebGL context lost.', atMs);
    const command = this.pendingCommand;
    if (!command || this.businessSerial <= command.businessSerialAtRequest) return;
    try {
      const actualView = this.renderer.getViewState(), mvp = matrixSnapshot(this.renderer);
      // A synchronous SDK getter may update before its MVP. Changed commands need both.
      if (!mvp || !mapCameraPoseMatches(command.requestedView, actualView) || command.changesPose && sameMatrix(command.beforeMvp, mvp)) return;
      command.status = 'observed'; command.observedAtMs = atMs;
      command.commandToBusinessFrameMs = atMs - command.requestedAtMs;
      command.actualView = copy(actualView); command.mvp = mvp; command.observedBusinessSerial = this.businessSerial;
      command.featuresAtObservation = features; command.drawCallsAtObservation = finite(info.drawCalls);
      if (this.lastObservedMvp && !sameMatrix(this.lastObservedMvp, mvp)) this.observedMatrixChanges++;
      if (this.lastObservedPose && !mapCameraPoseMatches(this.lastObservedPose, actualView)) this.observedPoseChanges++;
      this.lastObservedMvp = mvp; this.lastObservedPose = copy(actualView); this.pendingCommand = null;
    } catch (error) { this.invalidate('camera-observation-error', error.message, atMs); }
  }

  setEOF(evidence) {
    if (this.finished) return;
    if (!evidence || !Number.isFinite(evidence.atMs) || evidence.atMs < 0) {
      this.invalidate('invalid-network-eof', 'No usable EOF time on the main-thread run clock.'); return;
    }
    if (this.networkEOF && this.networkEOF.atMs !== evidence.atMs) {
      this.invalidate('network-eof-changed', 'Conflicting network EOF timestamps.'); return;
    }
    this.networkEOF = copy(evidence);
  }

  addLongTask(entry) {
    if (this.finished || !Number.isFinite(entry?.duration) || entry.duration < 0) return;
    const atMs = Number.isFinite(entry.atMs) ? entry.atMs : entry.startTime - this.started;
    if (Number.isFinite(atMs) && atMs + entry.duration >= 0) this.longTasks.push({ atMs, duration: entry.duration, name: entry.name || 'self' });
  }

  finish({ status = 'completed', record = null, endedAt = this.clock() } = {}) {
    if (this.finished) return this.result;
    const endedAtMs = finite(endedAt - this.started), dataDoneMs = finite(record?.metrics?.dataDoneMs);
    const endMs = dataDoneMs !== null && dataDoneMs >= 0 ? Math.min(dataDoneMs, endedAtMs ?? dataDoneMs) : endedAtMs;
    if (status !== 'completed') this.invalidate('trial-incomplete', status, endedAtMs);
    if (status === 'completed' && record?.metrics?.features !== this.trial.count) this.invalidate('feature-count-mismatch', `Expected ${this.trial.count}, received ${record?.metrics?.features ?? 'unknown'}.`, endedAtMs);
    if (!this.networkEOF) this.invalidate('network-eof-missing', 'Response-body EOF was not recorded.', endedAtMs);
    if (endMs !== null && this.networkEOF?.atMs > endMs + 1) this.invalidate('network-eof-after-data-ready', 'Response-body EOF is later than data completion.', endedAtMs);
    if (this.firstVisibleMs === null) this.invalidate('no-business-draw', 'No nonempty business GL draw callback was observed.', endedAtMs);
    else if (endMs !== null && this.firstVisibleMs > endMs) this.invalidate('business-draw-after-loading', 'First nonempty business draw occurred after the loading boundary.', endedAtMs);
    if (this.pendingCommand) { this.pendingCommand.status = 'pending-at-boundary'; this.pendingCommand.boundaryAtMs = endMs; }
    const inWindow = sample => endMs !== null && sample.atMs >= 0 && sample.atMs <= endMs;
    const rafSamples = this.rafSamples.filter(inWindow), businessSamples = this.businessSamples.filter(inWindow);
    const longTasks = this.longTasks.filter(task => endMs !== null && task.atMs < endMs && task.atMs + task.duration > 0);
    const cameraCommands = this.cameraCommands.filter(command => endMs !== null && command.requestedAtMs <= endMs)
      .map(command => command.observedAtMs > endMs ? { ...command, status: 'observed-after-loading-boundary' } :
        command.supersededAtMs > endMs ? { ...command, status: 'pending-at-boundary', boundaryAtMs: endMs } : command);
    const observed = cameraCommands.filter(command => command.status === 'observed');
    let observedMatrixChanges = 0, observedPoseChanges = 0;
    for (let index = 0; index < observed.length; index++) {
      const beforeMvp = index ? observed[index - 1].mvp : observed[index].beforeMvp;
      const beforeView = index ? observed[index - 1].actualView : observed[index].beforeView;
      if (beforeMvp?.length === 16 && !sameMatrix(beforeMvp, observed[index].mvp)) observedMatrixChanges++;
      if (beforeView && !mapCameraPoseMatches(beforeView, observed[index].actualView)) observedPoseChanges++;
    }
    if (!observedMatrixChanges || !observedPoseChanges) this.invalidate('camera-path-unobserved', 'No changed actual camera pose with changed business MVP was observed inside the loading window.', endedAtMs);
    const latency = observed.map(command => command.commandToBusinessFrameMs);
    const stages = LOADING_STAGES.map(stage => ({ ...stage,
      raf: cadence(rafSamples.filter(sample => sample.stage === stage.id), this.referenceMs),
      business: cadence(businessSamples.filter(sample => sample.stage === stage.id), this.referenceMs),
      businessFrameCpuP95Ms: percentile(businessSamples.filter(sample => sample.stage === stage.id).map(sample => sample.frameCpuMs).filter(Number.isFinite), .95) }));
    this.finished = true;
    this.result = { protocolVersion: LOADING_PROTOCOL_VERSION, trial: copy(this.trial), status,
      valid: this.valid, invalidReasons: copy(this.invalidReasons), mapMode: this.baseView.mode,
      startedMonotonicMs: this.started, loadingEndMs: endMs, endedAtMs, expectedFeatures: this.trial.count,
      completedFeatures: finite(record?.metrics?.features), completedVertices: finite(record?.metrics?.vertices),
      firstBusinessDrawMs: this.firstVisibleMs, networkEOF: copy(this.networkEOF),
      firstBusinessDrawBeforeEOF: this.firstVisibleMs === null || !this.networkEOF ? null : this.firstVisibleMs < this.networkEOF.atMs,
      eofToDataReadyMs: this.networkEOF && dataDoneMs !== null ? dataDoneMs - this.networkEOF.atMs : null,
      raf: cadence(rafSamples, this.referenceMs), business: cadence(businessSamples, this.referenceMs), stages,
      windowCoverage: {schemaVersion:'1.0',raf:samplingWindowCoverage(rafSamples,endMs),business:samplingWindowCoverage(businessSamples,endMs),
        scope:'Rates use observed callback count over the complete loading window. Unclosed tail is reported separately without inserting a fabricated interval; callback gaps do not by themselves prove CPU blocking or physical presentation.'},
      longTaskSupported: this.longTaskSupported, longTaskCount: this.longTaskSupported ? longTasks.length : null,
      longTaskDurationMs: this.longTaskSupported ? longTasks.reduce((sum, task) => sum + Math.min(task.atMs + task.duration, endMs) - Math.max(task.atMs, 0), 0) : null,
      camera: { baseView: copy(this.baseView), commandIntervalMs: this.commandIntervalMs, nominalCommandHz: 1000 / this.commandIntervalMs,
        coordinatedRendererCalls: cameraCommands.reduce((sum, command) => sum + (command.coordinatedRendererCalls || 0), 0),
        maxCoordinatedRendererCallsPerCommand: this.baseView.mode === 'baidu' ? 2 : 1,
        requestedCommands: cameraCommands.length, observedCommands: observed.length,
        supersededCommands: cameraCommands.filter(command => command.status === 'superseded').length,
        pendingCommands: cameraCommands.filter(command => !['observed', 'superseded'].includes(command.status)).length,
        observedMatrixChanges, observedPoseChanges,
        commandToBusinessFrameMeanMs: average(latency), commandToBusinessFrameP95Ms: percentile(latency, .95),
        commandToBusinessFrameMaxMs: latency.length ? Math.max(...latency) : null },
      initialRect: copy(this.initialRect), rafSamples, businessSamples, cameraCommands, longTasks,
      measurement: {
        window: 'After verified initial camera preparation and fetch start, until all data is staged and GL upload calls committed; final presentation and GPU completion are not timed.',
        progress: 'rAF stages use completed GL-ACK batches; business stages use renderer feature totals after its GL commit callback. The interval is assigned by its ending progress, so a long crossing interval is retained once. The first interval includes run start to first callback and is explicitly marked.',
        camera: 'Wall-time pan/zoom/heading/tilt commands, at most 10 Hz. Baidu commands coordinate two renderer setViewState calls: scalar pose at current center, then target center at resulting zoom; sandbox uses one call. This ordering prevents synchronous zoom-anchor center drift but does not by itself verify execution. Observed evidence requires requested SDK pose and a fresh business MVP; a changed command must change the previous MVP. Latency is SDK command-to-observed-pose/business-GL-callback, not physical input or display latency.',
        eof: 'Actual response-body EOF as returned by the consumer. Streaming reader consumption is ACK paced; EOF is not independent socket arrival or all server bytes delivered.',
        longTasks: 'PerformanceObserver main-thread task intervals overlapping loading, with duration clipped to the window; unsupported API remains unknown.',
        resources: 'Allocated geometry/GPU buffer counters and sampled JS heap stay in the parent run. CPU/GPU percentage and total process memory are not inferred.'
      } };
    return this.result;
  }
}
