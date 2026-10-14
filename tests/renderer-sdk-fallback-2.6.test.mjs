import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, batch} from '../tools/fixtures/candidate-context-cleanup-2.6/test-helper.mjs';
import {GeoRenderer as Renderer} from '../public/js/renderer.js';

test('new first SDK upload error fails old consumer, rejects its waiter, restores local drawing and still rejects connect', async t => {
  const oldRun = { failed: false, completed: false, workerTerminations: 0, ACKs: 0 };
  const f = fixture(Renderer, { onError() { oldRun.failed = true; oldRun.workerTerminations++; } }); t.after(() => f.dispose());
  const { revision } = f.r.append(batch(3));
  const oldCommit = f.r.awaitCommit(revision).then(() => { oldRun.completed = true; oldRun.ACKs++; return null; }, error => error);
  const { promise, map } = await f.beginConnect(), connection = promise.catch(error => error);
  map.gl.createBuffer = () => null; f.drawMap(map);
  const failure = await connection; assert.match(failure.message, /GPU/); assert.equal(await oldCommit, failure);
  assert.equal(f.errors.length, 1); assert.equal(f.errors[0], failure); assert.equal(oldRun.failed, true); assert.equal(oldRun.workerTerminations, 1);
  assert.equal(oldRun.completed, false); assert.equal(oldRun.ACKs, 0); assert.equal(f.r._commitError, null); assert.equal(f.r.mode, 'sandbox');
  assert.ok(f.raf.size > 0); f.tick(); assert.equal(f.r.getStats().vertices, 3); assert.equal(oldRun.completed, false); assert.equal(oldRun.ACKs, 0);
  // Explicit new run resets revision validity; old promises never become successful.
  f.r.reset(); const next = f.r.append(batch(2)); const committed = f.r.awaitCommit(next.revision); f.tick();
  assert.equal((await committed).committedRevision, next.revision);
  await assert.rejects(f.r.awaitCommit(revision), { name: 'AbortError' });
});

test('previous commit error is not erased by a failed SDK connection', async t => {
  const f = fixture(Renderer); t.after(() => f.dispose()); f.r.append(batch());
  f.r._commitError = new Error('preexisting fatal submission error');
  const { promise, map } = await f.beginConnect(), connection = promise.catch(error => error);
  map.gl.createBuffer = () => null; f.drawMap(map); const error = await connection;
  assert.match(error.message, /GPU/); assert.ok(f.r._commitError); assert.equal(f.errors.length, 0); assert.equal(f.raf.size, 0);
});

test('a distinct error raised by the consumer is preserved and blocks sandbox scheduling', async t => {
  let f; const secondary = new Error('consumer reported a separate failure');
  f = fixture(Renderer, { onError() { f.r._commitError = secondary; } }); t.after(() => f.dispose()); f.r.append(batch());
  const { promise, map } = await f.beginConnect(), connection = promise.catch(error => error);
  map.gl.createBuffer = () => null; f.drawMap(map); const original = await connection;
  assert.match(original.message, /GPU/); assert.notEqual(original, secondary); assert.equal(f.r._commitError, secondary); assert.equal(f.raf.size, 0);
});

test('consumer destruction during failure notification prevents fallback resurrection', async t => {
  let f; f = fixture(Renderer, { onError() { f.r.destroy(); } }); t.after(() => f.dispose()); f.r.append(batch());
  const { promise, map } = await f.beginConnect(), connection = promise.catch(error => error);
  map.gl.createBuffer = () => null; f.drawMap(map); const original = await connection;
  assert.match(original.message, /GPU/); assert.equal(f.r.destroyed, true); assert.equal(f.raf.size, 0); assert.equal(f.r.canvas.isConnected, false);
});

test('ordinary SDK connection errors remain rejected and do not clear unrelated failure latches', async t => {
  const f = fixture(Renderer); t.after(() => f.dispose()); const prior = new Error('unrelated local failure'); f.r._commitError = prior;
  const { promise, map } = await f.beginConnect(), connection = promise.catch(error => error), sdkError = new Error('SDK setup error');
  map.layer.options.onError(sdkError); assert.equal(await connection, sdkError);
  assert.equal(f.r._commitError, prior); assert.equal(f.errors.length, 0);
});

test('successful reconnection after explicit reset does not emit a failure notification', async t => {
  const f = fixture(Renderer); t.after(() => f.dispose()); f.r.reset(); f.r.append(batch());
  const { promise, map } = await f.beginConnect(); f.drawMap(map); assert.equal(await promise, true);
  assert.equal(f.r.mode, 'baidu'); assert.equal(f.r._commitError, null); assert.equal(f.errors.length, 0);
});
