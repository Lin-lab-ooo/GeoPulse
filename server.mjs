import http from 'node:http';
import os from 'node:os';
import { createReadStream } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, constants as zlibConstants } from 'node:zlib';
import { stat, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep, setImmediate as yieldEventLoop } from 'node:timers/promises';
import { generateRecords, DEFAULT_STREAM, REFERENCE_CENTER } from './public/js/data.js';
import { validatePoiSnapshot } from './public/js/baidu-poi-cache.js';
import { IMPLEMENTATION_VERSION } from './public/js/version.js';

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_ROOT = path.join(SOURCE_ROOT, 'reports');
export { IMPLEMENTATION_VERSION };
// Raw callback/camera experiments are exported per runId using compact JSON.
// Keep a bounded request size; reject oversized reports without dropping samples.
export const REPORT_MAX_BYTES = 160 * 1024 * 1024;
const PUBLIC_ROOT = path.join(SOURCE_ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };

/** Hash exact implementation bytes with sorted, root-relative names; exclude reports and credentials. */
export async function computeSourceFingerprint(sourceRoot = SOURCE_ROOT) {
  const files = ['server.mjs', 'public/index.html', 'public/styles.css', 'public/enhancements.css'];
  async function collectJs(relativeDirectory) {
    for (const entry of await readdir(path.join(sourceRoot, relativeDirectory), { withFileTypes: true })) {
      const relativeName = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) await collectJs(relativeName);
      else if (entry.isFile() && /\.m?js$/.test(entry.name)) files.push(relativeName);
    }
  }
  await collectJs('public/js');
  // Trained weights and replay inputs are part of the implemented AI experiment.
  try {
    for(const entry of await readdir(path.join(sourceRoot,'public/ai'),{withFileTypes:true})) {
      if(entry.isFile()&&entry.name.endsWith('.json'))files.push('public/ai/'+entry.name);
    }
  } catch(error) { if(error.code!=='ENOENT')throw error; }
  const hash = createHash('sha256');
  for (const relativeName of files.sort()) {
    const bytes = await readFile(path.join(sourceRoot, relativeName));
    // Explicit boundaries prevent concatenations of different filenames/contents from colliding structurally.
    hash.update(`${Buffer.byteLength(relativeName)}:${relativeName}:${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest('hex');
}


/** V2 covers every served public asset; legacy-v1 remains stable for archived experiments. */
export async function computeRuntimeFingerprint(sourceRoot = SOURCE_ROOT, { publicRoot = path.join(sourceRoot, 'public') } = {}) {
  const files = [['server.mjs', path.join(sourceRoot, 'server.mjs')], ['package.json', path.join(sourceRoot, 'package.json')]];
  async function collect(directory, relative) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name), name = relative + '/' + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Runtime fingerprint requires regular public files');
      if (entry.isDirectory()) await collect(absolute, name);
      else if (entry.isFile()) files.push([name, absolute]);
    }
  }
  await collect(publicRoot, 'public');
  const hash = createHash('sha256');
  hash.update('geopulse-runtime-v2\\0');
  for (const [name, absolute] of files.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) {
    const bytes = await readFile(absolute);
    hash.update(Buffer.byteLength(name) + ':' + name + ':' + bytes.length + ':');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(payload));
}
function integerParam(search, name, fallback, min, max) {
  const raw = search.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
export function parseStreamOptions(search) {
  return {
    count: integerParam(search, 'count', DEFAULT_STREAM.count, 1, 1000000),
    seed: integerParam(search, 'seed', DEFAULT_STREAM.seed, 0, 4294967295),
    chunk: integerParam(search, 'chunk', DEFAULT_STREAM.chunk, 1, 8192),
    delay: integerParam(search, 'delay', DEFAULT_STREAM.delay, 0, 1000),
  };
}
export function parseStreamCompression(search) {
  const value = search.get('compression') ?? 'identity';
  if (value !== 'identity' && value !== 'gzip') throw new RangeError('compression must be identity or gzip');
  return value;
}
function waitForDrain(response, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { response.off('drain', drained); response.off('close', closed); signal.removeEventListener('abort', closed); };
    const drained = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new Error('Stream disconnected')); };
    response.once('drain', drained);
    response.once('close', closed);
    signal.addEventListener('abort', closed, { once: true });
    if (signal.aborted || response.destroyed) closed();
  });
}

/** One continuous gzip member; flush service chunks without buffering the full input. */
async function writeCompressedStream(response, options, counters, signal) {
  async function* chunks() {
    const records = generateRecords(options); let emitted = 0;
    while (emitted < options.count) {
      signal.throwIfAborted();
      const size = Math.min(options.chunk, options.count - emitted), lines = [];
      for (let index = 0; index < size; index++) lines.push(JSON.stringify(records.next().value));
      const payload = Buffer.from(lines.join('\n') + '\n');
      emitted += size; counters.streamedFeatures += size; counters.streamedBytes += payload.length;
      yield payload;
      if (emitted < options.count) {
        if (options.delay) await sleep(options.delay, undefined, { signal });
        else await yieldEventLoop(undefined, { signal });
      }
    }
  }
  const source = Readable.from(chunks(), { objectMode: false, highWaterMark: 16384 });
  const gzip = createGzip({ level: 6, chunkSize: 16384, highWaterMark: 16384,
    flush: zlibConstants.Z_SYNC_FLUSH, finishFlush: zlibConstants.Z_FINISH });
  const sink = new Writable({ highWaterMark: 16384,
    write(buffer, encoding, callback) {
      (async () => {
        signal.throwIfAborted();
        if (response.destroyed) throw new Error('Stream disconnected');
        const accepted = response.write(buffer); counters.encodedEntityBytes += buffer.length;
        if (!accepted) await waitForDrain(response, signal);
      })().then(() => callback(), callback);
    },
    final(callback) {
      if (signal.aborted || response.destroyed) return callback(new Error('Stream disconnected'));
      response.end(callback);
    },
  });
  await pipeline(source, gzip, sink, { signal });
}

class ReportRequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateReport(report) {
  if (!isObject(report) || report.project !== 'GeoPulse' || report.schemaVersion !== '1.0') throw new ReportRequestError(400, 'Report must use project GeoPulse and schemaVersion 1.0');
  const preparationOnly = Array.isArray(report.loadingProtocols) && report.loadingProtocols.length > 0 &&
    report.loadingProtocols.every(protocol => isObject(protocol) && protocol.kind === 'loading-interaction-comparison' &&
      ['failed', 'cancelled'].includes(protocol.status) && Array.isArray(protocol.attempts) && protocol.attempts.length > 0 &&
      protocol.attempts.every(attempt => isObject(attempt) && ['failed', 'cancelled'].includes(attempt.status)));
  if (!Array.isArray(report.runs) || report.runs.length > 100 || (!report.runs.length && !preparationOnly)) throw new ReportRequestError(400, 'Report requires 1 to 100 measured runs, or explicit failed/cancelled loading preparation attempts');
  // Destination names are chosen exclusively by this server, including nested metadata.
  const forbidden = new Set(['path', 'filename', 'fileName', 'absolutePath', 'relativePath', 'reportsRoot']);
  const remaining = [report];
  while (remaining.length) {
    const value = remaining.pop();
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.has(key)) throw new ReportRequestError(400, 'Client-selected report paths and filenames are not allowed');
      if (child !== null && typeof child === 'object') remaining.push(child);
    }
  }
  for (const [index, run] of report.runs.entries()) {
    if (!isObject(run) || !isObject(run.config) || !isObject(run.metrics)) throw new ReportRequestError(400, `Report run ${index + 1} requires config and metrics objects`);
    if (!Number.isFinite(run.metrics.features) || run.metrics.features < 0) throw new ReportRequestError(400, `Report run ${index + 1} metrics.features must be a nonnegative number`);
  }
}

function checkReportOrigin(request) {
  if (request.headers.origin === undefined) return; // Local CLI clients have no browser Origin.
  try {
    const requestOrigin = new URL(`http://${request.headers.host}`).origin;
    const origin = new URL(request.headers.origin).origin;
    if (origin !== requestOrigin) throw new Error('Origin mismatch');
  } catch {
    throw new ReportRequestError(403, 'Report saves require a same-origin request');
  }
}

