import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createNdjsonParser, createNdjsonDecoder, createNdjsonPullDecoder, parseNdjson, packBatch, generateRecords, createDetector, parseStreamCountHeader, verifyStreamRecordCount } from '../public/js/data.js';
import { streamURL, transportReceipt } from '../public/js/transport.js';

const encode = value => new TextEncoder().encode(value);
const drain = parser => { const out = []; while (parser.hasPendingInput) out.push(...parser.drain(1)); return out; };
const records = count => [...generateRecords({ count, seed: 91 })];
const lines = count => records(count).map(JSON.stringify).join('\n');

test('legacy string/UTF8/pull decoders preserve JSON null; whitespace alone is absent', () => {
  const text = '\r\nnull\n \nfalse\n0\n""\n[]\n{}\nnull';
  const expected = [null, false, 0, '', [], {}, null];
  assert.deepEqual(parseNdjson(text), expected);
  for (let boundary = 0; boundary <= text.length; boundary++) {
    const legacy = createNdjsonParser();
    assert.deepEqual([...legacy.push(text.slice(0, boundary)), ...legacy.push(text.slice(boundary)), ...legacy.finish()], expected);
    const bytes = encode(text), decoder = createNdjsonDecoder();
    assert.deepEqual([...decoder.push(bytes.subarray(0, boundary)), ...decoder.push(bytes.subarray(boundary)), ...decoder.finish()], expected);
    const pull = createNdjsonPullDecoder(), actual = [];
    pull.push(bytes.subarray(0, boundary)); actual.push(...drain(pull));
    pull.push(bytes.subarray(boundary)); actual.push(...drain(pull)); pull.finishInput(); actual.push(...drain(pull));
    assert.deepEqual(actual, expected); assert.equal(pull.lineNumber, 9);
  }
});

test('null reaches record validation in the legacy full-load path instead of silently disappearing', () => {
  for (const text of ['null', 'null\n', '\n null \r\n', lines(1) + '\nnull']) {
    const decoded = parseNdjson(text); assert.ok(decoded.includes(null));
    assert.throws(() => packBatch(decoded), /expected an object/);
  }
});

