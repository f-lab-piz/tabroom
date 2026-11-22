export const previewStages = ['none', 'total', 'active'];

export function cpuCounters(info) {
  if (!info?.processors?.length) return null;
  let total = 0;
  let idle = 0;
  for (const {usage} of info.processors) {
    total += usage.total;
    idle += usage.idle;
  }
  return Number.isFinite(total) && Number.isFinite(idle) ? {total, idle} : null;
}

export function cpuPercent(before, after) {
  if (!before || !after) return null;
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  if (total <= 0 || idle < 0 || idle > total) return null;
  return 100 * (total - idle) / total;
}

export function updateAutoPreview(state, average, now) {
  const wanted = average >= 80 ? 2 : average >= 60 ? 1 : 0;
  if (wanted >= state.stage) return {stage:wanted};
  if (state.wanted !== wanted) return {stage:state.stage, wanted, since:now};
  if (now - state.since >= 10000) return {stage:state.stage - 1};
  return state;
}

export function workPreviewDeadline(work) {
  if (!work || work.endedAt === undefined) return null;
  return work.endedAt + (work.loading ? 8000 : 2000);
}
