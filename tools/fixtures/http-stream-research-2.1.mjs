import http from 'node:http';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, constants as zlibConstants } from 'node:zlib';
import { createHash } from 'node:crypto';
import { setTimeout as sleep, setImmediate as yieldEventLoop } from 'node:timers/promises';
import { createServer, parseStreamOptions } from '../../server.mjs';
import { generateRecords } from '../../public/js/data.js';

const MAX_SEGMENT_BYTES = 16 * 1024;
const CODECS = new Set(['identity', 'gzip-1', 'gzip-6']);
function normalizeTransport(value, previous = { codec: 'identity', rateBytesPerSecond: 0 }) {
  const next = { ...previous, ...(typeof value === 'string' ? { codec: value } : value ?? {}) };
  if (!CODECS.has(next.codec)) throw new RangeError('codec must be identity, gzip-1 or gzip-6');
  if (!Number.isFinite(next.rateBytesPerSecond) || next.rateBytesPerSecond < 0 || next.rateBytesPerSecond > 1e9) throw new RangeError('rateBytesPerSecond must be finite from 0 to 1e9');
  return { codec: next.codec, rateBytesPerSecond: next.rateBytesPerSecond };
}
function sendJson(response, status, message) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ error: message }));
}
function waitForDrain(response, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { response.off('drain', drained); response.off('close', stopped); signal.removeEventListener('abort', stopped); };
    const drained = () => { cleanup(); resolve(); };
    const stopped = () => { cleanup(); reject(new DOMException('Research stream cancelled', 'AbortError')); };
    response.once('drain', drained); response.once('close', stopped); signal.addEventListener('abort', stopped, { once: true });
    if (signal.aborted || response.destroyed) stopped();
  });
}

/**
 * Isolated localhost research wrapper. Static/API requests except /api/stream
 * delegate to the unchanged production server. Never attach credentials here.
 * recordGenerator is a test seam; the default is the production generator.
 */
