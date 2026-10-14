import test from 'node:test';
import assert from 'node:assert/strict';
import { SpatialQueryClient } from '../public/js/spatial-query-client.js';
import { createRecordingRenderer } from './helpers/recording-renderer.mjs';

function fixture({ throwOn = null, errorOn = null, constructorError = false, installError = false } = {}) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const workers = [], attempts = [];
  globalThis.Worker = class {
    constructor() {
      attempts.push(1);
      if (constructorError) throw new Error('worker constructor blocked');
      this.messages = []; this.terminations = 0; this.onmessage = null; this._onerror = null;
      workers.push(this);
    }
    set onerror(callback) {
      this._onerror = callback;
      if (callback && installError) callback(new Error('synchronous listener failure'));
    }
    get onerror() { return this._onerror; }
    postMessage(message) {
      if (this.terminations) throw new Error('post to terminated worker');
      this.messages.push(message);
      if (message.type === throwOn) throw new Error(`post ${message.type} failed`);
      if (message.type === errorOn) this.onmessage?.({ data: {
        type: 'error', pageId: message.pageId, generation: message.generation,
        message: `synchronous ${message.type} failure`
      } });
    }
    terminate() { this.terminations++; }
  };
  const f = createRecordingRenderer(), r = f.renderer;
  r.setAdaptive(false);
  r.setOptimizationOptions({ spatialPolicy: 'always', spatialBuildExecution: 'synchronous',
    leafSize: 8, minExtent: 0, maxCandidateRatio: 1 });
  const append = () => {
    const positions = new Float32Array(32), colors = new Uint8Array(64), ids = new Uint32Array(16);
    for (let i = 0; i < 16; i++) { positions[i * 2] = i < 8 ? -500 : 500; colors.set([20, 130, 220, 255], i * 4); ids[i] = i + 1; }
    r.append({ groups: [{ kind: 'points', positions, colors, ids, featureCount: 16 }] });
    return r.pages.points[0];
  };
  const page = append();
  const query = () => r._tryWorkerSelection(r.pages.points[0], r._localMatrix(), 1, 1, 1, null);
  return { ...f, r, page, workers, attempts, append, query,
    dispose() { f.dispose(); if (saved) Object.defineProperty(globalThis, 'Worker', saved); else delete globalThis.Worker; } };
}

test('client disposal detaches callbacks and terminates once, including retained callback references', () => {
  const worker = { onmessage: null, onerror: null, postMessage() {}, terminations: 0, terminate() { this.terminations++; } };
  let errors = 0, results = 0;
  const client = new SpatialQueryClient({ createWorker: () => worker, onError: () => errors++, onResult: () => results++ });
  client.register('page', { primitiveSize: 1 });
  const lateError = worker.onerror, lateMessage = worker.onmessage;
  client.dispose(); client.dispose();
  lateError(new Error('late')); lateMessage({ data: { type: 'error', message: 'late message' } });
  assert.equal(worker.terminations, 1); assert.equal(worker.onerror, null); assert.equal(worker.onmessage, null);
  assert.equal(client.pages.size, 0); assert.equal(client.results.size, 0); assert.equal(errors, 0); assert.equal(results, 0);
});

test('worker runtime failure is nonfatal, terminates once, latches fallback and preserves visible geometry', () => {
  const f = fixture();
  try {
    f.query(); const client = f.r._spatialQueryClient, worker = f.workers[0];
    worker.onerror(new Error('module load failed'));
    assert.equal(worker.terminations, 1); assert.equal(f.r._spatialQueryClient, null);
    for (let i = 0; i < 10; i++) {
      const frame = f.render({ x: -500, y: 0, scale: 4 });
      assert.equal(frame.submittedVertices, 8, 'main-thread fallback keeps exactly the visible cluster');
    }
    assert.equal(f.attempts.length, 1, 'no per-frame Worker retry');
    const status = f.r.getStats().spatialQueryWorker;
    assert.equal(status.failedForRun, true); assert.equal(status.failureReason, 'module load failed');
    assert.equal(status.failures, 1); assert.equal(status.active, false); assert.equal(f.r._commitError, null);
    client.dispose(); assert.equal(worker.terminations, 1);
  } finally { f.dispose(); }
});

test('worker protocol error disposes the still-running worker rather than losing its handle', () => {
  const f = fixture();
  try {
    f.query(); const client = f.r._spatialQueryClient, worker = f.workers[0], entry = client.pages.get(f.page.workerId);
    worker.onmessage({ data: { type: 'error', pageId: f.page.workerId, generation: entry.generation, message: 'index failed' } });
    assert.equal(worker.terminations, 1); assert.equal(f.r._spatialQueryClient, null);
    assert.equal(client.pages.size, 0); assert.equal(f.r.getStats().spatialQueryWorker.failureReason, 'index failed');
    f.query(); assert.equal(f.attempts.length, 1);
  } finally { f.dispose(); }
});

