/** Resource model for the current fixed 88/10/2 synthetic schema, not arbitrary imported GIS. */
export function syntheticSoakLayout(count, { pageVertices = 65535, primitiveSize = { points: 1, lines: 2, polygons: 3 } } = {}) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000000) throw new RangeError('count must be 1..1000000');
  if (!Number.isSafeInteger(pageVertices) || pageVertices < 3) throw new RangeError('invalid page capacity');
  const full = Math.floor(count / 100), tail = count % 100;
  const features = { points: full * 88 + Math.min(tail, 88), lines: full * 10 + Math.max(0, Math.min(10, tail - 88)), polygons: full * 2 + Math.max(0, tail - 98) };
  const vertices = { points: features.points, lines: features.lines * 2, polygons: features.polygons * 6 };
  const pages = {};
  let capacityVertices = 0, totalVertices = 0;
  for (const kind of ['points', 'lines', 'polygons']) {
    const alignment = primitiveSize[kind];
    if (!Number.isSafeInteger(alignment) || alignment < 1 || alignment > pageVertices) throw new RangeError('invalid primitive alignment');
    const capacity = Math.floor(pageVertices / alignment) * alignment;
    pages[kind] = { capacity, count: Math.ceil(vertices[kind] / capacity), vertices: vertices[kind] };
    capacityVertices += pages[kind].count * capacity; totalVertices += vertices[kind];
  }
  return { count, features, vertices, totalVertices, pages, capacityVertices,
    maxCPUBufferBytes: capacityVertices * 18, maxGPUBufferBytes: capacityVertices * 14,
    interpretation: 'CPU position8+RGBA4+ID4+optional uint16 index2; GPU position8+RGBA4+optional uint16 index2, at fixed allocated page capacity. Excludes spatial trees, scratch, JS objects, Worker mirrors, textures and driver memory.' };
}

export function soakCompletionTimeout(count, { chunk = 512, delay = 20, graceMs = 30000 } = {}) {
  if (![count, chunk, delay, graceMs].every(Number.isSafeInteger) || count < 1 || chunk < 1 || delay < 0 || graceMs < 0) throw new RangeError('invalid timeout inputs');
  return Math.max(60000, Math.ceil(count / chunk) * delay + graceMs);
}
