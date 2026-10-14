// Fixed seeds/material, independent nearest-vertex oracle. No renderer helper.
export const PICK_SEEDS = [1031, 1033, 1039];
export const PICK_SIZES = [60000, 300000];
export const PICK_DISTRIBUTIONS = ['uniform', 'clusters'];
const randomFor = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
export function createPickMaterial({ count = 60000, distribution = 'uniform', seed = 1031, moved = 0 } = {}) {
  if (!Number.isInteger(count) || count < 4096 || !['uniform', 'clusters', 'coincident'].includes(distribution) || ![0, 4096].includes(moved)) throw new RangeError('Invalid pick material');
  const random = randomFor(seed), positions = new Float32Array(count * 2), colors = new Uint8Array(count * 4), ids = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const cluster = i % 4, x = distribution === 'uniform' ? (random() - .5) * 4800 : distribution === 'coincident' ? 0 : (cluster & 1 ? 180 : -180) + (random() - .5) * 180;
    const y = distribution === 'uniform' ? (random() - .5) * 3600 : distribution === 'coincident' ? 0 : (cluster & 2 ? 120 : -120) + (random() - .5) * 140;
    positions.set([x, y], i * 2); colors.set([30, 135, 225, 173], i * 4); ids[i] = i + 1;
  }
  const updates = [];
  for (let i = 0; i < moved; i++) {
    const slot = Math.floor(i * (count - 1) / (moved - 1));
    updates.push({ id: slot + 1, x: i % 2 ? 6000 + i : (random() - .5) * 700, y: i % 2 ? 5000 + i : (random() - .5) * 500 });
  }
  return { group: { kind: 'points', positions, colors, ids, featureCount: count }, updates, meta: { count, distribution, seed, moved } };
}
export function pickMatrix(heading = 0, width = 800, height = 600) {
  const m = new Float64Array(16), c = Math.cos(heading), s = Math.sin(heading);
  m[0] = 2 * c / width; m[4] = -2 * s / width; m[1] = 2 * s / height; m[5] = 2 * c / height; m[10] = m[15] = 1; return m;
}
export function createPickTrace(renderer, seed = 1031) {
  const random = randomFor(seed + 200), matrices = [pickMatrix(), pickMatrix(.61)], queries = [];
  for (let view = 0; view < matrices.length; view++) {
    const matrix = matrices[view], targets = [];
    for (const page of renderer.pages.points) for (let v = 0; v < page.count && targets.length < 16; v++) {
      const x = page.positions[v * 2], y = page.positions[v * 2 + 1];
      const px = ((matrix[0] * x + matrix[4] * y) + 1) * 400, py = (1 - matrix[1] * x - matrix[5] * y) * 300;
      if (px > 40 && px < 760 && py > 40 && py < 560) targets.push({ px, py });
    }
    for (let n = 0; n < 16; n++) {
      const target = n % 2 === 0 && targets.length ? targets[n % targets.length] : { px: 20 + random() * 760, py: 20 + random() * 560 };
      queries.push({ matrix, px: target.px, py: target.py });
    }
  }
  return queries;
}
export function exactPickOracle(renderer, query) {
  const m = query.matrix, radius = Math.max(10, renderer.pointSize * 2); let distance = radius ** 2, best = { hit: false };
  for (const kind of ['points', 'lines', 'polygons']) {
    if (!renderer.layers[kind]) continue;
    for (const page of renderer.pages[kind]) for (let vertex = 0; vertex < page.count; vertex++) {
      if (page.overlayRemoved.has(vertex) || page.colors[vertex * 4 + 3] === 0) continue;
      const alert = page.colors[vertex * 4] >= 210 && page.colors[vertex * 4 + 1] < 240 && page.colors[vertex * 4 + 2] < 120;
      if (kind === 'points' && renderer._frame.lodStride > 1 && vertex % renderer._frame.lodStride !== 0 && !(renderer.riskPreservation && alert)) continue;
      const x = page.positions[vertex * 2], y = page.positions[vertex * 2 + 1], w = m[3] * x + m[7] * y + m[15];
      if (!(w > 0)) continue;
      const px = ((m[0] * x + m[4] * y + m[12]) / w + 1) * renderer.width / 2;
      const py = (1 - (m[1] * x + m[5] * y + m[13]) / w) * renderer.height / 2;
      const d = (px - query.px) ** 2 + (py - query.py) ** 2;
      if (d < distance) { distance = d; best = { hit: true, id: page.ids[vertex], kind, x, y }; }
    }
  }
  return best;
}
export const comparablePick = event => event?.hit ? { hit: true, id: event.id, kind: event.kind, x: event.x, y: event.y } : { hit: false };
