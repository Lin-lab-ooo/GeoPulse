/**
 * Main-thread client for the spatial query worker.
 *
 * Deliberately conservative: a query returns a sequence number immediately and
 * the result arrives later. Results carry the exact query and acknowledged
 * geometry version. Callers use their conservative fallback until a matching
 * result lands; an old camera or an unindexed append is never a usable result.
 */

const sameMatrix = (a, b) => a?.length === b?.length && a.length === 16 && a.every((v, i) => v === b[i]);
const sameQuery = (a, b) => a && b && sameMatrix(a.matrix, b.matrix) &&
  a.marginX === b.marginX && a.marginY === b.marginY && a.candidateBudget === b.candidateBudget &&
  a.dataVersion === b.dataVersion && a.indexedUntil === b.indexedUntil;

export class SpatialQueryClient {
  constructor({ createWorker, onResult = null, onError = null } = {}) {
    if (typeof createWorker !== 'function') throw new TypeError('createWorker required');
    this.createWorker = createWorker;
    this.onResult = onResult;
    this.onError = onError;
    this.worker = null;
    this.nextSeq = 1;
    this.nextGeneration = 1;
    this.pages = new Map();
    this.results = new Map();
    this.stats = { issuedRequests: 0, responses: 0, droppedResponses: 0, staleResponses: 0, errors: 0, lastQueryMs: null, lastTransportMs: null };
  }

  start() {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    this.worker = worker;
    // A queued callback from a disposed worker cannot affect a later session.
    worker.onmessage = event => { if (this.worker === worker) this._handle(event.data ?? event); };
    worker.onerror = error => {
      if (this.worker !== worker) return;
      this.stats.errors++; this.onError?.(error);
    };
    return worker;
  }

  register(pageId, { primitiveSize, options = {}, dataVersion = 0 }) {
    const generation = this.nextGeneration++;
    this.results.delete(pageId);
    this.pages.set(pageId, { primitiveSize, generation, sentUntil: 0, indexedUntil: 0, seq: 0, pending: null, dataVersion });
    this._post({ type: 'register', pageId, generation, primitiveSize, options, dataVersion });
  }

  /**
   * Copies the appended slice so the caller keeps ownership of its pages. The
   * absolute start/end travel with the copy: the worker owns its own contiguous
   * cursor, and the absolute offsets are what it validates against.
   */
  append(pageId, positions, start, end, { dataVersion } = {}) {
    const entry = this.pages.get(pageId);
    if (!entry) throw new Error('page must be registered before append: ' + pageId);
    if (start !== entry.sentUntil) throw new Error('append must continue at sent indexedUntil');
    if (start % entry.primitiveSize || end % entry.primitiveSize || end < start || end * 2 > positions.length) {
      throw new RangeError('append must delimit complete existing primitives');
    }
    const copy = positions.slice(start * 2, end * 2);
    entry.sentUntil = end;
    if (dataVersion !== undefined) entry.dataVersion = dataVersion;
    this.results.delete(pageId);
    entry.pending = null;
    this._post({ type: 'append', pageId, generation: entry.generation, dataVersion: entry.dataVersion,
      positions: copy, start, end }, [copy.buffer]);
  }

  /** Returns the sequence number; the result arrives through onResult(). */
  query(pageId, { matrix, marginX, marginY, candidateBudget }) {
    const entry = this.pages.get(pageId);
    if (!entry) return null;
    const request = { matrix: Float64Array.from(matrix), marginX, marginY, candidateBudget,
      dataVersion: entry.dataVersion, indexedUntil: entry.sentUntil };
    if (entry.pending && sameQuery(entry.pending, request)) return entry.pending.seq;
    const seq = this.nextSeq++;
    entry.seq = seq;
    entry.pending = { ...request, seq, issuedAt: performance.now() };
    this.stats.issuedRequests++;
    this._post({ type: 'query', pageId, generation: entry.generation, seq, ...request });
    return seq;
  }

  /** Geometry-matching receipt, or null. With a query context, require that
   * exact camera too. A receipt flagged `stale` must not be applied. */
  latest(pageId, query = null) {
    const entry = this.pages.get(pageId);
    const result = this.results.get(pageId);
    if (!entry || !result) return null;
    if (result.generation !== entry.generation || result.dataVersion !== entry.dataVersion ||
      result.indexedUntil !== entry.sentUntil || entry.indexedUntil !== entry.sentUntil) return null;
    if (query && !sameQuery(result, { ...query, dataVersion: entry.dataVersion, indexedUntil: entry.sentUntil })) return null;
    return { ...result, stale: entry.pending !== null && entry.pending.seq !== result.seq };
  }

  invalidate(pageId) {
    this.results.delete(pageId);
    const entry = this.pages.get(pageId);
    if (entry) entry.pending = null;
  }

  clear(pageId) {
    const entry = this.pages.get(pageId);
    this.pages.delete(pageId);
    this.results.delete(pageId);
    if (entry) this._post({ type: 'clear', pageId, generation: entry.generation });
  }

  _post(message, transfer) {
    const worker = this.start();
    worker.postMessage(message, transfer ?? []);
  }

  _handle(message) {
    switch (message.type) {
      case 'indexed': {
        const entry = this.pages.get(message.pageId);
        if (entry && message.generation === entry.generation &&
          Number.isInteger(message.indexedUntil) && message.indexedUntil <= entry.sentUntil) {
          entry.indexedUntil = Math.max(entry.indexedUntil, message.indexedUntil);
        }
        break;
      }
      case 'result': {
        this.stats.responses++;
        const entry = this.pages.get(message.pageId);
        if (!entry || message.generation !== entry.generation) { this.stats.droppedResponses++; break; }
        const request = entry.pending;
        if (request && request.seq === message.seq) {
          this.stats.lastTransportMs = performance.now() - entry.pending.issuedAt;
          entry.pending = null;
        } else {
          // A newer query was issued while this one was in flight.
          this.stats.staleResponses++;
          break;
        }
        if (message.ready === false || message.dataVersion !== entry.dataVersion || message.indexedUntil !== entry.sentUntil ||
          !sameQuery(message, request)) { this.stats.droppedResponses++; break; }
        const starts = message.startsBuffer ? new Uint16Array(message.startsBuffer) : null;
        const result = {
          generation: message.generation, seq: message.seq, dense: Boolean(message.dense), count: message.count,
          matrix: Float64Array.from(message.matrix), marginX: message.marginX, marginY: message.marginY,
          candidateBudget: message.candidateBudget, dataVersion: message.dataVersion, indexedUntil: message.indexedUntil,
          starts, stats: message.stats, receivedAt: performance.now()
        };
        this.results.set(message.pageId, result);
        this.stats.lastQueryMs = message.stats?.queryMs ?? null;
        this.onResult?.(message.pageId, result);
        break;
      }
      case 'error': {
        const entry = this.pages.get(message.pageId);
        if (message.pageId && (!entry || message.generation !== entry.generation)) { this.stats.droppedResponses++; break; }
        this.stats.errors++;
        if (message.pageId) this.results.delete(message.pageId);
        if (entry) entry.pending = null;
        this.onError?.(new Error(message.message));
        break;
      }
      default:
        break;
    }
  }

  dispose() {
    const worker = this.worker;
    this.worker = null;
    this.pages.clear();
    this.results.clear();
    if (worker) {
      // Detach before termination: cleanup is idempotent even if an adapter
      // synchronously reports another error while terminating.
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate?.();
    }
  }
}
