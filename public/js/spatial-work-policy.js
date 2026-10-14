/**
 * Choose whether a cold page needs a fine spatial index. The coarse count is
 * upper/lower bounds prove empty/dense cases. Dense draws the complete page/LOD,
 * never discards primitives. Retained fine indexes and Worker pages bypass the
 * cold gate because they can already provide a more selective answer.
 */
export function decideSpatialWork({ primitiveCount, coarseUpperBound = null, coarseLowerBound = 0,
  coarseComplete = false, hasFineIndex = false, hasWorkerPage = false,
  hasMovedGeometry = false, hasRemovedGeometry = false, lazyBuild = true, maxCandidateRatio = .15,
  denseGate = 'proven-lower' } = {}) {
  if (!Number.isSafeInteger(primitiveCount) || primitiveCount < 0) {
    throw new RangeError('primitiveCount must be a nonnegative safe integer');
  }
  if (!Number.isFinite(maxCandidateRatio) || maxCandidateRatio <= 0 || maxCandidateRatio > 1) {
    throw new RangeError('maxCandidateRatio must be in (0,1]');
  }
  if (!['proven-lower', 'upper-heuristic'].includes(denseGate)) throw new RangeError('unknown dense gate');
  if (!lazyBuild) return { action: 'refine', reason: 'eager-build' };
  if (hasFineIndex || hasWorkerPage) return { action: 'refine', reason: 'retained-fine-work' };
  if (hasMovedGeometry || hasRemovedGeometry) return { action: 'refine', reason: 'changed-geometry' };
  if (!coarseComplete) return { action: 'refine', reason: 'incomplete-coarse' };
  if (!Number.isSafeInteger(coarseUpperBound) || coarseUpperBound < 0 || coarseUpperBound > primitiveCount) {
    throw new RangeError('coarseUpperBound must be a conservative primitive count within the page');
  }
  if (!Number.isSafeInteger(coarseLowerBound) || coarseLowerBound < 0 || coarseLowerBound > coarseUpperBound) {
    throw new RangeError('coarseLowerBound must be within the coarse upper bound');
  }
  if (coarseUpperBound === 0) return { action: 'empty', reason: 'proven-empty' };
  const denseCount = denseGate === 'proven-lower' ? coarseLowerBound : coarseUpperBound;
  if (denseCount > primitiveCount * maxCandidateRatio) {
    return { action: 'dense-fallback', reason: denseGate === 'proven-lower' ? 'proven-coarse-density' : 'heuristic-coarse-density' };
  }
  return { action: 'refine', reason: 'selective-coarse' };
}
