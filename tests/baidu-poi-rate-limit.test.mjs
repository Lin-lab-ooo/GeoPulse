import test from 'node:test';
import assert from 'node:assert/strict';
import {createBaiduPoiRequestGate, BAIDU_POI_MIN_INTERVAL_MS,
  BAIDU_POI_LAST_REQUEST_KEY, BAIDU_POI_LOCK_NAME} from '../public/js/baidu-poi-rate-limit.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject}; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function storage() { const values = new Map(); return {getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value), values}; }
function clock(initial = 10000) {
  const value = {time: initial, waits: []};
  value.now = () => value.time;
  value.sleep = async ms => {value.waits.push(ms); value.time += ms;};
  return value;
}
function fakeLocks() {
  let tail = Promise.resolve(); const calls = [];
  return {calls, request(name, options, work) {
    calls.push({name, mode: options.mode});
    const operation = tail.then(() => {
      if (options.signal?.aborted) { const error = new Error('cancelled'); error.name = 'AbortError'; throw error; }
      return work({name, mode: options.mode});
    });
    tail = operation.catch(() => {});
    if (!options.signal) return operation;
    return new Promise((resolve, reject) => {
      const abort = () => { const error = new Error('cancelled'); error.name = 'AbortError'; reject(error); };
      options.signal.addEventListener('abort', abort, {once:true});
      operation.then(value => {options.signal.removeEventListener('abort', abort); resolve(value);}, error => {options.signal.removeEventListener('abort', abort); reject(error);});
      if (options.signal.aborted) abort();
    });
  }};
}

test('fallback serial queue starts requests at least 2000ms apart using only fake time', async () => {
  const c = clock(), store = storage(), gate = createBaiduPoiRequestGate({now:c.now, sleep:c.sleep, storage:store, locks:null});
  const starts = [];
  const results = await Promise.all([1,2,3].map(value => gate(() => {starts.push(c.time); return value;})));
  assert.deepEqual(results, [1,2,3]);
  assert.deepEqual(starts, [10000,12000,14000]);
  assert.deepEqual(c.waits, [2000,2000]);
  assert.equal(store.values.get(BAIDU_POI_LAST_REQUEST_KEY), '14000');
});

test('shared Web Lock covers the complete request and coordinates separate gate instances', async () => {
  const c = clock(), store = storage(), locks = fakeLocks();
  const one = createBaiduPoiRequestGate({now:c.now, sleep:c.sleep, storage:store, locks});
  const two = createBaiduPoiRequestGate({now:c.now, sleep:c.sleep, storage:store, locks});
  const firstDone = deferred(), starts = [];
  const first = one(() => {starts.push(c.time); return firstDone.promise;});
  await flush();
  const second = two(() => {starts.push(c.time); return 'second';});
  await flush(); assert.deepEqual(starts, [10000]);
  c.time = 11000; firstDone.resolve('first');
  assert.deepEqual(await Promise.all([first,second]), ['first','second']);
  assert.deepEqual(starts, [10000,12000]);
  assert.ok(locks.calls.every(call => call.name === BAIDU_POI_LOCK_NAME && call.mode === 'exclusive'));
});

test('a recreated gate honors the persisted previous start after reload', async () => {
  const c = clock(), store = storage(), locks = fakeLocks();
  store.setItem(BAIDU_POI_LAST_REQUEST_KEY, '9500');
  const gate = createBaiduPoiRequestGate({now:c.now, sleep:c.sleep, storage:store, locks});
  const started = await gate(() => c.time);
  assert.equal(started, 11500); assert.deepEqual(c.waits, [1500]);
});

test('cancelling while queued for a Web Lock cannot begin work later', async () => {
  const c = clock(), store = storage(), locks = fakeLocks();
  const gate = createBaiduPoiRequestGate({now:c.now, sleep:c.sleep, storage:store, locks});
  const done = deferred(), first = gate(() => done.promise); await flush();
  const controller = new AbortController(); let started = false;
  const queued = gate(() => {started = true;}, {signal:controller.signal});
  controller.abort(); await assert.rejects(queued, {name:'AbortError'});
  done.resolve(); await first; await flush();
  assert.equal(started, false);
  assert.equal(store.values.get(BAIDU_POI_LAST_REQUEST_KEY), '10000');
});

