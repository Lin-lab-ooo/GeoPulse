import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createGunzip, gunzipSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import { generateRecords, createNdjsonDecoder } from '../public/js/data.js';
import { createHttpStreamResearchServer } from '../tools/fixtures/http-stream-research-2.1.mjs';

const sha = buffer => createHash('sha256').update(buffer).digest('hex');
const rawRecords = options => Buffer.from([...generateRecords(options)].map(record => JSON.stringify(record)).join('\n') + '\n');
async function withFixture(options, action) {
  const fixture = createHttpStreamResearchServer(options);
  await new Promise(resolve => fixture.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fixture.server.address().port}`;
  try { return await action(fixture, origin); }
  finally { fixture.server.closeAllConnections?.(); await new Promise(resolve => fixture.server.close(resolve)); }
}
function rawRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, options, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
      response.once('aborted', () => reject(new Error('HTTP response aborted'))); response.once('error', reject);
    });
    request.once('error', reject); request.end();
  });
}
async function settledTrial(fixture, index) {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    const trial = fixture.getTrials()[index];
    if (trial && trial.status !== 'running') return trial;
    await sleep(5);
  }
  throw new Error('Research trial failed to settle');
}

test('research wrapper delegates unchanged application/static routes and validates transport', async () => {
  await withFixture({}, async (fixture, origin) => {
    const script = await rawRequest(origin + '/js/stream-worker.js');
    assert.equal(script.status, 200); assert.match(script.headers['content-type'], /javascript/);
    assert.match(script.bytes.toString(), /Exactly one unacknowledged/);
    const environment = JSON.parse((await rawRequest(origin + '/api/environment')).bytes);
    assert.match(environment.sourceFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(fixture.getTrials(), []);
    assert.throws(() => fixture.setTransport({ codec: 'brotli' }), /codec/);
    assert.throws(() => fixture.setTransport({ rateBytesPerSecond: -1 }), /rateBytesPerSecond/);
    assert.throws(() => fixture.setTransport({ rateBytesPerSecond: Infinity }), /rateBytesPerSecond/);
    assert.deepEqual(fixture.setTransport({ codec: 'gzip-1', rateBytesPerSecond: 12345 }), { codec: 'gzip-1', rateBytesPerSecond: 12345 });
  });
});

for (const codec of ['identity', 'gzip-1', 'gzip-6']) {
  test(`${codec} stream preserves exact NDJSON SHA, backpressure receipts and successful gzip EOF`, async () => {
    await withFixture({ transport: { codec } }, async (fixture, origin) => {
      const options = { count: 2500, seed: 77, chunk: 512, delay: 0 }, expected = rawRecords(options);
      const result = await rawRequest(origin + '/api/stream?' + new URLSearchParams(options));
      assert.equal(result.status, 200); assert.equal(result.headers['x-stream-count'], '2500');
      const decoded = codec === 'identity' ? result.bytes : gunzipSync(result.bytes);
      assert.equal(Buffer.compare(decoded, expected), 0);
      if (codec !== 'identity') {
        assert.equal(result.headers['content-encoding'], 'gzip');
        assert.deepEqual([...result.bytes.subarray(0, 3)], [31, 139, 8]);
        assert.equal(result.bytes.readUInt32LE(result.bytes.length - 4), expected.length >>> 0, 'successful EOF contains the full gzip ISIZE trailer');
        assert.throws(() => gunzipSync(result.bytes.subarray(0, -8)), /unexpected end|buffer error/i, 'truncated trailer must not masquerade as success');
      }
      const trial = await settledTrial(fixture, 0);
      assert.equal(trial.status, 'completed'); assert.equal(trial.producedRecords, options.count);
      assert.equal(trial.serviceChunks, Math.ceil(options.count / options.chunk));
      assert.equal(trial.rawBytesProduced, expected.length); assert.equal(trial.rawSha256, sha(expected));
      assert.equal(trial.encodedBytesWritten, result.bytes.length); assert.equal(trial.encodedBytesProduced, result.bytes.length);
      assert.equal(trial.encodedWrittenSha256, sha(result.bytes));
      assert.ok(trial.maxResponseSegmentBytes <= 16384); assert.ok(trial.firstEntityOutputAtMs >= 0 && trial.firstEntityOutputAtMs <= trial.responseFinishedAtMs);
      assert.ok(trial.generationEncodingWallMs > 0); assert.ok(trial.cpuProcessDeltaMicroseconds.user >= 0 && trial.cpuProcessDeltaMicroseconds.system >= 0);
      assert.match(trial.scope.cpu, /whole trial/); assert.match(trial.scope.pace, /not a real network/);
      const copy = fixture.getTrials(); copy[0].status = 'changed'; assert.equal(fixture.getTrials()[0].status, 'completed');
    });
  });
}

for (const codec of ['gzip-1', 'gzip-6']) {
  test(`${codec} SYNC_FLUSH exposes parsed records before EOF and client cancellation stops production`, async () => {
    await withFixture({ transport: { codec } }, async (fixture, origin) => {
      const first = await new Promise((resolve, reject) => {
        const request = http.get(origin + '/api/stream?count=5000&seed=77&chunk=100&delay=20', response => {
          const inflate = createGunzip(), decoder = createNdjsonDecoder();
          response.on('error', () => {}); inflate.on('error', reject); response.pipe(inflate);
          inflate.on('data', bytes => {
            const records = decoder.push(bytes);
            if (records.length) {
              const current = fixture.getTrials()[0];
              resolve({ records: records.length, producedAtFirstRead: current.producedRecords });
              response.unpipe(inflate); inflate.destroy(); response.destroy(); request.destroy();
            }
          });
        });
        request.on('error', () => {});
      });
      assert.ok(first.records > 0 && first.records < 5000); assert.ok(first.producedAtFirstRead < 5000);
      const trial = await settledTrial(fixture, 0);
      assert.equal(trial.status, 'cancelled'); assert.ok(trial.producedRecords < 5000); assert.ok(trial.encodedBytesWritten > 0);
    });
  });
}

test('entity-byte pacing obeys cumulative deadlines and identity writes exercise response drain backpressure', async () => {
  await withFixture({ transport: { codec: 'identity', rateBytesPerSecond: 100000 } }, async (fixture, origin) => {
    const result = await rawRequest(origin + '/api/stream?count=512&seed=77&chunk=512&delay=0');
    const trial = await settledTrial(fixture, 0);
    assert.equal(trial.status, 'completed'); assert.equal(trial.encodedBytesWritten, result.bytes.length);
    assert.ok(trial.totalMs >= result.bytes.length / 100000 * 1000 - 10, 'server cannot emit the complete entity before its cumulative byte deadline');
    assert.ok(trial.paceWaitCount > 0 && trial.paceWaitMs > 0);
    assert.ok(trial.responseDrainWaitCount > 0, 'a 16KiB response highWaterMark must use the drain path for complete segments');
    assert.equal(trial.maxResponseSegmentBytes, 16384);
  });
});

test('a disconnected paced stream cancels its pending deadline and permits the next serial trial', async () => {
  await withFixture({ transport: { codec: 'identity', rateBytesPerSecond: 4096 } }, async (fixture, origin) => {
    await new Promise(resolve => {
      const request = http.get(origin + '/api/stream?count=100000&seed=77&chunk=512&delay=0', response => {
        response.on('error', () => {});
        setTimeout(() => { response.destroy(); request.destroy(); resolve(); }, 30);
      }); request.on('error', () => {});
    });
    const trial = await settledTrial(fixture, 0);
    assert.equal(trial.status, 'cancelled'); assert.ok(trial.producedRecords < 100000); assert.ok(trial.totalMs < 1500);
    assert.ok(trial.paceWaitCount > 0 && trial.paceWaitMs > 0);
    fixture.setTransport({ codec: 'gzip-6', rateBytesPerSecond: 0 });
    const next = await rawRequest(origin + '/api/stream?count=10&seed=77&chunk=10&delay=0');
    assert.equal(gunzipSync(next.bytes).toString(), rawRecords({ count: 10, seed: 77 }).toString());
    assert.equal((await settledTrial(fixture, 1)).status, 'completed');
  });
});

test('HEAD sends stream headers without generation, body or a gzip member', async () => {
  await withFixture({}, async (fixture, origin) => {
    for (const [index, codec] of ['identity', 'gzip-1', 'gzip-6'].entries()) {
      fixture.setTransport({ codec });
      const result = await rawRequest(origin + '/api/stream?count=1000&seed=77', { method: 'HEAD' });
      assert.equal(result.status, 200); assert.equal(result.bytes.length, 0); assert.equal(result.headers['x-stream-count'], '1000');
      if (codec !== 'identity') assert.equal(result.headers['content-encoding'], 'gzip');
      const trial = await settledTrial(fixture, index);
      assert.equal(trial.status, 'head-completed'); assert.equal(trial.producedRecords, 0);
      assert.equal(trial.rawBytesProduced, 0); assert.equal(trial.encodedBytesWritten, 0); assert.equal(trial.firstEntityOutputAtMs, null);
      assert.equal(trial.rawSha256, sha(Buffer.alloc(0)));
    }
  });
});

test('stream validation and serial-only admission reject bad requests without changing transport', async () => {
  await withFixture({ transport: { codec: 'gzip-6', rateBytesPerSecond: 4096 } }, async (fixture, origin) => {
    assert.equal((await rawRequest(origin + '/api/stream?count=0')).status, 400);
    assert.equal((await rawRequest(origin + '/api/stream', { method: 'POST' })).status, 405);
    const active = await new Promise(resolve => {
      const request = http.get(origin + '/api/stream?count=100000&chunk=512&delay=0', response => { response.on('error', () => {}); resolve({ request, response }); });
      request.on('error', () => {});
    });
    assert.throws(() => fixture.setTransport('identity'), /active stream/);
    assert.equal((await rawRequest(origin + '/api/stream?count=1')).status, 409);
    active.response.destroy(); active.request.destroy();
    assert.equal((await settledTrial(fixture, 0)).status, 'cancelled');
    assert.equal(fixture.getTrials().length, 1);
  });
});

test('generation errors fail the pipeline without reporting a complete stream or leaking the active slot', async () => {
  function* brokenGenerator(options) { yield* generateRecords({ ...options, count: 1 }); throw new Error('injected test failure'); }
  await withFixture({ transport: { codec: 'gzip-6' }, recordGenerator: brokenGenerator }, async (fixture, origin) => {
    await assert.rejects(rawRequest(origin + '/api/stream?count=1000&chunk=1&delay=0'), /aborted|reset|socket hang up/i);
    const trial = await settledTrial(fixture, 0);
    assert.equal(trial.status, 'failed'); assert.equal(trial.producedRecords, 1); assert.equal(trial.responseFinishedAtMs, null);
    assert.equal(trial.errorName, 'Error'); fixture.setTransport('identity');
    const head = await rawRequest(origin + '/api/stream?count=1', { method: 'HEAD' }); assert.equal(head.status, 200);
  });
});
