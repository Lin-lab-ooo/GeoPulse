/** Explicit transport selection and byte units shared by Worker and full-load path. */
export function streamURL(config) {
  const compression = config.compression ?? 'identity';
  if (!['identity', 'gzip'].includes(compression)) throw new RangeError('compression must be identity or gzip');
  return '/api/stream?' + new URLSearchParams({ count: config.count, seed: config.seed,
    delay: config.delay, chunk: config.chunk, compression });
}

export function transportReceipt(response, decodedBytes = 0, complete = false, timingEntries = null, fetchStartedAt = null) {
  let entries = timingEntries;
  if (entries === null) {
    try { entries = response.url && performance.getEntriesByName?.(response.url) || []; }
    catch { entries = []; }
  }
  const timing = complete ? [...entries].reverse().find(e => e.entryType === 'resource' && e.responseEnd > 0 && e.encodedBodySize > 0 &&
    e.decodedBodySize === decodedBytes && (fetchStartedAt === null || e.startTime >= fetchStartedAt - 0.1)) : null;
  return { contentEncoding: response.headers.get('content-encoding') || 'identity',
    decodedResponseBytes: decodedBytes, encodedBodyBytes: timing?.encodedBodySize ?? null,
    resourceTimingDecodedBytes: timing?.decodedBodySize ?? null, complete,
    byteScope: 'decodedResponseBytes counts readable Response bytes. encodedBodyBytes is request-start-bound Resource Timing encodedBodySize with matching decoded size when available; excludes response headers and HTTP framing. Missing timing is null, never inferred from decoded bytes.' };
}
