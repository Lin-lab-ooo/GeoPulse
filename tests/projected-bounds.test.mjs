import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyProjectedBounds, createClassifierStats, viewportWorldBox, boxContainsBox
} from '../public/js/projected-bounds.js';

// Same construction as renderer._localMatrix, for a sandbox camera.
function localMatrix({ x = 0, y = 0, scale = 1, heading = 0, width = 800, height = 400 } = {}) {
  const m = new Float64Array(16);
  const c = Math.cos(heading), s = Math.sin(heading);
  const sx = 2 * scale / width, sy = 2 * scale / height;
  m[0] = c * sx; m[4] = -s * sx;
  m[1] = s * sy; m[5] = c * sy;
  m[10] = 1; m[15] = 1;
  m[12] = (-c * x + s * y) * sx;
  m[13] = (-s * x - c * y) * sy;
  return m;
}

// A tilted map view: a projective matrix with a non-trivial w row.
function tiltedMatrix({ x = 0, y = 0, scale = 1, heading = 0.4, tilt = 4e-4, width = 800, height = 400 } = {}) {
  const m = localMatrix({ x, y, scale, heading, width, height });
  m[3] = tilt * Math.sin(heading);
  m[7] = tilt * Math.cos(heading);
  m[15] = 1;
  return m;
}

const box = (minX, minY, maxX, maxY) => ({ minX, minY, maxX, maxY });

function project(matrix, x, y) {
  const w = matrix[3] * x + matrix[7] * y + matrix[15];
  return [(matrix[0] * x + matrix[4] * y + matrix[12]) / w, (matrix[1] * x + matrix[5] * y + matrix[13]) / w];
}

/** Safety net: a rejection must never hide a visible interior sample. */
function assertConservative(node, matrix, margins, result) {
  if (result !== -1) return;
  for (let i = 0; i <= 6; i++) {
    for (let j = 0; j <= 6; j++) {
      const x = node.minX + (node.maxX - node.minX) * i / 6;
      const y = node.minY + (node.maxY - node.minY) * j / 6;
      const [nx, ny] = project(matrix, x, y);
      assert.ok(Math.abs(nx) > margins.marginX || Math.abs(ny) > margins.marginY,
        `node ${JSON.stringify(node)} rejected but sample ${x},${y} projects to ${nx},${ny}`);
    }
  }
}

test('classification matches side tests for axis-aligned nodes', () => {
  const matrix = localMatrix({ width: 800, height: 400 }); // world ±400 x ±200 visible
  assert.equal(classifyProjectedBounds(box(-10, -10, 10, 10), matrix), 1, 'centred node is contained');
  assert.equal(classifyProjectedBounds(box(1000, 1000, 1100, 1100), matrix), -1, 'far node is outside');
  assert.equal(classifyProjectedBounds(box(390, -10, 470, 10), matrix), 0, 'straddling node intersects');
});

test('affine projections are detected as parallelograms and use two axes', () => {
  const matrix = localMatrix({ heading: 0.7, x: 40, y: -25, scale: 1.2, width: 900, height: 500 });
  const stats = createClassifierStats();
  let boundary = 0;
  for (let i = 0; i < 300; i++) {
    const cx = -600 + i * 4;
    const node = box(cx, -150 + (i % 7) * 40, cx + 120, -110 + (i % 7) * 40);
    const result = classifyProjectedBounds(node, matrix, { stats, marginX: 1.05, marginY: 1.05 });
    assertConservative(node, matrix, { marginX: 1.05, marginY: 1.05 }, result);
    if (result === 0) boundary++;
  }
  assert.ok(boundary > 0, 'the sweep must produce intersecting boundary nodes');
  assert.equal(stats.parallelogramNodes, stats.boundaryNodes, 'every affine boundary node is a parallelogram');
  assert.equal(stats.axisTests, stats.boundaryNodes * 2, 'and costs exactly two axes');
});

test('projective (tilted) projections keep all four axes', () => {
  const matrix = tiltedMatrix({ scale: 1.2, width: 900, height: 500 });
  const stats = createClassifierStats();
  for (let i = 0; i < 300; i++) {
    const cx = -600 + i * 4;
    const node = box(cx, -150 + (i % 7) * 40, cx + 120, -110 + (i % 7) * 40);
    const result = classifyProjectedBounds(node, matrix, { stats, marginX: 1.05, marginY: 1.05 });
    assertConservative(node, matrix, { marginX: 1.05, marginY: 1.05 }, result);
  }
  assert.ok(stats.axisTests > stats.parallelogramNodes * 2, 'tilted quads need the full axis set');
  assert.ok(stats.boundaryNodes > 0);
});

