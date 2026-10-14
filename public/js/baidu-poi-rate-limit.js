// Serializes only this project's explicit LocalSearch calls. No credentials or
// SDK internals are read. This is not a guarantee about an AK's global quota.
export const BAIDU_POI_MIN_INTERVAL_MS = 2000;
export const BAIDU_POI_LOCK_NAME = 'geopulse-baidu-poi-request';
export const BAIDU_POI_LAST_REQUEST_KEY = 'geopulse-baidu-poi-last-request-time';
let pageQueue = Promise.resolve();
const memoryStates = new WeakMap();
const noStorageMemory = { last: null };

function aborted() {
  const error = new Error('百度 POI 请求在等待期间已取消。');
  error.name = 'AbortError'; error.code = 'ABORTED';
  return error;
}
function assertNotAborted(signal) { if (signal?.aborted) throw aborted(); }
function waitWithAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) { promise.catch(() => {}); return Promise.reject(aborted()); }
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(aborted()); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
function defaultSleep(ms, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(aborted()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
function browserStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** Injectable dependencies permit completely local fake-clock tests. */
export function createBaiduPoiRequestGate({ now = Date.now, sleep = defaultSleep,
  storage = browserStorage(), locks = globalThis.navigator?.locks ?? null } = {}) {
  if (typeof now !== 'function' || typeof sleep !== 'function') throw new TypeError('需要时钟与等待函数。');
  let memory = noStorageMemory;
  if (storage && (typeof storage === 'object' || typeof storage === 'function')) {
    if (!memoryStates.has(storage)) memoryStates.set(storage, { last: null });
    memory = memoryStates.get(storage);
  }
  function lastRequestTime() {
    let persisted = null;
    try {
      const raw = storage?.getItem(BAIDU_POI_LAST_REQUEST_KEY);
      if (raw !== null && raw !== undefined && raw !== '') {
        const value = Number(raw);
        if (Number.isFinite(value) && value >= 0) persisted = value;
      }
    } catch { /* Storage-disabled browsers still retain the page-local guard. */ }
    if (persisted === null) return memory.last;
    return memory.last === null ? persisted : Math.max(memory.last, persisted);
  }
  return function gate(work, { signal } = {}) {
    if (typeof work !== 'function') return Promise.reject(new TypeError('请求任务必须为函数。'));
    try { assertNotAborted(signal); } catch (error) { return Promise.reject(error); }
    const run = async () => {
      assertNotAborted(signal);
      while (true) {
        const time = now();
        if (!Number.isFinite(time) || time < 0) throw new Error('POI 限速时钟不可用。');
        const last = lastRequestTime(), remaining = last === null ? 0 : last + BAIDU_POI_MIN_INTERVAL_MS - time;
        if (remaining <= 0) break;
        // A sleep can finish early. Recheck wall time and persisted state while
        // still holding the exclusive lock before committing a request start.
        await waitWithAbort(Promise.resolve(sleep(remaining, { signal })), signal);
        assertNotAborted(signal);
      }
      assertNotAborted(signal);
      const started = now();
      if (!Number.isFinite(started) || started < 0) throw new Error('POI 限速时钟不可用。');
      memory.last = started;
      try { storage?.setItem(BAIDU_POI_LAST_REQUEST_KEY, String(started)); }
      catch { /* Cross-reload persistence is unavailable; page-local spacing remains. */ }
      // Returning the entire SDK promise keeps the lock until callback, timeout,
      // or abort settles it. No retry or extra request follows a failure here.
      return await work();
    };
    if (typeof locks?.request === 'function') {
      return locks.request(BAIDU_POI_LOCK_NAME, { mode: 'exclusive', ...(signal ? { signal } : {}) }, run);
    }
    // Shared across gate instances in this module/page. Without Web Locks this
    // cannot make an atomic cross-tab mutex; storage only shares start timestamps.
    const queued = pageQueue.then(run);
    pageQueue = queued.catch(() => {});
    return waitWithAbort(queued, signal);
  };
}

const defaultGate = createBaiduPoiRequestGate();
export function gateBaiduPoiRequest(work, options = {}) { return defaultGate(work, options); }
