import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { RankingStore } from './history.js';

test('reads the right baselines and tracks score, rank and first appearance for any current top team', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new RankingStore({ storage: {
      sql: { exec: (query, ...params) => {
        if (query.startsWith('CREATE TABLE')) return db.exec(query);
        const rows = db.prepare(query).all(...params).map(row => ({ ...row }));
        return Object.assign(rows, { toArray: () => rows });
      } },
      transactionSync: fn => fn(),
    } });
    const now = Math.floor(Date.now() / 1000);
    const earlier = now - 24 * 3600 - 300;
    const fiveHours = now - 5 * 3600 - 120;
    const recent = now - 120;
    const record = (at, score, rank, newScore) => store.record(JSON.stringify({
      generated_at: at,
      total: { rows: [{ team: 'teamA', score }, { team: 'teamB', score: newScore || 0 }] },
      problems: [{ id: 'p1' }],
      by_problem: { p1: { complete: true, rows: [
        { team: 'teamA', score, rank },
        ...(newScore ? [{ team: 'teamB', score: newScore, rank: 2 }] : []),
      ] } },
    }));
    assert.equal(record(earlier, 10, 1).status, 200);
    assert.equal(record(fiveHours, 15, 1).status, 200);
    assert.equal(record(recent, 15, 3, 18).status, 200);
    assert.equal(record(now, 15, 3, 18).status, 200);
    // A late retry cannot replace the newest complete fallback snapshot.
    assert.equal(record(recent, 15, 3, 18).status, 200);
    const backup = await store.fetch(new Request('https://store/backup'));
    assert.equal((await backup.json()).generated_at, now);
    const history = store.history(now, ['teamB', 'teamA']);
    assert.equal(history.baseline24h, earlier);
    assert.deepEqual(history.baseline5h, { at: fiveHours, scores: [['teamA', 15], ['teamB', 0]] });
    assert.equal(history.sampleCount, 4);
    const teams = new Map(history.byTeam);
    assert.deepEqual(teams.get('teamA').problems, [['p1', [[earlier, 10, 1], [fiveHours, 15, 1], [recent, 15, 3]]]]);
    assert.deepEqual(teams.get('teamB').problems, [['p1', [[earlier, null, null], [recent, 18, 2]]]]);
    assert.equal(store.history(now - 900, []).baseline5h, null);
  } finally {
    db.close();
  }
});