for (const command of ['register', 'append', 'query']) test(`${command} postMessage throws: cleanup and fallback, never renderer failure`, () => {
  const f = fixture({ throwOn: command });
  try {
    assert.equal(f.query(), null); assert.equal(f.workers[0].terminations, 1);
    assert.equal(f.r._spatialQueryClient, null); assert.equal(f.r.getStats().spatialQueryWorker.failureReason, `post ${command} failed`);
    for (let i = 0; i < 3; i++) f.query();
    assert.equal(f.attempts.length, 1); assert.equal(f.r._commitError, null);
  } finally { f.dispose(); }
});

for (const command of ['register', 'append', 'query']) test(`synchronous ${command} error cannot recreate a disposed worker during the same call`, () => {
  const f = fixture({ errorOn: command });
  try {
    assert.equal(f.query(), null); assert.equal(f.workers[0].terminations, 1);
    assert.equal(f.r._spatialQueryClient, null); assert.equal(f.r.getStats().spatialQueryWorker.failureReason, `synchronous ${command} failure`);
    assert.equal(f.r.getStats().spatialQueryWorker.failures, 1);
    f.query(); assert.equal(f.attempts.length, 1);
  } finally { f.dispose(); }
});

test('synchronous listener-install error has no TDZ, leaked worker, or replacement attempt', () => {
  const f = fixture({ installError: true });
  try {
    assert.equal(f.query(), null); assert.equal(f.workers[0].terminations, 1);
    assert.equal(f.r.getStats().spatialQueryWorker.failureReason, 'synchronous listener failure');
    assert.equal(f.r._spatialQueryClient, null); f.query(); assert.equal(f.attempts.length, 1);
  } finally { f.dispose(); }
});

test('constructor failure is latched without TDZ; reset permits one fresh attempt', () => {
  const f = fixture({ constructorError: true });
  try {
    assert.equal(f.query(), null); assert.equal(f.workers.length, 0);
    f.query(); assert.equal(f.attempts.length, 1);
    assert.equal(f.r.getStats().spatialQueryWorker.failureReason, 'worker constructor blocked');
    f.r.reset(); assert.equal(f.r.getStats().spatialQueryWorker.failedForRun, false);
    assert.equal(f.r.getStats().spatialQueryWorker.failures, 0);
    f.append(); f.query(); assert.equal(f.attempts.length, 2);
  } finally { f.dispose(); }
});

test('explicit off/on permits recovery; old errors and results cannot clear or wake the replacement', () => {
  const f = fixture();
  try {
    f.query(); const old = f.r._spatialQueryClient, oldWorker = f.workers[0];
    const lateError = oldWorker.onerror, lateMessage = oldWorker.onmessage;
    oldWorker.onerror(new Error('first failure'));
    f.r.setOptimizationOptions({ spatialQueryWorker: true }); f.query();
    assert.equal(f.attempts.length, 1, 'idempotent true is not an explicit retry');
    f.r.setOptimizationOptions({ spatialQueryWorker: false });
    f.r.setOptimizationOptions({ spatialQueryWorker: true }); f.query();
    const current = f.r._spatialQueryClient;
    assert.ok(current && current !== old); assert.equal(f.attempts.length, 2);
    const requests = f.r.getRenderScheduling().sandboxFrameRequests;
    lateError(new Error('queued old Worker error'));
    lateMessage({ data: { type: 'error', message: 'queued old Worker message' } });
    old.onError(new Error('old owner callback')); old.onResult('old page', {});
    assert.equal(f.r._spatialQueryClient, current);
    assert.equal(f.r.getStats().spatialQueryWorker.failedForRun, false);
    assert.equal(f.r.getRenderScheduling().sandboxFrameRequests, requests);
    assert.equal(oldWorker.terminations, 1); assert.equal(f.workers[1].terminations, 0);
    f.r.reset(); assert.equal(f.workers[1].terminations, 1);
    old.onError(new Error('after reset')); assert.equal(f.r.getStats().spatialQueryWorker.failedForRun, false);
  } finally { f.dispose(); }
});

test('disable/reset/destroy detach healthy and failed sessions without repeated termination', () => {
  const f = fixture();
  try {
    f.query(); const first = f.workers[0];
    f.r.setOptimizationOptions({ spatialQueryWorker: false });
    assert.equal(first.terminations, 1); assert.equal(first.onerror, null); assert.equal(first.onmessage, null);
    f.r.setOptimizationOptions({ spatialQueryWorker: true }); f.query();
    const second = f.workers[1];
    f.r.destroy(); f.r.destroy();
    assert.equal(first.terminations, 1); assert.equal(second.terminations, 1);
    assert.equal(f.r._ensureSpatialQueryClient(), null); assert.equal(f.attempts.length, 2);
  } finally { f.dispose(); }
});
