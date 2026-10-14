/** Terminal state shared by live UI and exported records. */
export function markRunOutcome(current, outcome, ended, error = null) {
  if (!['completed', 'cancelled', 'failed'].includes(outcome)) throw new RangeError('Unknown run outcome');
  if (!Number.isFinite(ended)) throw new TypeError('Run end time must be finite');
  current.outcome = outcome;
  current.finished = true;
  current.cancelled = outcome !== 'completed';
  current.ended = ended;
  if (error) current.failureReason = error.message || String(error);
  return current;
}

/** Counts acknowledged while active; cancellation may leave later GL work unobserved. */
export function runGeometryProgress(current) {
  const stagedVertices = Number.isFinite(current.uploadedVertices) ? current.uploadedVertices : 0;
  const confirmedVertices = Number.isFinite(current.confirmedVertices) ? current.confirmedVertices : 0;
  const fullyAcknowledgedVertices = Number.isFinite(current.acknowledgedVertices) ? current.acknowledgedVertices : 0;
  return {stagedVertices,confirmedVertices,fullyAcknowledgedVertices,
    unacknowledgedConfirmedVertices:Math.max(0,confirmedVertices-fullyAcknowledgedVertices)};
}

export function runOutcome(current, now) {
  const state = current.outcome || (current.finished ? (current.cancelled ? 'cancelled' : 'completed') : 'running');
  const end = state === 'running' ? now : current.ended;
  const elapsedMs = Number.isFinite(end) && Number.isFinite(current.started) ? Math.max(0, end - current.started) : null;
  const submitted = Number.isFinite(current.shown) ? current.shown : 0;
  const geometry = runGeometryProgress(current);
  const partial = submitted ? '部分已提交' : geometry.confirmedVertices ? '部分几何已确认' : geometry.stagedVertices ? '几何暂存，确认未完成' : '未提交';
  return {
    state, elapsedMs, submitted, geometry,
    throughput: elapsedMs > 0 ? submitted * 1000 / elapsedMs : null,
    timeLabel: {running:'运行', completed:'完成', cancelled:'已停止', failed:'失败'}[state],
    progressLabel: {running:'加载中', completed:'已完成', cancelled:`已停止（${partial}）`, failed:`失败（${partial}）`}[state],
  };
}
