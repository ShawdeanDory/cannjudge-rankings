import { completeSnapshot, currentRows, isPass } from './score-replay.js?v=2';

const HOUR = 3600;
export const ACTIVITY_LIMIT = 10;

export function emptyHistory() {
  return { samples: [], events: [], latest: null };
}

export function recordRanking(history, data) {
  const at = Math.floor(data?.generated_at);
  if (!Number.isFinite(at) || at <= (history.latest?.at || 0) || !completeSnapshot(data)) return;
  const totals = data.total.rows.map(({ team, score }) => [team, score]);
  const previous = history.latest;
  const previousTotals = new Map((history.samples.at(-1)?.scores || []).map(([team, score], index) => [team, { score, rank: index + 1 }]));
  const currentTotals = new Map(totals.map(([team, score], index) => [team, { score, rank: index + 1 }]));
  const oldProblems = new Map(previous?.problems);
  const events = new Map(history.events);
  const problems = [];
  for (const problem of data.problems) {
    const prior = new Map(oldProblems.get(problem.id));
    const rows = [];
    for (const [team, row] of currentRows(data, problem)) {
      if (!row.sid || !Number.isFinite(Date.parse(row.time))) continue;
      const now = { sid: row.sid, time: Date.parse(row.time), score: isPass(row) ? row.score : 0, rank: isPass(row) ? row.rank : null };
      rows.push([team, now]);
      if (!previous || !oldProblems.has(problem.id)) continue;
      const old = prior.get(team);
      if (old?.sid === now.sid || now.time <= (old?.time ?? previous.at * 1000)) continue;
      const before = previousTotals.get(team);
      const after = currentTotals.get(team);
      const teamEvents = events.get(team) || [];
      teamEvents.push({
        pid: problem.id, sid: now.sid, time: now.time, at, score: now.score, rank: now.rank,
        previousScore: old?.score ?? 0, previousRank: old?.rank ?? null,
        totalDelta: before && after ? Math.round((after.score - before.score) * 100) / 100 : null,
        totalRankDelta: before && after ? before.rank - after.rank : null,
      });
      events.set(team, teamEvents);
    }
    problems.push([problem.id, rows]);
  }
  for (const [team, entries] of events) {
    entries.sort((a, b) => b.time - a.time || b.at - a.at);
    const seen = new Set();
    events.set(team, entries.filter((item, index) => {
      const firstForProblem = !seen.has(item.pid);
      seen.add(item.pid);
      return index < ACTIVITY_LIMIT || firstForProblem;
    }));
  }
  history.events = [...events];
  history.latest = { at, problems };
  history.samples = [...history.samples.filter(sample => sample.at >= at - 6 * HOUR), { at, scores: totals }];
}

export function fiveHourBaseline(history, at) {
  if (!Number.isFinite(at)) return null;
  const target = at - 5 * HOUR;
  const best = history.samples.reduce((closest, sample) => {
    if (Math.abs(sample.at - target) > 30 * 60) return closest;
    return !closest || Math.abs(sample.at - target) < Math.abs(closest.at - target) ? sample : closest;
  }, null);
  return best;
}
