import { createDetector, createNdjsonPullDecoder, packBatch, transferablesForBatch, parseStreamCountHeader, verifyStreamRecordCount } from './data.js';
import { transportReceipt } from './transport.js';

let activeRun = null;
const clampBatchSize = value => Math.max(256, Math.min(16384, Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 2048));

function cancelRun(run) {
  if (!run) return;
  run.cancelled = true;
  run.controller.abort();
  if (run.rejectAck) run.rejectAck(new DOMException('Run cancelled', 'AbortError'));
  run.rejectAck = null;
  run.resolveAck = null;
  if (run.reader) run.reader.cancel().catch(() => {});
}
function addSummary(target, summary) {
  for (const [key, value] of Object.entries(summary)) {
    if (key !== 'precision' && key !== 'recall' && typeof value === 'number') target[key] = (target[key] ?? 0) + value;
  }
}
function finishSummary(summary) {
  const positive = (summary.truePositive ?? 0) + (summary.falsePositive ?? 0);
  const truth = (summary.truePositive ?? 0) + (summary.falseNegative ?? 0);
  return { ...summary, precision: positive ? summary.truePositive / positive : null, recall: truth ? summary.truePositive / truth : null };
}
function snapshot(run) {
  return { ...run.metrics, networkTiming: { ...run.metrics.networkTiming }, elapsedMs: performance.now() - run.startedAt, detector: run.detector.snapshot() };
}
function mainClockAt(run, workerNow = performance.now()) {
  return run.metrics.networkTiming.mainClockAvailable ? performance.timeOrigin + workerNow - run.mainStartedEpochMs : null;
}
function publishNetworkTiming(run, phase) {
  self.postMessage({
    type: 'network-timing', runId: run.runId, phase, timing: { ...run.metrics.networkTiming },
    bytes: run.metrics.bytes, parsed: run.metrics.parsed, delivered: run.metrics.delivered,
  });
}

async function sendBatch(run, records) {
  if (run.cancelled) throw new DOMException('Run cancelled', 'AbortError');
  const packedAt = performance.now();
  const batch = packBatch(records, { detector: run.detector });
  run.metrics.packMs += performance.now() - packedAt;
  run.metrics.batches += 1;
  run.metrics.delivered += batch.featureCount;
  if (run.metrics.firstBatchMs === null) run.metrics.firstBatchMs = performance.now() - run.startedAt;
  addSummary(run.summary, batch.summary);
  const acknowledged = new Promise((resolve, reject) => {
    run.resolveAck = resolve;
    run.rejectAck = reject;
  });
  const sentAt = performance.now();
  self.postMessage({ type: 'batch', runId: run.runId, batch, metrics: snapshot(run) }, transferablesForBatch(batch));
  // Exactly one unacknowledged message: pause packing and network reads until GPU commit.
  await acknowledged;
  const ackWaitMs = performance.now() - sentAt;
  run.metrics.networkTiming.ackWaitMs += ackWaitMs;
  run.metrics.networkTiming.ackWaitCount += 1;
  run.metrics.networkTiming.maxAckWaitMs = Math.max(run.metrics.networkTiming.maxAckWaitMs, ackWaitMs);
  run.resolveAck = null;
  run.rejectAck = null;
}

