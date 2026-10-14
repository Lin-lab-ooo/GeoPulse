import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { setTimeout as sleep } from 'node:timers/promises';
import { generateRecords } from '../public/js/data.js';

function waitForMessage(worker, predicate, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); worker.off('message', message); worker.off('error', failure); };
    const message = value => { if (predicate(value)) { cleanup(); resolve(value); } };
    const failure = error => { cleanup(); reject(error); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for Worker message')); }, timeout);
    worker.on('message', message);
    worker.on('error', failure);
  });
}

async function createMockWorker({ count, clockOffset = 0 }) {
  const bytes = new TextEncoder().encode([...generateRecords({ count, seed: 77 })].map(record => JSON.stringify(record)).join('\n'));
  const moduleUrl = new URL('../public/js/stream-worker.js', import.meta.url).href;
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    const { setTimeout: sleep } = require('node:timers/promises');
    const originalPerformance = global.performance;
    const offset = ${clockOffset};
    Object.defineProperty(global, 'performance', { value: {
      timeOrigin: originalPerformance.timeOrigin - offset,
      now: () => originalPerformance.now() + offset
    }, configurable: true });
    global.fetch = async () => {
      await sleep(5);
      let readCount = 0;
      return {
        ok: true,
        headers: { get: key => key === 'content-type' ? 'application/x-ndjson' : key === 'x-stream-count' ? '${count}' : null },
        body: { getReader: () => ({
          read: async () => {
            await sleep(5);
            return readCount++ === 0 ? { done: false, value: Uint8Array.from(${JSON.stringify([...bytes])}) } : { done: true };
          },
          cancel: async () => {}, releaseLock: () => {}
        }) }
      };
    };
    global.self = {
      postMessage: (message, transfer) => parentPort.postMessage(message, transfer),
      addEventListener: (_type, handler) => parentPort.on('message', data => handler({ data }))
    };
    import(${JSON.stringify(moduleUrl)}).then(() => parentPort.postMessage({ type: 'ready' }));
  `, { eval: true });
  await waitForMessage(worker, message => message.type === 'ready');
  return { worker, byteLength: bytes.byteLength };
}

test('Worker observes reader EOF before final partial batch ACK and keeps main-relative clocks across origins', async () => {
  const { worker, byteLength } = await createMockWorker({ count: 64, clockOffset: 777000 });
  try {
    const messages = [];
    worker.on('message', message => messages.push(message));
    const batchPromise = waitForMessage(worker, message => message.type === 'batch');
    const mainStartedEpochMs = performance.timeOrigin + performance.now();
    worker.postMessage({ type: 'start', runId: 'early-eof', url: 'mock-stream', mode: 'fixed', batchSize: 256, mainStartedEpochMs });
    const batch = await batchPromise;
    const timingMessages = messages.filter(message => message.type === 'network-timing');
    assert.deepEqual(timingMessages.map(message => message.phase), ['first-byte', 'response-body-eof']);
    assert.ok(messages.indexOf(timingMessages[1]) < messages.indexOf(batch), 'EOF signal must precede the final partial batch');
    const eof = timingMessages[1];
    assert.equal(eof.bytes, byteLength);
    assert.equal(eof.parsed, 63, 'unterminated final line is parsed after reader EOF');
    assert.equal(eof.delivered, 0, 'partial batch is sent only after EOF');
    assert.equal(batch.batch.featureCount, 64);
    assert.equal(eof.timing.mainClockAvailable, true);
    assert.equal(eof.timing.schemaVersion, '1.0');
    assert.ok(eof.timing.responseHeadersAtMs >= 0);
    assert.ok(eof.timing.firstByteAtMs >= eof.timing.responseHeadersAtMs);
    assert.ok(eof.timing.responseBodyEofAtMs >= eof.timing.firstByteAtMs);
    assert.ok(eof.timing.responseBodyEofAtMs <= performance.timeOrigin + performance.now() - mainStartedEpochMs);
    assert.ok(eof.timing.responseBodyEofWorkerElapsedMs >= 0);
    assert.equal(eof.timing.readerReadCalls, 2);
    assert.match(eof.timing.scope.responseBodyEof, /ACK backpressure/);
    assert.match(eof.timing.scope.ackWait, /not GPU completion/);
    await sleep(80);
    assert.equal(messages.filter(message => message.type === 'done').length, 0);
    const donePromise = waitForMessage(worker, message => message.type === 'done');
    worker.postMessage({ type: 'ack', runId: 'early-eof' });
    const done = await donePromise;
    assert.equal(done.metrics.bytes, byteLength);
    assert.equal(done.metrics.parsed, 64);
    assert.equal(done.metrics.delivered, 64);
    assert.equal(done.metrics.networkTiming.ackWaitCount, 1);
    assert.ok(done.metrics.networkTiming.ackWaitMs >= 75);
    assert.equal(done.metrics.networkTiming.ackWaitMs, done.metrics.networkTiming.maxAckWaitMs);
    assert.ok(done.metrics.networkTiming.workerDoneAtMs >= eof.timing.responseBodyEofAtMs + 75);
    assert.ok(done.metrics.parseMs > 0 && done.metrics.packMs > 0);
  } finally {
    await worker.terminate();
  }
});

test('Worker reader EOF remains paced by full-batch ACKs and does not turn timing into prefetch', async () => {
  const { worker } = await createMockWorker({ count: 513 });
  try {
    const messages = [];
    worker.on('message', message => messages.push(message));
    const firstPromise = waitForMessage(worker, message => message.type === 'batch');
    const mainStartedEpochMs = performance.timeOrigin + performance.now();
    worker.postMessage({ type: 'start', runId: 'paced-eof', url: 'mock-stream', mode: 'fixed', batchSize: 256, mainStartedEpochMs });
    assert.equal((await firstPromise).batch.featureCount, 256);
    await sleep(60);
    assert.equal(messages.filter(message => message.type === 'batch').length, 1);
    assert.equal(messages.filter(message => message.phase === 'response-body-eof').length, 0, 'Worker cannot read EOF during its unacknowledged batch');
    const secondPromise = waitForMessage(worker, message => message.type === 'batch');
    worker.postMessage({ type: 'ack', runId: 'paced-eof' });
    assert.equal((await secondPromise).batch.featureCount, 256);
    await sleep(60);
    assert.equal(messages.filter(message => message.phase === 'response-body-eof').length, 0);
    const thirdPromise = waitForMessage(worker, message => message.type === 'batch');
    worker.postMessage({ type: 'ack', runId: 'paced-eof' });
    assert.equal((await thirdPromise).batch.featureCount, 1);
    const eof = messages.find(message => message.phase === 'response-body-eof');
    assert.ok(eof.timing.responseBodyEofAtMs >= 115, 'EOF includes the intentional ACK delays');
    assert.equal(eof.delivered, 512);
    assert.equal(eof.timing.ackWaitCount, 2);
    const donePromise = waitForMessage(worker, message => message.type === 'done');
    worker.postMessage({ type: 'ack', runId: 'paced-eof' });
    const done = await donePromise;
    assert.equal(done.metrics.parsed, 513);
    assert.equal(done.metrics.delivered, 513);
    assert.equal(done.metrics.batches, 3);
    assert.equal(done.metrics.maxPendingBatches, 1);
    assert.equal(done.metrics.networkTiming.ackWaitCount, 3);
    assert.ok(done.metrics.networkTiming.ackWaitMs >= 115);
  } finally {
    await worker.terminate();
  }
});

test('fixed Worker keeps the default 2048 batch size and independent buffers across ACK-driven reuse', async () => {
  const { worker } = await createMockWorker({ count: 4097 });
  try {
    const messages = [];
    worker.on('message', message => messages.push(message));
    const firstPromise = waitForMessage(worker, message => message.type === 'batch');
    worker.postMessage({ type: 'start', runId: 'fixed-default', url: 'mock-stream', mode: 'fixed' });
    const first = await firstPromise;
    assert.equal(first.batch.featureCount, 2048);
    const firstBytes = first.batch.groups.map(group => ({
      positions: new Uint8Array(group.positions.buffer).slice(),
      colors: group.colors.slice(), ids: new Uint8Array(group.ids.buffer).slice(),
    }));
    await sleep(30);
    assert.equal(messages.filter(message => message.type === 'batch').length, 1);
    const secondPromise = waitForMessage(worker, message => message.type === 'batch');
    worker.postMessage({ type: 'ack', runId: 'fixed-default', batchSize: 256 });
    assert.equal((await secondPromise).batch.featureCount, 2048, 'fixed mode must ignore adaptive batch-size feedback');
    const tailPromise = waitForMessage(worker, message => message.type === 'batch');
    worker.postMessage({ type: 'ack', runId: 'fixed-default', batchSize: 16384 });
    const tail = await tailPromise;
    assert.equal(tail.batch.featureCount, 1);
    assert.equal(messages.find(message => message.phase === 'response-body-eof').delivered, 4096);
    const donePromise = waitForMessage(worker, message => message.type === 'done');
    worker.postMessage({ type: 'ack', runId: 'fixed-default' });
    const done = await donePromise;
    assert.deepEqual([done.metrics.parsed, done.metrics.delivered, done.summary.total, done.metrics.batches], [4097, 4097, 4097, 3]);
    assert.equal(done.metrics.maxPendingBatches, 1);
    assert.equal(done.metrics.networkTiming.ackWaitCount, 3);
    for (let i = 0; i < first.batch.groups.length; i += 1) {
      const group = first.batch.groups[i], expected = firstBytes[i];
      assert.deepEqual(new Uint8Array(group.positions.buffer), expected.positions);
      assert.deepEqual(group.colors, expected.colors);
      assert.deepEqual(new Uint8Array(group.ids.buffer), expected.ids);
    }
  } finally {
    await worker.terminate();
  }
});

for (const invalidEpoch of [undefined, null, 'epoch', NaN, Infinity]) {
  test(`Worker leaves main-relative timing unavailable for malformed epoch ${String(invalidEpoch)}`, async () => {
    const { worker } = await createMockWorker({ count: 1 });
    try {
      const batchPromise = waitForMessage(worker, message => message.type === 'batch');
      worker.postMessage({ type: 'start', runId: 'no-epoch', url: 'mock-stream', mode: 'fixed', mainStartedEpochMs: invalidEpoch });
      const batch = await batchPromise;
      const timing = batch.metrics.networkTiming;
      assert.equal(timing.mainClockAvailable, false);
      assert.equal(timing.responseHeadersAtMs, null);
      assert.equal(timing.firstByteAtMs, null);
      assert.equal(timing.responseBodyEofAtMs, null);
      assert.ok(timing.firstByteWorkerElapsedMs >= 0);
      assert.ok(timing.responseBodyEofWorkerElapsedMs >= timing.firstByteWorkerElapsedMs);
      const donePromise = waitForMessage(worker, message => message.type === 'done');
      worker.postMessage({ type: 'ack', runId: 'no-epoch' });
      const done = await donePromise;
      assert.equal(done.metrics.networkTiming.workerDoneAtMs, null);
      assert.equal(done.metrics.delivered, 1);
    } finally {
      await worker.terminate();
    }
  });
}