export function createHttpStreamResearchServer({ transport: initialTransport, publicRoot, reportsRoot,
  recordGenerator = generateRecords } = {}) {
  if (typeof recordGenerator !== 'function') throw new TypeError('recordGenerator must be a function');
  let transport = normalizeTransport(initialTransport), active = null, serial = 0;
  const trials = [];
  const production = createServer({ publicRoot, reportsRoot });
  const delegate = production.listeners('request')[0];
  const server = http.createServer({ highWaterMark: MAX_SEGMENT_BYTES }, async (request, response) => {
    let url;
    try { url = new URL(request.url, 'http://127.0.0.1'); } catch { return sendJson(response, 400, 'Invalid URL'); }
    if (url.pathname !== '/api/stream') return delegate.call(production, request, response);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD'); return sendJson(response, 405, 'Method not allowed');
    }
    let options;
    try { options = parseStreamOptions(url.searchParams); } catch (error) { return sendJson(response, 400, error.message); }
    if (active) return sendJson(response, 409, 'Research stream trials must run serially');
    const selected = { ...transport }, started = performance.now(), cpuStarted = process.cpuUsage();
    const rawHash = createHash('sha256'), encodedHash = createHash('sha256'), controller = new AbortController();
    const trial = {
      id: ++serial, method: request.method, options, transport: selected, status: 'running',
      producedRecords: 0, serviceChunks: 0, rawBytesProduced: 0, encodedBytesProduced: 0, encodedBytesWritten: 0,
      firstEntityOutputAtMs: null, firstEntityOutputBytes: null, responseFinishedAtMs: null, totalMs: null,
      generationEncodingWallMs: 0, responseDrainWaitCount: 0, responseDrainWaitMs: 0, gzipDrainEvents: 0,
      paceWaitCount: 0, paceWaitMs: 0, maxResponseSegmentBytes: 0,
      cpuProcessDeltaMicroseconds: null, rawSha256: null, encodedWrittenSha256: null, errorName: null, errorCode: null,
      scope: {
        rawBytes: 'UTF-8 JSON.stringify(record)+LF bytes produced before compression; cancellation may leave some produced bytes unsent',
        encodedBytesProduced: 'compressed transform output or identity output presented to the paced sink',
        encodedBytesWritten: 'entity bytes accepted by ServerResponse.write; excludes HTTP framing/headers/TCP and is not acknowledged client arrival',
        firstEntityOutput: 'first nonempty ServerResponse.write call relative to trial start, after any server出口pace wait; not first client byte',
        generationEncoding: 'sum of synchronous generator.next/JSON.stringify/Buffer.from spans using performance.now; excludes zlib, pacing and drain waits',
        cpu: 'process.cpuUsage delta for the whole trial, including zlib worker threads and any other process activity; not per-stream exclusive CPU',
        pace: 'cumulative entity-byte deadlines at server output only; not a real network bandwidth emulator',
        compression: selected.codec === 'identity' ? 'identity' : 'one createGzip member; Z_SYNC_FLUSH after every input service chunk; Z_FINISH trailer on successful EOF',
        buffering: 'Node stream highWaterMark backpressure; an indivisible generated service chunk may exceed 16KiB; response writes are <=16KiB',
      },
    };
    trials.push(trial); active = trial;
    const cancelled = () => { if (!response.writableFinished) controller.abort(); };
    response.once('close', cancelled);
    response.once('finish', () => { trial.responseFinishedAtMs = performance.now() - started; });
    response.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no',
      'X-Stream-Count': String(options.count), 'X-Stream-Seed': String(options.seed), 'X-Coordinate-System': 'local-baidu-mercator-meters',
      'X-Research-Transport': selected.codec, 'X-Research-Output-Pace': String(selected.rateBytesPerSecond),
      ...(selected.codec === 'identity' ? {} : { 'Content-Encoding': 'gzip' }),
    });
    let gzip = null;
    try {
      if (request.method === 'HEAD') {
        await new Promise((resolve, reject) => {
          const aborted = () => reject(new DOMException('HEAD cancelled', 'AbortError'));
          controller.signal.addEventListener('abort', aborted, { once: true });
          response.end(() => { controller.signal.removeEventListener('abort', aborted); resolve(); });
        });
        trial.status = 'head-completed';
      } else {
        response.flushHeaders();
        async function* generateChunks() {
          const iterator = recordGenerator(options);
          while (trial.producedRecords < options.count) {
            controller.signal.throwIfAborted();
            const generationStarted = performance.now(), lines = [];
            const size = Math.min(options.chunk, options.count - trial.producedRecords);
            for (let index = 0; index < size; index++) {
              const item = iterator.next();
              if (item.done) throw new Error('Research generator ended before expected count');
              lines.push(JSON.stringify(item.value)); trial.producedRecords++;
            }
            const bytes = Buffer.from(lines.join('\n') + '\n', 'utf8');
            trial.generationEncodingWallMs += performance.now() - generationStarted;
            rawHash.update(bytes); trial.rawBytesProduced += bytes.byteLength; trial.serviceChunks++;
            yield bytes;
            if (trial.producedRecords < options.count) {
              if (options.delay) await sleep(options.delay, undefined, { signal: controller.signal });
              else await yieldEventLoop(undefined, { signal: controller.signal });
            }
          }
        }
        async function writeEncoded(buffer) {
          trial.encodedBytesProduced += buffer.byteLength;
          for (let offset = 0; offset < buffer.byteLength; offset += MAX_SEGMENT_BYTES) {
            controller.signal.throwIfAborted();
            const segment = buffer.subarray(offset, Math.min(buffer.byteLength, offset + MAX_SEGMENT_BYTES));
            if (selected.rateBytesPerSecond) {
              const targetMs = (trial.encodedBytesWritten + segment.byteLength) / selected.rateBytesPerSecond * 1000;
              const waitMs = targetMs - (performance.now() - started);
              if (waitMs > 0) {
                const waitStarted = performance.now(); trial.paceWaitCount++;
                try { await sleep(waitMs, undefined, { signal: controller.signal }); }
                finally { trial.paceWaitMs += performance.now() - waitStarted; }
              }
            }
            controller.signal.throwIfAborted();
            if (response.destroyed) throw new DOMException('Research stream disconnected', 'AbortError');
            const atMs = performance.now() - started, accepted = response.write(segment);
            if (trial.firstEntityOutputAtMs === null) { trial.firstEntityOutputAtMs = atMs; trial.firstEntityOutputBytes = segment.byteLength; }
            trial.encodedBytesWritten += segment.byteLength; encodedHash.update(segment);
            trial.maxResponseSegmentBytes = Math.max(trial.maxResponseSegmentBytes, segment.byteLength);
            if (!accepted) {
              const waitStarted = performance.now(); trial.responseDrainWaitCount++;
              try { await waitForDrain(response, controller.signal); }
              finally { trial.responseDrainWaitMs += performance.now() - waitStarted; }
            }
          }
        }
        const source = Readable.from(generateChunks(), { objectMode: false, highWaterMark: MAX_SEGMENT_BYTES });
        const sink = new Writable({ highWaterMark: MAX_SEGMENT_BYTES,
          write(buffer, encoding, callback) { writeEncoded(buffer).then(() => callback(), callback); },
          final(callback) {
            if (controller.signal.aborted || response.destroyed) return callback(new DOMException('Research stream cancelled', 'AbortError'));
            response.end(callback);
          },
        });
        if (selected.codec !== 'identity') {
          gzip = createGzip({ level: selected.codec === 'gzip-1' ? 1 : 6, chunkSize: MAX_SEGMENT_BYTES,
            highWaterMark: MAX_SEGMENT_BYTES, flush: zlibConstants.Z_SYNC_FLUSH, finishFlush: zlibConstants.Z_FINISH });
          gzip.on('drain', () => { trial.gzipDrainEvents++; });
          await pipeline(source, gzip, sink, { signal: controller.signal });
        } else await pipeline(source, sink, { signal: controller.signal });
        if (controller.signal.aborted || !response.writableFinished) throw new DOMException('Research stream cancelled', 'AbortError');
        trial.status = 'completed';
      }
    } catch (error) {
      trial.status = controller.signal.aborted ? 'cancelled' : 'failed';
      trial.errorName = error.name ?? 'Error'; trial.errorCode = error.code ?? null;
      if (!response.destroyed) response.destroy();
    } finally {
      response.off('close', cancelled);
      trial.totalMs = performance.now() - started; trial.cpuProcessDeltaMicroseconds = process.cpuUsage(cpuStarted);
      trial.rawSha256 = rawHash.digest('hex'); trial.encodedWrittenSha256 = encodedHash.digest('hex');
      if (active === trial) active = null;
    }
  });
  return {
    server,
    setTransport(next) { if (active) throw new Error('Cannot change research transport during an active stream'); transport = normalizeTransport(next, transport); return { ...transport }; },
    getTransport() { return { ...transport }; },
    getTrials() { return structuredClone(trials); },
  };
}