async function readStream(run, url) {
  try {
    const fetchedAt = performance.now();
    const response = await fetch(url, { signal: run.controller.signal, cache: 'no-store' });
    run.metrics.fetchMs = performance.now() - fetchedAt;
    run.metrics.networkTiming.responseHeadersAtMs = mainClockAt(run);
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Stream HTTP ${response.status}: ${detail.slice(0, 200)}`);
    }
    if (!response.body) throw new Error('This browser does not expose a readable HTTP response stream');
    if (!response.headers.get('content-type')?.includes('ndjson')) throw new Error('Stream must return application/x-ndjson');
    run.metrics.transport = transportReceipt(response);
    // Only an explicit nonnegative safe integer is an exact stream contract.
    // Absent/malformed headers are unknown, not a zero/URL-derived estimate.
    run.metrics.expected = parseStreamCountHeader(response.headers.get('x-stream-count'));
    run.reader = response.body.getReader();
    const decoder = createNdjsonPullDecoder();
    const pending = [];
    const consume = async records => {
      run.metrics.parsed += records.length;
      run.metrics.maxParsedNotDelivered = Math.max(run.metrics.maxParsedNotDelivered, run.metrics.parsed - run.metrics.delivered);
      run.metrics.maxParserDrainRecords = Math.max(run.metrics.maxParserDrainRecords, records.length);
      for (const record of records) {
        if (run.cancelled) throw new DOMException('Run cancelled', 'AbortError');
        pending.push(record);
        if (pending.length >= run.batchSize) {
          await sendBatch(run, pending);
          // packBatch has materialized independent transfer buffers; reuse only
          // this record-reference container after the matching GL commit ACK.
          pending.length = 0;
        }
      }
    };
    const parseBatch = () => {
      if (run.cancelled) throw new DOMException('Run cancelled', 'AbortError');
      const parsedAt = performance.now();
      // Read the current limit after every ACK: adaptive feedback may change
      // batchSize, and pending can already contain a previous chunk's tail.
      const records = decoder.drain(Math.max(1, run.batchSize - pending.length));
      run.metrics.parseMs += performance.now() - parsedAt;
      return records;
    };
    while (!run.cancelled) {
      const readStartedAt = performance.now();
      const { done, value } = await run.reader.read();
      const readFinishedAt = performance.now();
      run.metrics.networkTiming.readerWaitMs += readFinishedAt - readStartedAt;
      run.metrics.networkTiming.readerReadCalls += 1;
      if (done) {
        run.metrics.networkTiming.responseBodyEofAtMs = mainClockAt(run, readFinishedAt);
        run.metrics.networkTiming.responseBodyEofWorkerElapsedMs = readFinishedAt - run.startedAt;
        // This observes reader EOF under ACK backpressure, not transport download completion.
        // Publish before final parsing and a possible partial batch waits for its final ACK.
        publishNetworkTiming(run, 'response-body-eof');
        break;
      }
      run.metrics.bytes += value.byteLength;
      run.metrics.maxReaderChunkBytes = Math.max(run.metrics.maxReaderChunkBytes, value.byteLength);
      run.metrics.transport.decodedResponseBytes = run.metrics.bytes;
      if (value.byteLength > 0 && run.metrics.networkTiming.firstByteWorkerElapsedMs === null) {
        run.metrics.networkTiming.firstByteAtMs = mainClockAt(run, readFinishedAt);
        run.metrics.networkTiming.firstByteWorkerElapsedMs = readFinishedAt - run.startedAt;
        publishNetworkTiming(run, 'first-byte');
      }
      const parsedAt = performance.now();
      decoder.push(value);
      run.metrics.parseMs += performance.now() - parsedAt;
      run.metrics.maxParserBufferedTextCodeUnits = Math.max(run.metrics.maxParserBufferedTextCodeUnits, decoder.bufferedTextCodeUnits);
      while (decoder.hasPendingInput) { const records = parseBatch(); if (records.length) await consume(records); }
    }
    const finalParseAt = performance.now();
    decoder.finishInput();
    run.metrics.parseMs += performance.now() - finalParseAt;
    while (decoder.hasPendingInput) { const records = parseBatch(); if (records.length) await consume(records); }
    verifyStreamRecordCount(run.metrics.parsed, run.metrics.expected);
    if (pending.length) await sendBatch(run, pending);
    if (!run.cancelled) {
      run.metrics.transport = transportReceipt(response, run.metrics.bytes, true, null, fetchedAt);
      run.metrics.networkTiming.workerDoneAtMs = mainClockAt(run);
      self.postMessage({ type: 'done', runId: run.runId, metrics: snapshot(run), summary: finishSummary(run.summary) });
    }
  } catch (error) {
    if (!run.cancelled && activeRun === run) self.postMessage({ type: 'error', runId: run.runId, message: error.message ?? String(error) });
  } finally {
    if (run.reader) { try { run.reader.releaseLock(); } catch {} }
    run.resolveAck = null;
    run.rejectAck = null;
    if (activeRun === run) activeRun = null;
  }
}

self.addEventListener('message', event => {
  const message = event.data ?? {};
  if (message.type === 'cancel') {
    if (activeRun && message.runId === activeRun.runId) cancelRun(activeRun);
    return;
  }
  if (message.type === 'ack') {
    if (!activeRun || message.runId !== activeRun.runId || !activeRun.resolveAck) return;
    if (activeRun.mode === 'adaptive' && message.batchSize !== undefined) activeRun.batchSize = clampBatchSize(message.batchSize);
    activeRun.resolveAck();
    activeRun.resolveAck = null;
    return;
  }
  if (message.type !== 'start') return;
  cancelRun(activeRun);
  if (!message.runId || typeof message.url !== 'string' || !message.url) {
    self.postMessage({ type: 'error', runId: message.runId, message: 'start requires a runId and stream URL' });
    return;
  }
  if (!['adaptive', 'fixed'].includes(message.mode ?? 'adaptive')) {
    self.postMessage({ type: 'error', runId: message.runId, message: 'baseline uses fetch.text() and main-thread parseNdjson(); Worker supports adaptive and fixed modes' });
    return;
  }
  const mode = message.mode ?? 'adaptive';
  const mainStartedEpochMs = Number.isFinite(message.mainStartedEpochMs) ? message.mainStartedEpochMs : null;
  const run = {
    runId: message.runId, mode, batchSize: clampBatchSize(message.batchSize), cancelled: false,
    controller: new AbortController(), reader: null, resolveAck: null, rejectAck: null,
    detector: createDetector({ mode: 'adaptive' }), startedAt: performance.now(), mainStartedEpochMs, summary: {},
    metrics: {
      bytes: 0, parseMs: 0, packMs: 0, parsed: 0, delivered: 0,
      maxParsedNotDelivered: 0, maxParserDrainRecords: 0, maxReaderChunkBytes: 0, maxParserBufferedTextCodeUnits: 0, batches: 0, fetchMs: 0, firstBatchMs: null, expected: null, maxPendingBatches: 1, mode,
      networkTiming: {
        schemaVersion: '1.0',
        clockBasis: 'performance.timeOrigin+performance.now()-mainStartedEpochMs',
        mainClockAvailable: mainStartedEpochMs !== null && Number.isFinite(performance.timeOrigin),
        responseHeadersAtMs: null, firstByteAtMs: null, firstByteWorkerElapsedMs: null,
        responseBodyEofAtMs: null, responseBodyEofWorkerElapsedMs: null, workerDoneAtMs: null,
        readerWaitMs: 0, readerReadCalls: 0, ackWaitMs: 0, ackWaitCount: 0, maxAckWaitMs: 0,
        scope: {
          firstByte: 'first nonempty Response.body reader value observed by the Worker',
          responseBodyEof: 'Response.body reader done observed under one-batch ACK backpressure; may occur after transport completion; excludes final decoder flush and partial-batch ACK',
          readerWait: 'sum of awaited reader.read() durations including promise scheduling; excludes time directly waiting for batch ACK; not wire transfer duration',
          ackWait: 'batch postMessage to resumed ACK await; includes main-thread delivery, staging, GL submission and Worker scheduling; not GPU completion',
          relativeClock: 'main run elapsed time from matching performance time-origin clocks; null when mainStartedEpochMs is not supplied',
        },
      },
    },
  };
  activeRun = run;
  readStream(run, message.url);
});
