/**
 * Spatial query worker.
 *
 * The 1.6/1.7 experiments put the fine tree on the main thread: building it cost
 * up to 19.6 s of wall time in 128-primitive slices, and during camera motion
 * every page re-ran count() + query() + index rebuild, which the optimization
 * page measured as ~54-70 ms of main-thread CPU per movement stage. Keeping the
 * tree in a worker can move that work off-thread. The renderer still retains
 * a main-thread fallback, and copies, result application and GL work remain.
 *
 * The worker owns only the index. Positions, colours, LOD membership and the
 * GPU index buffer stay on the main thread; the worker returns candidate vertex
 * starts, and the renderer applies LOD and alert preservation as before.
 *
 * `createSpatialQueryHandler` is exported separately so the protocol can be
 * driven in-process from a Node test without a browser Worker.
 */

import { PrimitiveSpatialIndex } from './spatial-index.js';
import { classifyProjectedBounds, createClassifierStats } from './projected-bounds.js';

export function createSpatialQueryHandler(post) {
  const pages = new Map();
  const generations = new Map();
  const stats = { appends: 0, queries: 0, indexedPrimitives: 0, lastQueryMs: 0, errors: 0, mirrorBytes: 0 };

  function page(pageId) {
    const entry = pages.get(pageId);
    if (!entry) throw new Error('unknown page ' + pageId);
    return entry;
  }

  return {
    stats,
    onmessage(event) {
      const message = event.data ?? event;
      try {
        switch (message.type) {
          case 'register': {
            if (!Number.isSafeInteger(message.generation) || message.generation < 1) throw new Error('register requires a generation');
            if (message.generation <= (generations.get(message.pageId) ?? 0)) break;
            generations.set(message.pageId, message.generation);
            pages.set(message.pageId, {
              generation: message.generation,
              index: new PrimitiveSpatialIndex({ primitiveSize: message.primitiveSize, ...message.options }),
              indexedUntil: 0,
              primitiveSize: message.primitiveSize,
              dataVersion: message.dataVersion ?? 0,
              // The index stores primitives by absolute vertex offset, so the
              // worker keeps its own position mirror instead of the slice-local
              // coordinates the client transfers. This is what lets the main
              // thread keep ownership of its pages: nothing is shared.
              mirror: new Float32Array(0),
              mirrorBytes: 0
            });
            break;
          }
          case 'append': {
            const entry = page(message.pageId);
            if (message.generation !== entry.generation) break;
            const copy = message.positions instanceof Float32Array
              ? message.positions : new Float32Array(message.positions);
            const start = message.start ?? entry.indexedUntil;
            const end = message.end ?? start + copy.length / 2;
            if (start !== entry.indexedUntil) throw new Error('append must continue at indexedUntil');
            if (end - start !== copy.length / 2) throw new Error('slice length must match start/end');
            if (start % entry.primitiveSize || end % entry.primitiveSize) throw new Error('append must delimit complete primitives');
            const began = performance.now();
            if (end * 2 > entry.mirror.length) {
              let capacity = Math.max(1024, entry.mirror.length * 2);
              while (capacity < end * 2) capacity *= 2;
              const grown = new Float32Array(capacity);
              grown.set(entry.mirror);
              entry.mirror = grown;
            }
            entry.mirror.set(copy, start * 2);
            entry.index.append(entry.mirror, start, end);
            entry.indexedUntil = end;
            entry.dataVersion = message.dataVersion;
            entry.lastAppendMs = performance.now() - began;
            entry.mirrorBytes = entry.mirror.byteLength;
            stats.appends++;
            stats.indexedPrimitives += (end - start) / entry.primitiveSize;
            stats.mirrorBytes = [...pages.values()].reduce((sum, item) => sum + item.mirrorBytes, 0);
            post({
              type: 'indexed', pageId: message.pageId, generation: entry.generation,
              dataVersion: entry.dataVersion, indexedUntil: end,
              lastAppendMs: entry.lastAppendMs, mirrorBytes: entry.mirrorBytes, index: entry.index.getStats()
            });
            break;
          }
          case 'query': {
            const entry = page(message.pageId);
            if (message.generation !== entry.generation) break;
            const matrix = message.matrix instanceof Float64Array ? message.matrix : new Float64Array(message.matrix);
            const receipt = { pageId: message.pageId, generation: entry.generation, seq: message.seq,
              matrix, marginX: message.marginX, marginY: message.marginY, candidateBudget: message.candidateBudget,
              dataVersion: entry.dataVersion, indexedUntil: entry.indexedUntil };
            if (message.dataVersion !== entry.dataVersion || message.indexedUntil !== entry.indexedUntil) {
              post({ type: 'result', ...receipt, ready: false });
              break;
            }
            const classifier = createClassifierStats();
            const began = performance.now();
            const counted = entry.index.count(bounds => classifyProjectedBounds(bounds, matrix, {
              marginX: message.marginX, marginY: message.marginY, stats: classifier
            }));
            // candidateBudget is a primitive count for every geometry kind.
            const dense = counted.primitivesSelected > message.candidateBudget;
            let starts = null;
            let visitStats = null;
            if (!dense) {
              const scratch = new Uint16Array(Math.max(1, counted.primitivesSelected + 1));
              let n = 0;
              visitStats = entry.index.query(bounds => classifyProjectedBounds(bounds, matrix, {
                marginX: message.marginX, marginY: message.marginY
              }), start => { scratch[n++] = start; });
              starts = scratch.subarray(0, n);
            }
            stats.queries++;
            stats.lastQueryMs = performance.now() - began;
            const transfer = starts ? starts.slice().buffer : null;
            post({
              type: 'result', ...receipt, ready: true, dense,
              count: counted.primitivesSelected, startsBuffer: transfer,
              stats: {
                queryMs: stats.lastQueryMs, nodesTested: counted.nodesTested + (visitStats?.nodesTested ?? 0),
                classifier, index: entry.index.getStats()
              }
            }, transfer ? [transfer] : []);
            break;
          }
          case 'clear': {
            if (pages.get(message.pageId)?.generation === message.generation) pages.delete(message.pageId);
            break;
          }
          case 'clearAll': {
            pages.clear();
            break;
          }
          default:
            throw new Error('unknown message ' + message.type);
        }
      } catch (error) {
        stats.errors++;
        post({ type: 'error', pageId: message?.pageId ?? null, generation: message?.generation,
          seq: message?.seq ?? null, message: String(error && error.message || error) });
      }
    }
  };
}

const isWorkerScope = typeof self !== 'undefined' && typeof postMessage === 'function' && typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
if (isWorkerScope) {
  const handler = createSpatialQueryHandler(message => postMessage(message));
  self.onmessage = event => handler.onmessage(event);
}
