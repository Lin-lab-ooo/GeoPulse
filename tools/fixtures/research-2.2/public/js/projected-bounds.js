/**
 * Projected-bounds classification and viewport unprojection.
 *
 * Extracted from the renderer so the same conservative test can run on the main
 * thread and inside a spatial-query worker, and so it can be unit tested without
 * a GL context.
 *
 * Two costs showed up in the 1.6/1.7 spatial experiments: during camera motion
 * every page re-ran the full separating-axis test for every node it visited, and
 * the selection was rebuilt from scratch whenever the camera matrix changed by
 * even one ULP. This module addresses the first half:
 *
 *   1. project the four corners (unchanged, and the only step that can divide),
 *   2. cheap four-side reject / full-inside accept (unchanged),
 *   3. NEW: run the exact separating-axis test only for nodes the side test
 *      cannot settle - i.e. genuine boundary nodes - and on the axes that a
 *      parallelogram actually needs. The projected quadrilateral of a rectangle
 *      is a parallelogram whenever the matrix is affine (the sandbox camera, an
 *      untilted map), so opposite edges share a normal and the four candidate
 *      axes collapse to two. Only a projective matrix (tilted / heading map
 *      view) needs all four.
 *
 * Every rejection stays conservative: a node is never dropped unless a real
 * separating axis is found.
 */

const EMPTY_STATS = Object.freeze({ cornerTests: 0, sideRejections: 0, contained: 0, boundaryNodes: 0, axisTests: 0, parallelogramNodes: 0 });

export function createClassifierStats() {
  return { ...EMPTY_STATS };
}

export function emptyClassifierStats() {
  return { ...EMPTY_STATS };
}

/**
 * bounds: {minX, minY, maxX, maxY} in world units.
 * matrix: column-major 4x4 as used by the renderer (matrix[3], matrix[7],
 *         matrix[15] form the w row; z is not used).
 * Returns -1 outside, 0 intersecting, 1 fully contained.
 */
export function classifyProjectedBounds(bounds, matrix, { marginX = 1, marginY = 1, stats = null } = {}) {
  if (stats) stats.cornerTests++;
  let left = true, right = true, bottom = true, top = true;
  let inside = true;
  const xy = _scratch;
  for (let i = 0; i < 4; i++) {
    const corner = CORNER_ORDER[i];
    const x = corner & 1 ? bounds.maxX : bounds.minX;
    const y = corner & 2 ? bounds.maxY : bounds.minY;
    const w = matrix[3] * x + matrix[7] * y + matrix[15];
    if (!(w > 1e-8)) return 0;
    const cx = matrix[0] * x + matrix[4] * y + matrix[12];
    const cy = matrix[1] * x + matrix[5] * y + matrix[13];
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return 0;
    left = left && cx < -w * marginX;
    right = right && cx > w * marginX;
    bottom = bottom && cy < -w * marginY;
    top = top && cy > w * marginY;
    inside = inside && Math.abs(cx) <= w * marginX && Math.abs(cy) <= w * marginY;
    xy[i * 2] = cx / w;
    xy[i * 2 + 1] = cy / w;
  }
  if (left || right || bottom || top) {
    if (stats) stats.sideRejections++;
    return -1;
  }
  if (inside) {
    if (stats) stats.contained++;
    return 1;
  }
  if (stats) stats.boundaryNodes++;
  // The side test above settles both viewport axes. What remains are the edge
  // normals of the projected node: four for a general quadrilateral, two when
  // the projection is affine and the quadrilateral is therefore a parallelogram.
  const parallel = isParallelogram(xy);
  if (stats && parallel) stats.parallelogramNodes++;
  const axes = parallel ? 2 : 4;
  if (stats) stats.axisTests += axes;
  for (let i = 0; i < axes; i++) {
    if (separates(xy, i, marginX, marginY)) return -1;
  }
  return 0;
}

function isParallelogram(xy) {
  // e0 = p0->p1, e2 = p3->p2. Parallel (and equal) for an affine projection.
  const e0x = xy[2] - xy[0], e0y = xy[3] - xy[1];
  const e2x = xy[4] - xy[6], e2y = xy[5] - xy[7];
  const cross = e0x * e2y - e0y * e2x;
  const scale = Math.sqrt((e0x * e0x + e0y * e0y) * (e2x * e2x + e2y * e2y));
  const dot = e0x * e2x + e0y * e2y;
  return Math.abs(cross) <= 1e-9 * (1 + scale) && dot > 0;
}

function separates(xy, i, marginX, marginY) {
  const j = (i + 1) % 4;
  const nx = xy[j * 2 + 1] - xy[i * 2 + 1];
  const ny = xy[i * 2] - xy[j * 2];
  if (Math.abs(nx) + Math.abs(ny) < 1e-12) return false;
  const radius = Math.abs(nx) * marginX + Math.abs(ny) * marginY;
  let min = Infinity, max = -Infinity;
  for (let k = 0; k < 4; k++) {
    const value = nx * xy[k * 2] + ny * xy[k * 2 + 1];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const epsilon = 1e-10 * (1 + radius + Math.max(Math.abs(min), Math.abs(max)));
  return min > radius + epsilon || max < -radius - epsilon;
}

const CORNER_ORDER = [0, 1, 3, 2];
const _scratch = new Float64Array(8);

/**
 * World-space AABB of the margin-expanded viewport for a given matrix.
 *
 * The renderer's matrices are projective maps of the z = 0 plane, so the NDC
 * rectangle maps to a quadrilateral in world space and the AABB of that
 * quadrilateral contains every visible world point. Returns null when the map
 * is singular or crosses the horizon, in which case callers must not reuse a
 * cached selection.
 */
export function viewportWorldBox(matrix, { marginX = 1, marginY = 1 } = {}) {
  const a = matrix[0], b = matrix[4], c = matrix[12];
  const d = matrix[1], e = matrix[5], f = matrix[13];
  const g = matrix[3], h = matrix[7], i = matrix[15];
  const A = e * i - f * h, B = c * h - b * i, C = b * f - c * e;
  const D = f * g - d * i, E = a * i - c * g, F = c * d - a * f;
  const G = d * h - e * g, H = b * g - a * h, I = a * e - b * d;
  const det = a * A + b * D + c * G;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, inverseWSign = 0;
  for (let corner = 0; corner < 4; corner++) {
    const u = corner & 1 ? marginX : -marginX;
    const v = corner & 2 ? marginY : -marginY;
    const X = A * u + B * v + C;
    const Y = D * u + E * v + F;
    const W = G * u + H * v + I;
    if (!Number.isFinite(W) || Math.abs(W) < 1e-12) return null;
    // W is affine over the NDC rectangle. Opposite signs at its corners mean
    // a pole crosses the interior; four finite corner points cannot bound it.
    const sign = Math.sign(W);
    if (inverseWSign && sign !== inverseWSign) return null;
    inverseWSign = sign;
    const x = X / W, y = Y / W;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const forwardW = g * x + h * y + i;
    if (!Number.isFinite(forwardW) || !(forwardW > 1e-8)) return null;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** outer ⊇ inner (with a small absolute tolerance). */
export function boxContainsBox(outer, inner, tolerance = 1e-6) {
  if (!outer || !inner) return false;
  return inner.minX >= outer.minX - tolerance && inner.minY >= outer.minY - tolerance &&
    inner.maxX <= outer.maxX + tolerance && inner.maxY <= outer.maxY + tolerance;
}