function readReportBody(request) {
  const advertised = request.headers['content-length'];
  if (advertised !== undefined && Number(advertised) > REPORT_MAX_BYTES) {
    request.resume();
    return Promise.reject(new ReportRequestError(413, `Report JSON exceeds the ${REPORT_MAX_BYTES / (1024 * 1024)} MiB limit`));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const cleanup = () => { request.off('data', data); request.off('end', end); request.off('error', error); request.off('aborted', aborted); };
    const fail = failure => { cleanup(); chunks.length = 0; request.resume(); reject(failure); };
    const data = chunk => {
      bytes += chunk.length;
      if (bytes > REPORT_MAX_BYTES) return fail(new ReportRequestError(413, `Report JSON exceeds the ${REPORT_MAX_BYTES / (1024 * 1024)} MiB limit`));
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks, bytes)); };
    const error = () => fail(new ReportRequestError(400, 'Unable to read report request body'));
    const aborted = () => fail(new ReportRequestError(400, 'Report request body was interrupted'));
    request.on('data', data);
    request.once('end', end);
    request.once('error', error);
    request.once('aborted', aborted);
  });
}

async function saveBrowserReport(request, response, reportsRoot) {
  try {
    checkReportOrigin(request);
    const mime = (request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
    if (mime !== 'application/json') throw new ReportRequestError(415, 'Report body must use application/json');
    const bytes = await readReportBody(request);
    let report;
    try { report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new ReportRequestError(400, 'Report body must be valid UTF-8 JSON'); }
    validateReport(report);
    const fileName = `verified-browser-${Date.now()}-${randomUUID()}.json`;
    const absolutePath = path.join(reportsRoot, fileName);
    await mkdir(reportsRoot, { recursive: true });
    await writeFile(absolutePath, bytes, { flag: 'wx' });
    sendJson(response, 201, { ok: true, fileName, relativePath: `reports/${fileName}`, absolutePath, savedAt: new Date().toISOString(), bytes: bytes.length });
  } catch (error) {
    request.resume();
    if (response.destroyed || response.headersSent) return;
    const status = error instanceof ReportRequestError ? error.status : 500;
    // Let Node flush a complete JSON error and close gracefully; never reset mid-response.
    if (status === 413) response.setHeader('Connection', 'close');
    sendJson(response, status, { error: error instanceof ReportRequestError ? error.message : 'Unable to save report on this server' });
  }
}
/** Native Node HTTP streaming server; no third-party runtime dependency. */
export function createServer({ publicRoot = PUBLIC_ROOT, reportsRoot = REPORTS_ROOT } = {}) {
  const counters = { activeStreams: 0, completedStreams: 0, cancelledStreams: 0, streamedFeatures: 0, streamedBytes: 0, encodedEntityBytes: 0, compressedStreams: 0 };
  const root = path.resolve(publicRoot);
  const reportRoot = path.resolve(reportsRoot);
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    let url;
    try { url = new URL(request.url, 'http://127.0.0.1'); } catch { return sendJson(response, 400, { error: 'Invalid URL' }); }
    if (url.pathname === '/api/reports') {
      if (request.method !== 'POST') {
        if (['GET', 'HEAD'].includes(request.method)) return sendJson(response, 404, { error: 'Report listing is unavailable' });
        response.setHeader('Allow', 'POST');
        return sendJson(response, 405, { error: 'Method not allowed' });
      }
      await saveBrowserReport(request, response, reportRoot);
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) { response.setHeader('Allow', 'GET, HEAD'); return sendJson(response, 405, { error: 'Method not allowed' }); }
    if (url.pathname === '/api/poi-sample') {
      const cacheFile = path.join(reportRoot, 'baidu-poi-cache.json');
      try {
        if ((await stat(cacheFile)).size > 1024 * 1024) return sendJson(response, 500, {error:'Local POI cache exceeds its size limit'});
        const snapshot = validatePoiSnapshot(JSON.parse(await readFile(cacheFile, 'utf8')));
        return sendJson(response, 200, snapshot);
      } catch (error) {
        return sendJson(response, error.code === 'ENOENT' ? 404 : 500, {error:'No valid local POI snapshot is available'});
      }
    }
    if (url.pathname === '/api/health') return sendJson(response, 200, { ok: true, service: 'geo-pulse', transport: 'http-ndjson' });
    if (url.pathname === '/api/environment') {
      const cpus = os.cpus();
      // Environment is requested outside measured loading. Recheck after edits instead of returning a stale startup digest.
      let legacyFingerprint, runtimeFingerprint;
      try { [legacyFingerprint, runtimeFingerprint] = await Promise.all([
        computeSourceFingerprint(), computeRuntimeFingerprint(SOURCE_ROOT, { publicRoot: root })
      ]); } catch { return sendJson(response, 500, { error: 'Unable to fingerprint implementation source' }); }
      return sendJson(response, 200, { scope: 'server-host', implementationVersion: IMPLEMENTATION_VERSION, sourceFingerprint: legacyFingerprint, sourceFingerprintAlgorithm: 'SHA-256', sourceFingerprintSchema: 'legacy-v1', runtimeFingerprint, runtimeFingerprintAlgorithm: 'SHA-256', runtimeFingerprintSchema: 'geopulse-runtime-v2', platform: os.platform(), release: os.release(), architecture: os.arch(), cpuModel: cpus[0]?.model ?? 'unknown', logicalCores: cpus.length, memoryTotalBytes: os.totalmem(), memoryFreeBytes: os.freemem(), node: process.version, referenceCenter: REFERENCE_CENTER });
    }
    if (url.pathname === '/api/metrics') return sendJson(response, 200, { scope: 'node-server-process', pid: process.pid, uptimeSeconds: process.uptime(), cpuMicroseconds: process.cpuUsage(), memoryBytes: process.memoryUsage(), streams: { ...counters }, collectedAt: new Date().toISOString() });
    if (url.pathname === '/api/stream') {
      let options, compression;
      try { options = parseStreamOptions(url.searchParams); compression = parseStreamCompression(url.searchParams); } catch (error) { return sendJson(response, 400, { error: error.message }); }
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Stream-Count': String(options.count), 'X-Stream-Seed': String(options.seed), 'X-Coordinate-System': 'local-baidu-mercator-meters', 'X-Stream-Compression': compression,
        ...(compression === 'gzip' ? { 'Content-Encoding': 'gzip' } : {}) });
      if (request.method === 'HEAD') return response.end();
      response.flushHeaders();
      const controller = new AbortController();
      const cancel = () => { if (!response.writableFinished) controller.abort(); };
      response.once('close', cancel);
      counters.activeStreams += 1;
      if (compression === 'gzip') counters.compressedStreams += 1;
      let complete = false;
      try {
        if (compression === 'gzip') {
          await writeCompressedStream(response, options, counters, controller.signal);
          complete = true;
        } else {
        const records = generateRecords(options);
        let emitted = 0;
        while (emitted < options.count && !controller.signal.aborted) {
          const lines = [];
          const chunkSize = Math.min(options.chunk, options.count - emitted);
          for (let index = 0; index < chunkSize; index += 1) lines.push(JSON.stringify(records.next().value));
          const payload = `${lines.join('\n')}\n`;
          const accepted = response.write(payload);
          counters.encodedEntityBytes += Buffer.byteLength(payload);
          emitted += chunkSize;
          counters.streamedFeatures += chunkSize;
          counters.streamedBytes += Buffer.byteLength(payload);
          if (!accepted) await waitForDrain(response, controller.signal);
          if (emitted < options.count) {
            if (options.delay) await sleep(options.delay, undefined, { signal: controller.signal });
            else await yieldEventLoop(undefined, { signal: controller.signal });
          }
        }
        if (!controller.signal.aborted && !response.destroyed) { complete = true; response.end(); }
        }
      } catch (error) {
        if (!controller.signal.aborted && !response.destroyed) response.destroy(error);
      } finally {
        response.off('close', cancel);
        counters.activeStreams -= 1;
        counters[complete ? 'completedStreams' : 'cancelledStreams'] += 1;
      }
      return;
    }
    if (url.pathname.startsWith('/api/')) return sendJson(response, 404, { error: 'Unknown API route' });
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return sendJson(response, 400, { error: 'Malformed path encoding' }); }
    if (pathname.includes('\0') || pathname.includes('\\')) return sendJson(response, 403, { error: 'Forbidden path' });
    const filePath = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    const relative = path.relative(root, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return sendJson(response, 403, { error: 'Forbidden path' });
    try {
      const info = await stat(filePath);
      if (!info.isFile()) return sendJson(response, 404, { error: 'File not found' });
      response.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
      if (request.method === 'HEAD') return response.end();
      const source = createReadStream(filePath);
      source.on('error', error => response.destroy(error));
      response.once('close', () => source.destroy());
      source.pipe(response);
    } catch (error) {
      if (!response.headersSent) sendJson(response, error.code === 'ENOENT' ? 404 : 500, { error: error.code === 'ENOENT' ? 'File not found' : 'Unable to read file' });
      else response.destroy(error);
    }
  });
  server.streamCounters = counters;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? 4173);
  const host = process.env.HOST ?? '127.0.0.1';
  const server = createServer();
  server.listen(port, host, () => console.log(`Geo Pulse: http://${host}:${port}`));
  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}


