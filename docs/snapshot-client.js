const CONTEST = '6a9e2d04bf41025d60f21804';
const UPSTREAM = 'https://cannjudge.cn';

export async function buildSnapshot(get) {
  const [contest, problems, stats] = await Promise.all([
    get(`/api/contests/${CONTEST}`),
    get(`/api/problems/contest/${CONTEST}`),
    get(`/api/submissions/contest/${CONTEST}/stats`),
  ]);
  if (!Array.isArray(problems) || !problems.length || !Array.isArray(stats)) {
    throw new Error('Unexpected contest response');
  }
  const total = stats.map(item => ({
    team: item.team?.team_name || item.team?.name || item.team?.team_id || '',
    score: Number(Number(item.score || 0).toFixed(2)),
    pass: Number(item.passCount || 0), attempt: Number(item.attemptCount || 0),
    subs: Number(item.submissionCount || 0),
  })).filter(row => row.team);
  if (!total.length) throw new Error('Empty contest leaderboard');
  total.sort((a, b) => b.score - a.score || b.pass - a.pass || a.subs - b.subs || a.team.localeCompare(b.team));
  total.forEach((row, i) => { row.rank = i + 1; });
  const entries = await Promise.all(problems.map(async problem => {
    const path = `/api/problems/${problem._id}/ranking`;
    const first = await get(path, { contestId: CONTEST, page: 1, size: 100 });
    const pages = Number(first.pages || 1);
    if (!Number.isInteger(pages) || pages < 1 || pages > 30) throw new Error('Invalid pagination');
    const raw = [...(first.rows || [])];
    for (let page = 2; page <= pages; page++) {
      const chunk = await get(path, { contestId: CONTEST, page, size: 100 });
      raw.push(...(chunk.rows || []));
    }
    const expected = Number(first.total || raw.length);
    if (!raw.length || raw.length !== expected) throw new Error('Incomplete problem leaderboard');
    const rows = raw.map((item, i) => ({
      rank: Number(item.rank || i + 1),
      team: item.team?.team_name || item.team?.name || item.team?.team_id || item.submitter?.nickname || item.user?.nickname || '未知队伍',
      user: item.submitter?.nickname || item.user?.nickname || '',
      score: Number(Number(item.score || 0).toFixed(2)),
      status: item.status || item.submission?.status || '',
      time: item.create_time || item.submission?.create_time || '',
      sid: item.submission_id || item.submission?._id || '',
    })).sort((a, b) => a.rank - b.rank);
    return [problem._id, { rows, at: Date.now() / 1000, error: null, total: expected, complete: true }];
  }));
  const now = Date.now() / 1000;
  return {
    app: 'cannjudge-rank-monitor', app_version: '1.1.0', mode: 'worker', ready: true,
    version: Date.now(), generated_at: now, server_time: now,
    contest: { title: contest.title || '华为ICT大赛', name: 'ictcompetition', url: `${UPSTREAM}/public/ictcompetition` },
    problems: problems.map(p => ({ id: p._id, name: p.name, title: p.title || p.name || p._id })),
    total: { rows: total, at: now, error: null }, by_problem: Object.fromEntries(entries),
  };
}