test('cancelling during cooldown does not issue work or advance the stored start', async () => {
  const c = clock(), store = storage(), locks = fakeLocks(), sleepDone = deferred();
  store.setItem(BAIDU_POI_LAST_REQUEST_KEY, '9500');
  const gate = createBaiduPoiRequestGate({now:c.now, sleep:() => sleepDone.promise, storage:store, locks});
  const controller = new AbortController(); let started = false;
  const waiting = gate(() => {started = true;}, {signal:controller.signal});
  await flush(); controller.abort();
  await assert.rejects(waiting, {name:'AbortError'});
  sleepDone.resolve(); await flush();
  assert.equal(started, false);
  assert.equal(store.values.get(BAIDU_POI_LAST_REQUEST_KEY), '9500');
});

test('request timeout releases serialization only after settlement and retains start spacing', async () => {
  const c = clock(), store = storage(), locks = fakeLocks();
  const gate = createBaiduPoiRequestGate({now:c.now, sleep:c.sleep, storage:store, locks});
  const done = deferred(), starts = [];
  const first = gate(() => {starts.push(c.time); return done.promise;});
  const firstCheck = assert.rejects(first, {message:'fake SDK timeout'});
  await flush();
  const second = gate(() => {starts.push(c.time); return 'second';});
  await flush(); assert.deepEqual(starts, [10000]);
  c.time = 10005; done.reject(new Error('fake SDK timeout'));
  await firstCheck; assert.equal(await second, 'second');
  assert.deepEqual(starts, [10000,12000]);
});

test('fallback cancellation while queued cannot skip serialization or issue a request', async () => {
  const c = clock(), store = storage(), gate = createBaiduPoiRequestGate({now:c.now, sleep:c.sleep, storage:store, locks:null});
  const done = deferred(), first = gate(() => done.promise); await flush();
  const controller = new AbortController(); let started = false;
  const queued = gate(() => {started = true;}, {signal:controller.signal});
  controller.abort(); await assert.rejects(queued, {name:'AbortError'});
  done.resolve(); await first; await flush(); assert.equal(started, false);
});

test('separate fallback gates still share the page queue when persistent storage is blocked', async () => {
  const c = clock(), store = {getItem() {throw new Error('storage disabled');}, setItem() {throw new Error('storage disabled');}};
  const one = createBaiduPoiRequestGate({now:c.now, sleep:c.sleep, storage:store, locks:null});
  const two = createBaiduPoiRequestGate({now:c.now, sleep:c.sleep, storage:store, locks:null});
  const done = deferred(), starts = [];
  const first = one(() => {starts.push(c.time); return done.promise;}); await flush();
  const second = two(() => {starts.push(c.time);}); await flush();
  assert.deepEqual(starts, [10000]);
  done.resolve(); await Promise.all([first,second]);
  assert.deepEqual(starts, [10000,12000]);
});

test('an early sleep cannot bypass spacing; an already-aborted call changes no metadata', async () => {
  const c = clock(), store = storage(), locks = fakeLocks(); let sleeps = 0;
  store.setItem(BAIDU_POI_LAST_REQUEST_KEY, '9500');
  const gate = createBaiduPoiRequestGate({now:c.now, storage:store, locks,
    sleep: async ms => {c.time += ++sleeps === 1 ? 100 : ms;}});
  assert.equal(await gate(() => c.time), 11500); assert.equal(sleeps, 2);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(gate(() => assert.fail('must not run'), {signal:controller.signal}), {name:'AbortError'});
  assert.equal(locks.calls.length, 1); assert.equal(store.values.get(BAIDU_POI_LAST_REQUEST_KEY), '11500');
  assert.equal(BAIDU_POI_MIN_INTERVAL_MS, 2000);
});