test('no rejection is ever unsafe across poses, margins and tilts', () => {
  const poses = [
    { matrix: localMatrix({ heading: 0, width: 800, height: 400 }), margins: { marginX: 1, marginY: 1 } },
    { matrix: localMatrix({ heading: 1.1, x: 33, y: 12, scale: 0.8, width: 800, height: 400 }), margins: { marginX: 1.1, marginY: 1.3 } },
    { matrix: localMatrix({ heading: -2.4, x: -120, y: 260, scale: 2.2, width: 640, height: 480 }), margins: { marginX: 1.02, marginY: 1.02 } },
    { matrix: tiltedMatrix({ heading: 0.9, scale: 1.5, width: 900, height: 600 }), margins: { marginX: 1.05, marginY: 1.05 } }
  ];
  let rejected = 0;
  for (const { matrix, margins } of poses) {
    for (let i = 0; i < 220; i++) {
      const cx = -800 + i * 8;
      const cy = -300 + (i % 11) * 55;
      const node = box(cx, cy, cx + 60 + (i % 5) * 40, cy + 45);
      const result = classifyProjectedBounds(node, matrix, margins);
      assertConservative(node, matrix, margins, result);
      if (result === -1) rejected++;
    }
  }
  assert.ok(rejected > 0, 'the sweep must actually reject some nodes');
});

test('visible nodes are never dropped', () => {
  const matrix = localMatrix({ heading: 0.35, x: 5, y: -9, width: 800, height: 400 });
  const margins = { marginX: 1.02, marginY: 1.02 };
  for (let i = -8; i <= 8; i++) {
    for (let j = -6; j <= 6; j++) {
      const node = box(i * 30, j * 30, i * 30 + 30, j * 30 + 30);
      const [nx, ny] = project(matrix, i * 30 + 15, j * 30 + 15);
      const centreVisible = Math.abs(nx) <= margins.marginX && Math.abs(ny) <= margins.marginY;
      const result = classifyProjectedBounds(node, matrix, margins);
      if (centreVisible) assert.notEqual(result, -1, `centre-visible node ${i},${j} must be kept`);
    }
  }
});

test('viewportWorldBox inverts the local matrix back to world units', () => {
  const camera = { x: 30, y: -12, scale: 1, heading: 0 };
  const matrix = localMatrix({ ...camera, width: 800, height: 400 });
  const world = viewportWorldBox(matrix, { marginX: 1, marginY: 1 });
  assert.ok(Math.abs(world.minX - (camera.x - 400)) < 1e-6, `minX ${world.minX}`);
  assert.ok(Math.abs(world.maxX - (camera.x + 400)) < 1e-6);
  assert.ok(Math.abs(world.minY - (camera.y - 200)) < 1e-6);
  assert.ok(Math.abs(world.maxY - (camera.y + 200)) < 1e-6);
});

test('viewportWorldBox grows with rotation and margins', () => {
  const flat = viewportWorldBox(localMatrix({ width: 800, height: 400 }), { marginX: 1, marginY: 1 });
  const rotated = viewportWorldBox(localMatrix({ heading: Math.PI / 4, width: 800, height: 400 }), { marginX: 1, marginY: 1 });
  assert.ok(rotated.minX < flat.minX && rotated.maxY > flat.maxY, 'a rotated viewport needs a larger world AABB');
  const wide = viewportWorldBox(localMatrix({ width: 800, height: 400 }), { marginX: 1.2, marginY: 1.2 });
  assert.ok(wide.minX < flat.minX && wide.maxX > flat.maxX, 'margins widen the box');
});

test('viewportWorldBox reports failure instead of guessing', () => {
  assert.equal(viewportWorldBox(new Float64Array(16)), null, 'zero matrix is singular');
  const degenerate = localMatrix({ width: 800, height: 400 });
  degenerate[3] = 0; degenerate[7] = 0; degenerate[15] = 0;
  assert.equal(viewportWorldBox(degenerate), null, 'an all-zero w row is singular');
  // A w row whose zero line passes exactly through the (1,1) NDC corner.
  const horizon = new Float64Array(16);
  horizon[0] = 1; horizon[5] = 1; horizon[15] = 1; horizon[3] = 0.5; horizon[7] = 0.5;
  assert.equal(viewportWorldBox(horizon), null, 'a corner on the horizon is rejected');
  horizon[3] = 2; horizon[7] = 0;
  assert.equal(viewportWorldBox(horizon), null, 'finite corners on opposite sides of an interior pole are rejected');
  horizon[3] = 0; horizon[15] = -1;
  assert.equal(viewportWorldBox(horizon), null, 'an algebraic inverse behind the eye is not a visible viewport');
});

