import { validateModel, inferWindow } from './neural-model.js';

async function loadAssets() {
  const [model, replay] = await Promise.all(['/ai/model.json', '/ai/replay.json'].map(async url => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Neural asset HTTP ${response.status}: ${url}`);
    return response.json();
  }));
  return { model, replay };
}

// Single serial timer, one bounded history window, no pending inference queue.
// Dependency injection also tests stop/restart races without a browser or GPU.
export function createNeuralReplay({ postMessage, load = loadAssets, setTimer = setTimeout, clearTimer = clearTimeout, now = () => performance.now() }) {
  let generation = 0, activeRun = null, timer = null, assetsPromise = null;
  const cancel = () => { if (timer !== null) clearTimer(timer); timer = null; };
  async function handle(message) {
    const { type, runId } = message || {};
    if (type === 'stop') {
      if (runId !== activeRun) return;
      generation++; cancel(); activeRun = null;
      postMessage({ type: 'stopped', runId });
      return;
    }
    if (type !== 'start') return;
    const current = ++generation; cancel(); activeRun = runId;
    try {
      if (runId === undefined || runId === null) throw new Error('runId is required');
      const intervalMs = Math.max(16, Math.min(10000, Number.isFinite(message.intervalMs) ? message.intervalMs : 250));
      if (!assetsPromise) assetsPromise = load().catch(error => { assetsPromise = null; throw error; });
      const { model, replay } = await assetsPromise;
      if (current !== generation) return;
      validateModel(model);
      if (!Array.isArray(replay.samples) || !replay.samples.length || JSON.stringify(replay.channels) !== JSON.stringify(model.channels)) throw new Error('Invalid replay data');
      const timestamps = replay.samples.map(s => Date.parse(s.timestamp));
      if (!timestamps.every(Number.isFinite)) throw new Error('Invalid replay timestamps');
      const differences = timestamps.slice(1).map((v, i) => v - timestamps[i]).filter(v => v > 0).sort((a,b) => a-b);
      const cadence = differences.length ? differences[Math.floor(differences.length / 2)] : 1000;
      const evaluationStart = model.calibration?.evaluationSegmentStartsAt ?? 0;
      const firstAnomaly = replay.samples.findIndex(sample => sample.groundTruth === 1);
      const suggestedStartIndex = Math.max(0, firstAnomaly - 64);
      const startIndex = message.startIndex ?? (message.useSuggestedStart ? suggestedStartIndex : 0);
      if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= replay.samples.length) throw new Error('startIndex is outside the replay');
      postMessage({ type: 'ready', runId, model: { name: model.name, windowSize: model.windowSize, channels: model.channels, threshold: model.threshold, experimental: model.experimental, evaluation: model.evaluation, calibration: model.calibration }, source: replay.source, totalSamples: replay.samples.length, startIndex, suggestedStartIndex, startSelection: 'suggestedStartIndex uses labels only to choose a demonstration view; labels never enter inference or threshold calibration' });
      const history = [];
      for (let j = Math.max(evaluationStart, startIndex - model.windowSize + 1); j < startIndex; j++) {
        if (j && (timestamps[j] <= timestamps[j - 1] || timestamps[j] - timestamps[j - 1] > cadence * 1.5)) history.length = 0;
        history.push(replay.samples[j].readings);
      }
      let index = startIndex, emitted = 0;
      const step = () => {
        timer = null;
        if (current !== generation) return;
        try {
          const sample = replay.samples[index];
          if (!Array.isArray(sample.readings) || sample.readings.length !== 8 || !sample.readings.every(Number.isFinite)) throw new Error('Invalid sensor readings');
          if (index && (timestamps[index] <= timestamps[index - 1] || timestamps[index] - timestamps[index - 1] > cadence * 1.5)) history.length = 0;
          if (index < evaluationStart) history.length = 0;
          else history.push(sample.readings);
          if (history.length > model.windowSize) history.shift();
          const started = now();
          const result = history.length === model.windowSize ? inferWindow(model, history) : { score: null, threshold: model.threshold, status: 'warming', channelResiduals: Array(8).fill(0) };
          const latencyMs = now() - started;
          postMessage({ type: 'sample', runId, index, timestamp: sample.timestamp, readings: sample.readings, ...result, groundTruth: sample.groundTruth, latencyMs });
          index++; emitted++;
          if (index >= replay.samples.length) {
            if (!message.loop) { activeRun = null; postMessage({ type: 'done', runId, samples: emitted }); return; }
            index = 0; history.length = 0;
          }
          timer = setTimer(step, intervalMs);
        } catch (error) {
          activeRun = null;
          postMessage({ type: 'error', runId, message: error.message });
        }
      };
      timer = setTimer(step, 0);
    } catch (error) {
      if (current !== generation) return;
      activeRun = null;
      postMessage({ type: 'error', runId, message: error.message });
    }
  }
  return { handle };
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  const replay = createNeuralReplay({ postMessage: message => self.postMessage(message) });
  self.onmessage = event => { void replay.handle(event.data); };
}
