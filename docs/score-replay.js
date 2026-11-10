export const isPass = row => ['Pass', 'Accepted'].includes(row?.status);
const cents = score => Math.round(score * 100);
const byScore = (a, b) => b.score - a.score || a.submittedAt - b.submittedAt || a.id.localeCompare(b.id);

export function createArchive() {
  return { firstAt: 0, latestAt: 0, problems: new Map() };
}

function remember(archive, pid, team, peak) {
  if (!archive.problems.has(pid)) archive.problems.set(pid, new Map());
  const teams = archive.problems.get(pid);
  const entries = teams.get(team) || [];
  const previous = entries.find(row => row.id === peak.id);
  if (previous && (previous.score > peak.score ||
    (previous.score === peak.score && previous.observedAt <= peak.observedAt))) return;
  const next = entries.filter(row => row.id !== peak.id);
  next.push(peak);
  teams.set(team, next.sort(byScore).slice(0, 2));
}

export function mergeArchive(archive, data) {
  if (!data?.firstAt || !data.latestAt) return;
  archive.firstAt = Math.min(archive.firstAt || data.firstAt, data.firstAt);
  archive.latestAt = Math.max(archive.latestAt, data.latestAt);
  for (const [pid, teams] of data.problems) {
    for (const [team, entries] of teams) {
      for (const [score, id, submittedAt, observedAt] of entries) {
        remember(archive, pid, team, { score, id, submittedAt, observedAt });
      }
    }
  }
}

export function encodeArchive(archive) {
  return {
    firstAt: archive.firstAt, latestAt: archive.latestAt,
    problems: [...archive.problems].map(([pid, teams]) => [pid,
      [...teams].map(([team, entries]) => [team,
        entries.map(p => [p.score, p.id, p.submittedAt, p.observedAt])])]),
  };
}

export function currentRows(data, problem) {
  const result = new Map();
  for (const row of data.by_problem[problem.id].rows) {
    if (!result.has(row.team)) result.set(row.team, row);
  }
  return result;
}

export function completeSnapshot(data) {
  return data?.ready && data.total?.rows?.length && !data.total.error && data.problems?.length &&
    data.problems.every(p => data.by_problem?.[p.id]?.complete && !data.by_problem[p.id].error);
}

export function observeSnapshot(archive, data) {
  if (!completeSnapshot(data)) return;
  const observedAt = Math.floor(data.generated_at);
  if (!observedAt) return;
  archive.firstAt = Math.min(archive.firstAt || observedAt, observedAt);
  archive.latestAt = Math.max(archive.latestAt, observedAt);
  for (const problem of data.problems) {
    for (const [team, row] of currentRows(data, problem)) {
      const submittedAt = Date.parse(row.time);
      if (isPass(row) && row.sid && Number.isFinite(submittedAt) && Number.isFinite(row.score)) {
        remember(archive, problem.id, team, { score: cents(row.score), id: row.sid, submittedAt, observedAt });
      }
    }
  }
}

export function problemPeaks(data, archive) {
  const result = new Map();
  for (const problem of data.problems || []) {
    let highest;
    for (const [team, entries] of archive.problems.get(problem.id) || []) {
      const peak = entries[0];
      if (peak && (!highest || peak.score > highest.score)) highest = { team, score: peak.score };
    }
    if (highest) result.set(problem.id, highest);
  }
  return result;
}

function threshold(problem, challenger, selected) {
  const { weight, leader, leaderScore } = problem;
  const gap = selected.replay - challenger.replay;
  const withoutBonus = Math.floor(gap / weight) + 1;
  if (withoutBonus <= leaderScore) return withoutBonus;
  const bonus = 1000 * (leader === selected.team ? 2 : 1);
  return Math.max(leaderScore + 1, Math.floor(gap / weight - bonus) + 1);
}

export function replayScores(data, archive, selectedTeam) {
  if (!completeSnapshot(data) || !data.problems.every(p => [1, 2, 3].includes(Number(p.difficulty)))) return null;
  const asOf = Math.floor(data.generated_at);
  const teams = new Map(data.total.rows.map(row => [row.team, {
    ...row, replay: 0, replayPass: 0, drops: [], missing: [], thresholds: [],
  }]));
  let ambiguousLeaders = 0;
  for (const problem of data.problems) {
    const weight = Number(problem.difficulty);
    const current = currentRows(data, problem);
    const historical = archive.problems.get(problem.id);
    const candidates = [];
    for (const row of teams.values()) {
      const latest = current.get(row.team);
      const base = isPass(latest) ? cents(latest.score) : 0;
      const peaks = (historical?.get(row.team) || []).filter(peak => peak.observedAt <= asOf);
      const earlier = peaks.find(peak => latest?.sid && peak.id !== latest.sid &&
        peak.submittedAt < Date.parse(latest.time) && peak.score - base >= 500);
      if (earlier) row.drops.push({ problem, earlier, latest, base, weight });
      const restore = peaks[0]?.score > base ? peaks[0] : null;
      if (isPass(latest) || restore) {
        const score = restore?.score ?? base;
        row.replay += weight * score;
        row.replayPass++;
        candidates.push({ row, score, restored: Boolean(restore), currentWinner: latest?.rank === 1 && !restore,
          submittedAt: restore?.submittedAt ?? (Date.parse(latest?.time) || Infinity) });
      } else {
        row.missing.push({ problem, weight });
      }
    }
    candidates.sort((a, b) => b.score - a.score || Number(b.currentWinner) - Number(a.currentWinner)
      || a.submittedAt - b.submittedAt || a.row.rank - b.row.rank);
    const leader = candidates[0];
    if (leader) {
      leader.row.replay += weight * 1000;
      if (candidates[1]?.score === leader.score &&
        (!leader.currentWinner || candidates.some(row => row.score === leader.score && row.restored))) ambiguousLeaders++;
    }
    for (const row of teams.values()) {
      const missing = row.missing.at(-1);
      if (missing?.problem === problem) {
        missing.leader = leader?.row.team;
        missing.leaderScore = leader?.score ?? 0;
      }
    }
  }
  const ranked = [...teams.values()].sort((a, b) => b.replay - a.replay ||
    b.replayPass - a.replayPass || a.subs - b.subs || a.rank - b.rank);
  const selected = teams.get(selectedTeam);
  ranked.forEach((row, index) => {
    row.replayRank = index + 1;
    if (selected && row !== selected && row.replay <= selected.replay) {
      row.thresholds = row.missing.map(problem => ({ ...problem, score: threshold(problem, row, selected) }))
        .filter(p => p.score <= 10000).sort((a, b) => a.score - b.score);
    }
  });
  return { ranked, selected, ambiguousLeaders };
}