test('the world box really contains everything the classifier keeps', () => {
  const camera = { x: 120, y: -60, scale: 1.4, heading: 0.8 };
  const matrix = localMatrix({ ...camera, width: 800, height: 400 });
  const world = viewportWorldBox(matrix, { marginX: 1.02, marginY: 1.02 });
  for (let i = 0; i <= 40; i++) {
    for (let j = 0; j <= 40; j++) {
      const x = camera.x - 400 + i * 20;
      const y = camera.y - 400 + j * 20;
      const [nx, ny] = project(matrix, x, y);
      if (Math.abs(nx) <= 1.02 && Math.abs(ny) <= 1.02) {
        assert.ok(x >= world.minX && x <= world.maxX && y >= world.minY && y <= world.maxY,
          `visible point ${x},${y} outside the cached world box`);
      }
    }
  }
});

test('containment decides selection reuse', () => {
  const outer = box(0, 0, 100, 100);
  assert.ok(boxContainsBox(outer, box(10, 10, 90, 90)));
  assert.ok(boxContainsBox(outer, outer));
  assert.ok(!boxContainsBox(outer, box(10, 10, 110, 90)));
  assert.ok(!boxContainsBox(null, outer) && !boxContainsBox(outer, null));

  // The coverage must be the actual queried clip rectangle, never an inflated
  // AABB. A contained world AABB is a sufficient, deliberately conservative proof.
  const camera = { x: 0, y: 0, scale: 1, heading: 0 };
  const margins = { marginX: 1.05, marginY: 1.05 };
  const built = { ...camera, width: 800, height: 400 };
  const builtMatrix = localMatrix(built);
  const cached = viewportWorldBox(builtMatrix, margins);
  const at = pose => viewportWorldBox(localMatrix({ ...camera, ...pose, width: 800, height: 400 }), margins);

  assert.ok(boxContainsBox(cached, at({})), 'an unchanged pose reuses the candidate set');
  assert.ok(boxContainsBox(cached, at({ scale: 1.4 })), 'zoom-in reuses the candidate set');
  assert.ok(!boxContainsBox(cached, at({ x: 15 })), 'a same-size pan exposes an unqueried strip');
  assert.ok(!boxContainsBox(cached, at({ heading: 0.02 })), 'a same-size rotation cannot invent coverage');
  assert.ok(!boxContainsBox(cached, at({ x: 300 })), 'a large pan must re-query');
  assert.ok(!boxContainsBox(cached, at({ heading: 0.6 })), 'a large rotation must re-query');
  assert.ok(!boxContainsBox(cached, at({ scale: 0.6 })), 'zoom-out must re-query');

  // Soundness: anything visible under the query margins of a *reusing* pose
  // must lie inside the box the cached selection was built for.
  const reusePose = { ...camera, x: 15, scale: 1.4, heading: 0.02, width: 800, height: 400 };
  const reuseMatrix = localMatrix(reusePose);
  assert.ok(boxContainsBox(cached, viewportWorldBox(reuseMatrix, margins)), 'the extreme reusing pose is covered');
  assert.equal(classifyProjectedBounds(viewportWorldBox(reuseMatrix, margins), builtMatrix, margins), 1);
  for (let i = 0; i <= 50; i++) {
    for (let j = 0; j <= 50; j++) {
      const x = camera.x - 500 + i * 20;
      const y = camera.y - 500 + j * 20;
      const [nx, ny] = project(reuseMatrix, x, y);
      if (Math.abs(nx) <= margins.marginX && Math.abs(ny) <= margins.marginY) {
        assert.ok(x >= cached.minX && x <= cached.maxX && y >= cached.minY && y <= cached.maxY,
          `visible point ${x},${y} was not covered by the cached selection box`);
      }
    }
  }
});

test('rotated viewport AABB containment does not prove queried clip containment', () => {
  const old = localMatrix({ width: 800, height: 400, heading: Math.PI / 4 });
  const now = localMatrix({ width: 650, height: 650 });
  const oldBox = viewportWorldBox(old), nowBox = viewportWorldBox(now);
  assert.ok(boxContainsBox(oldBox, nowBox), 'the new square fits the old rotated AABB');
  assert.notEqual(classifyProjectedBounds(nowBox, old), 1, 'but its corners are outside the old queried clip rectangle');
});
