// Main-thread staging is cooperative. The budget is checked after a complete
// primitive-aligned slice; it is not a hard frame deadline or a GPU timer.
const ALIASES = { point: 'points', line: 'lines', polygon: 'polygons', points: 'points', lines: 'lines', polygons: 'polygons' };
const PRIMITIVES = { points: 1, lines: 2, polygons: 3 };

export function stagingPolicy({ mode = 'fixed', interacting = false, adaptiveBudgetMs = 4 } = {}) {
  if (mode === 'baseline') return { budgetMs: Infinity, maxVertices: 4096 };
  const requested = mode === 'adaptive' && Number.isFinite(adaptiveBudgetMs) ? adaptiveBudgetMs : 4;
  return { budgetMs: Math.max(1, Math.min(requested, interacting ? 2 : 4)), maxVertices: interacting ? 1024 : 4096 };
}

/** All slices must be submitted before the caller may acknowledge a batch. */
export async function stageGeometryBatch({ batch, getPolicy, append, awaitCommit, getCommitStats,
  isCancelled = () => false, onSlice = () => {}, onCommit = () => {}, clock = () => performance.now() }) {
  const initial = getCommitStats();
  let revision = initial.stagingRevision, confirmedRevision = initial.committedRevision;
  let uploadBefore = initial.glUploadSubmissionMs, spanStarted = clock(), spanStagingMs = 0;
  let stagingMs = 0, vertices = 0, yields = 0;
  const commit = async () => {
    if (isCancelled()) return false;
    const stats = await awaitCommit(revision);
    if (isCancelled()) return false;
    confirmedRevision = Math.max(confirmedRevision, stats.committedRevision);
    if (confirmedRevision < revision) throw new Error('Geometry commit returned before the requested revision.');
    onCommit({ revision, stats, confirmedVertices: vertices, stagingMs: spanStagingMs,
      uploadSubmissionMs: Math.max(0, stats.glUploadSubmissionMs - uploadBefore) });
    uploadBefore = stats.glUploadSubmissionMs;
    spanStagingMs = 0; spanStarted = clock();
    return true;
  };
  for (const group of batch.groups) {
    const kind = ALIASES[group.kind], primitive = PRIMITIVES[kind];
    if (!primitive) throw new TypeError('Unknown geometry group.');
    const count = group.positions.length / 2;
    let offset = 0;
    while (offset < count) {
      if (isCancelled()) return { cancelled: true, revision, stagingMs, vertices, yields };
      const policy = getPolicy();
      if (!(policy.budgetMs > 0) || !Number.isSafeInteger(policy.maxVertices) || policy.maxVertices < primitive) {
        throw new RangeError('Invalid geometry staging policy.');
      }
      const size = Math.min(Math.floor(policy.maxVertices / primitive) * primitive, count - offset);
      const started = clock();
      const featureCount = offset + size === count ? group.featureCount : 0;
      const result = append({ groups: [{ kind,
        positions: group.positions.subarray(offset * 2, (offset + size) * 2),
        colors: group.colors.subarray(offset * 4, (offset + size) * 4),
        ids: group.ids.subarray(offset, offset + size), featureCount }], featureCount }, { summaryOnly: true });
      revision = result.revision;
      const spent = Math.max(0, clock() - started);
      stagingMs += spent; spanStagingMs += spent; vertices += size; offset += size;
      onSlice({ vertices: size, stagingMs: spent, revision, budgetMs: policy.budgetMs });
      // Include time spent in slice bookkeeping in the cooperative budget.
      if (clock() - spanStarted >= policy.budgetMs) {
        yields++;
        if (!await commit()) return { cancelled: true, revision, stagingMs, vertices, yields };
      }
    }
  }
  if (revision > confirmedRevision && !await commit()) return { cancelled: true, revision, stagingMs, vertices, yields };
  return { cancelled: false, revision, stagingMs, vertices, yields };
}
