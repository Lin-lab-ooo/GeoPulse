import { classifyProjectedBounds } from './projected-bounds.js';

/** Recenter a screen-space CSS-pixel square on [-1, 1]^2 without unprojecting.
 * The original w row is retained, so horizon-crossing bounds remain conservative.
 * Invalid view inputs return null: callers keep their full exact picking scan.
 */
export function createPickMatrix(matrix, { width, height, px, py, radius }) {
  if (!matrix || matrix.length !== 16 || !Array.from(matrix).every(Number.isFinite)
      || ![width, height, px, py, radius].every(Number.isFinite)
      || width <= 0 || height <= 0 || radius <= 0) return null;
  // A tiny CSS-pixel pad protects exact near-edge hits from recentering roundoff.
  const padded = radius + Math.max(1e-4, radius * 1e-9);
  const cx = 2 * px / width - 1, cy = 1 - 2 * py / height;
  const rx = 2 * padded / width, ry = 2 * padded / height;
  const pick = new Float64Array(matrix);
  for (let column = 0; column < 4; column++) {
    const offset = column * 4;
    pick[offset] = (matrix[offset] - cx * matrix[offset + 3]) / rx;
    pick[offset + 1] = (matrix[offset + 1] - cy * matrix[offset + 3]) / ry;
  }
  return Array.from(pick).every(Number.isFinite) ? pick : null;
}

/** Read-only broad phase using an ALREADY COMPLETE page-local base tree.
 * No index construction, GPU calls, deletion/alpha/LOD changes or point/line/face
 * hit semantics live here. starts=null means scan all complete primitives.
 * A caller tests every vertex of returned primitives against its exact metric.
 * movedPrimitiveStarts must track geometric changes independently of tombstones.
 */
export function queryPickPrimitiveStarts({ positions, count, primitiveSize = 1,
  spatial = null, spatialIndexedUntil = 0, movedPrimitiveStarts = null,
  matrix, width, height, px, py, radius, currentBounds = null }) {
  if (!(positions instanceof Float32Array) || ![1, 2, 3].includes(primitiveSize)
      || !Number.isSafeInteger(count) || count < 0 || count * 2 > positions.length
      || count % primitiveSize !== 0) throw new TypeError('Picking requires complete primitives within Float32 positions');
  const full = () => ({ mode: 'full', starts: null, candidatePrimitives: count / primitiveSize,
    nodesTested: 0, movedTested: 0, movedRejected: 0, baseMovedSkipped: 0 });
  if (!spatial || typeof spatial.query !== 'function' || spatialIndexedUntil !== count) return full();
  const pick = createPickMatrix(matrix, { width, height, px, py, radius });
  if (!pick) return full();
  // Only a CURRENT conservative page envelope is admissible here; a base-tree
  // root can retain old positions and omit newly moved geometry. When all page
  // geometry lies in the cursor square, enumeration and sorting cannot save any
  // exact vertex tests. Fully coincident devices then use the cheap flat scan.
  if (currentBounds && ['minX', 'minY', 'maxX', 'maxY'].every(key => Number.isFinite(currentBounds[key]))
      && currentBounds.minX <= currentBounds.maxX && currentBounds.minY <= currentBounds.maxY) {
    const relation = classifyProjectedBounds(currentBounds, pick);
    if (relation === 1) return full();
    if (relation === -1) return { mode: 'spatial', starts: new Uint32Array(0),
      candidatePrimitives: 0, nodesTested: 0, movedTested: 0, movedRejected: 0, baseMovedSkipped: 0 };
  }
  const starts = [], moved = movedPrimitiveStarts;
  let movedTested = 0, movedRejected = 0, baseMovedSkipped = 0;
  const stats = spatial.query(bounds => classifyProjectedBounds(bounds, pick), start => {
    if (moved?.has(start)) { baseMovedSkipped++; return; }
    starts.push(start);
  });
  if (moved?.size) for (const start of moved) {
    if (!Number.isSafeInteger(start) || start < 0 || start >= count || start % primitiveSize !== 0) return full();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let vertex = start; vertex < start + primitiveSize; vertex++) {
      const x = positions[vertex * 2], y = positions[vertex * 2 + 1];
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    movedTested++;
    if (classifyProjectedBounds({ minX, minY, maxX, maxY }, pick) === -1) { movedRejected++; continue; }
    starts.push(start);
  }
  // Tree traversal is spatial. Original slot order preserves the existing '<'
  // distance tie winner and primitive membership; pages/kinds stay caller order.
  const ordered = Uint32Array.from(starts).sort();
  return { mode: 'spatial', starts: ordered, candidatePrimitives: ordered.length,
    nodesTested: stats.nodesTested, movedTested, movedRejected, baseMovedSkipped };
}
