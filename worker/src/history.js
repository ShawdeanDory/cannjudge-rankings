const HOUR = 3600;
const MAX_BASELINE_GAP = 30 * 60;
const BUCKETS = 64;

function bucket(team) {
  let hash = 0;
  for (let i = 0; i < team.length; i++) hash = (Math.imul(hash, 31) + team.charCodeAt(i)) >>> 0;
  return hash % BUCKETS;
}

export class RankingStore {
  constructor(ctx) {
    this.storage = ctx.storage;
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS totals (at INTEGER PRIMARY KEY, scores TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS problems (bucket INTEGER NOT NULL, at INTEGER NOT NULL, scores TEXT NOT NULL,
        PRIMARY KEY (bucket, at)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS problems_at ON problems(at);
      CREATE TABLE IF NOT EXISTS backup (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, body TEXT NOT NULL)`);
  }

  async fetch(request) {
    switch (new URL(request.url).pathname) {
      case '/record': return this.record(await request.text());
      case '/history': {
        const { at, teams } = await request.json();
        return Response.json(this.history(at, teams));
      }
      case '/backup': {
        const row = this.sql.exec('SELECT body FROM backup WHERE id = 1').toArray()[0];
        return row ? new Response(row.body, { headers: { 'Content-Type': 'application/json' } })
          : Response.json({ error: 'No backup yet' }, { status: 503 });
      }
      default: return new Response(null, { status: 404 });
    }
  }

  record(body) {
    let data;
    try { data = JSON.parse(body); } catch { return Response.json({ error: 'Invalid snapshot' }, { status: 400 }); }
    const at = Math.floor(data?.generated_at);
    const now = Math.floor(Date.now() / 1000);
    const total = data?.total?.rows;
    if (!Number.isSafeInteger(at) || at < now - 26 * HOUR || at > now + 60 || !total?.length
      || data.total.error || !data.problems?.length || !data.problems.every(({ id }) => {
        const entry = data.by_problem?.[id];
        return entry?.complete && !entry.error && entry.rows.length;
      })) return Response.json({ error: 'Invalid or incomplete snapshot' }, { status: 400 });

    const teams = new Map(total.map(row => [row.team, {}]));
    for (const { id } of data.problems) {
      for (const { team, score, rank } of data.by_problem[id].rows) {
        const scores = teams.get(team);
        if (scores && !Object.hasOwn(scores, id)) scores[id] = [score, rank];
      }
    }
    const buckets = Array.from({ length: BUCKETS }, () => Object.create(null));
    for (const [team, scores] of teams) buckets[bucket(team)][team] = scores;
    this.storage.transactionSync(() => {
      this.sql.exec('INSERT OR REPLACE INTO totals VALUES (?, ?)', at,
        JSON.stringify(total.map(({ team, score }) => [team, score])));
      for (const [index, scores] of buckets.entries()) {
        this.sql.exec('INSERT OR REPLACE INTO problems VALUES (?, ?, ?)', index, at, JSON.stringify(scores));
      }
      this.sql.exec(`INSERT INTO backup VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at,
        body = excluded.body WHERE excluded.at >= backup.at`, at, body);
      this.sql.exec('DELETE FROM totals WHERE at < ?', now - 26 * HOUR);
      this.sql.exec('DELETE FROM problems WHERE at < ?', now - 26 * HOUR);
    });
    return Response.json({ at });
  }

  history(at, teams) {
    const fiveHours = at - 5 * HOUR;
    const day = at - 24 * HOUR;
    const baseline5h = this.sql.exec('SELECT * FROM totals WHERE at BETWEEN ? AND ? ORDER BY at DESC LIMIT 1',
      fiveHours - MAX_BASELINE_GAP, fiveHours).toArray()[0];
    const baseline24h = this.sql.exec('SELECT at FROM totals WHERE at BETWEEN ? AND ? ORDER BY at DESC LIMIT 1',
      day - MAX_BASELINE_GAP, day).toArray()[0]?.at ?? null;
    const start = baseline24h ?? day;
    const times = this.sql.exec('SELECT at FROM totals WHERE at BETWEEN ? AND ? ORDER BY at', start, at).toArray();
    const groups = new Map();
    for (const team of teams) {
      const index = bucket(team);
      if (!groups.has(index)) groups.set(index, []);
      groups.get(index).push(team);
    }
    const byTeam = [];
    for (const [index, names] of groups) {
      const changes = new Map(names.map(name => [name, new Map()]));
      const firstSeen = new Map();
      const rows = this.sql.exec('SELECT at, scores FROM problems WHERE bucket = ? AND at BETWEEN ? AND ? ORDER BY at',
        index, start, at);
      for (const row of rows) {
        const sample = JSON.parse(row.scores);
        for (const [name, series] of changes) {
          if (!Object.hasOwn(sample, name)) continue;
          if (!firstSeen.has(name)) firstSeen.set(name, row.at);
          const scores = sample[name];
          for (const id of new Set([...series.keys(), ...Object.keys(scores)])) {
            if (!series.has(id)) series.set(id, firstSeen.get(name) < row.at ? [[firstSeen.get(name), null, null]] : []);
            const points = series.get(id);
            const [score, rank] = scores[id] || [null, null];
            const last = points.at(-1);
            if (!last || last[1] !== score || last[2] !== rank) points.push([row.at, score, rank]);
          }
        }
      }
      for (const [name, series] of changes) byTeam.push([name, { firstAt: firstSeen.get(name), problems: [...series] }]);
    }
    return {
      baseline5h: baseline5h ? { at: baseline5h.at, scores: JSON.parse(baseline5h.scores) } : null,
      baseline24h, firstAt: times[0]?.at ?? null, latestAt: times.at(-1)?.at ?? null,
      sampleCount: times.length, byTeam,
    };
  }
}