async function runWorker({ body, countHeader, chunkBytes = 65536 }) {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    global.fetch = async () => {
      let offset = 0;
      const headers = new Headers({ 'content-type': 'application/x-ndjson' });
      if (workerData.countHeader !== undefined) headers.set('x-stream-count', workerData.countHeader);
      return { ok: true, headers, body: { getReader: () => ({
        async read() { if (offset >= workerData.bytes.length) return { done: true };
          const value = workerData.bytes.subarray(offset, offset + workerData.chunkBytes); offset += value.length; return { done: false, value }; },
        async cancel() {}, releaseLock() { parentPort.postMessage({ type: 'released' }); }
      }) } };
    };
    global.self = { postMessage: (message, transfer) => parentPort.postMessage(message, transfer),
      addEventListener: (_type, handler) => parentPort.on('message', data => handler({ data })) };
    import(workerData.moduleURL).then(() => parentPort.postMessage({ type: 'ready' }));
  `, { eval: true, workerData: { bytes: encode(body), countHeader, chunkBytes, moduleURL: new URL('../public/js/stream-worker.js', import.meta.url).href } });
  const seen = [];
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Contract Worker timeout')), 5000);
      worker.on('error', error => { clearTimeout(timer); reject(error); });
      worker.on('message', message => {
        seen.push(message);
        if (message.type === 'ready') worker.postMessage({ type: 'start', runId: 'contract', mode: 'fixed', batchSize: 256, url: 'https://fixture.invalid/stream?count=999999' });
        if (message.type === 'batch') worker.postMessage({ type: 'ack', runId: 'contract' });
        if (message.type === 'released') { clearTimeout(timer); resolve(); }
      });
    });
    return seen;
  } finally { await worker.terminate(); }
}

test('actual Worker rejects null for newline, EOF tail, fragmented and prefixed bodies, never done', async () => {
  for (const body of ['null\n', 'null', '\n null \r\n', lines(256) + '\nnull']) {
    const count = body.startsWith('{') ? 257 : 1;
    const seen = await runWorker({ body, countHeader: String(count), chunkBytes: body.length > 100 ? 65536 : 1 });
    assert.match(seen.find(m => m.type === 'error')?.message ?? '', /expected an object/);
    assert.equal(seen.some(m => m.type === 'done'), false);
    assert.equal(seen.filter(m => m.type === 'batch').reduce((n, m) => n + m.batch.featureCount, 0), count === 257 ? 256 : 0);
  }
});

test('actual Worker exact record count includes final Unicode tail and ignores physical blank lines', async () => {
  const rows = records(3).map((r, i) => ({ ...r, region: `区🌐${i}` }));
  const body = '\n' + rows.map(JSON.stringify).join('\r\n\n') + '  ';
  const seen = await runWorker({ body, countHeader: '3', chunkBytes: 1 });
  assert.equal(seen.some(m => m.type === 'error'), false);
  const done = seen.find(m => m.type === 'done');
  assert.equal(done.metrics.expected, 3); assert.equal(done.metrics.parsed, 3); assert.equal(done.metrics.delivered, 3);
});

test('actual Worker declared zero succeeds only with an empty/whitespace response', async () => {
  for (const body of ['', '\r\n \n']) {
    const seen = await runWorker({ body, countHeader: '0' }), done = seen.find(m => m.type === 'done');
    assert.equal(done.metrics.expected, 0); assert.equal(done.metrics.parsed, 0); assert.equal(done.metrics.delivered, 0);
  }
  const seen = await runWorker({ body: lines(1), countHeader: '0' });
  assert.match(seen.find(m => m.type === 'error')?.message ?? '', /expected 0 records, received 1/);
  assert.equal(seen.some(m => m.type === 'done'), false);
});

test('actual Worker fewer/extra records fail at EOF while already ACKed prefixes remain delivered', async () => {
  for (const expected of [256, 258]) {
    const seen = await runWorker({ body: lines(257) + '\n', countHeader: String(expected) });
    assert.match(seen.find(m => m.type === 'error')?.message ?? '', new RegExp(`expected ${expected} records, received 257`));
    assert.equal(seen.some(m => m.type === 'done'), false);
    assert.equal(seen.filter(m => m.type === 'batch').reduce((n, m) => n + m.batch.featureCount, 0), 256);
    assert.ok(seen.some(m => m.phase === 'response-body-eof'));
  }
  const empty = await runWorker({ body: '', countHeader: '1' });
  assert.match(empty.find(m => m.type === 'error')?.message ?? '', /expected 1 records, received 0/);
});

test('missing or malformed count is unknown; URL progress count is not enforced as an exact contract', async () => {
  for (const countHeader of [undefined, '', '-1', '1.5', '1e3', 'Infinity', 'NaN', '9007199254740992']) {
    const seen = await runWorker({ body: lines(2), countHeader });
    assert.equal(seen.some(m => m.type === 'error'), false);
    const done = seen.find(m => m.type === 'done'); assert.equal(done.metrics.expected, null); assert.equal(done.metrics.delivered, 2);
  }
});

// Execute the production function body. Only network/UI/GL commit boundaries
// are controlled; parser, record packing and shared EOF contract remain real.
async function runBaseline({ body, countHeader }) {
  const source = await readFile(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function loadBaseline(current) {');
  const end = source.indexOf('\nasync function finishRun(current)', start);
  assert.ok(start >= 0 && end > start);
  const headers = { 'content-type': 'application/x-ndjson' };
  if (countHeader !== undefined) headers['x-stream-count'] = countHeader;
  const current = { config: { count: 999999, seed: 91, delay: 0, chunk: 512, mode: 'baseline', compression: 'identity' }, started: performance.now(), cancelled: false };
  const result = { commits: [], completed: false, errors: [], current };
  const context = vm.createContext({ run: current, AbortController, TextEncoder, performance, parseNdjson, packBatch, createDetector,
    parseStreamCountHeader, verifyStreamRecordCount, streamURL, transportReceipt, setState() {},
    fetch: async () => new Response(body, { headers }),
    commitBatch: async (_current, batch) => result.commits.push(batch.featureCount),
    finishRun: () => { result.completed = true; }, failRun: (_current, error) => result.errors.push(error.message),
  });
  vm.runInContext(source.slice(start, end), context); await context.loadBaseline(current); return result;
}

test('production baseline uses the same explicit EOF count contract before pack/commit', async () => {
  for (const countHeader of ['1', '3', '0']) {
    const result = await runBaseline({ body: lines(2), countHeader });
    assert.equal(result.completed, false); assert.deepEqual(result.commits, []);
    assert.match(result.errors[0], new RegExp(`expected ${countHeader} records, received 2`));
  }
  for (const countHeader of [undefined, '2', '', 'not-an-integer']) {
    const result = await runBaseline({ body: lines(2), countHeader });
    assert.equal(result.completed, true); assert.deepEqual(result.errors, []); assert.deepEqual(result.commits, [2]);
    assert.equal(result.current.workerMetrics.expected, countHeader === '2' ? 2 : null);
  }
});

test('production baseline rejects null object records and accepts an explicitly empty stream', async () => {
  const invalid = await runBaseline({ body: 'null', countHeader: '1' });
  assert.equal(invalid.completed, false); assert.deepEqual(invalid.commits, []); assert.match(invalid.errors[0], /expected an object/);
  const empty = await runBaseline({ body: '\n \n', countHeader: '0' });
  assert.equal(empty.completed, true); assert.deepEqual(empty.errors, []); assert.deepEqual(empty.commits, [0]);
  assert.equal(empty.current.workerMetrics.expected, 0);
});
