import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { buildSnapshot } from './index.js';

const makeRow = rank => ({ rank, team: { team_name: `team-${rank}` }, score: 100 - rank, submission: { status: 'Pass' } });

function upstream(incomplete = false) {
  return async (path, params) => {
    if (path.endsWith('/stats')) return [{ team: { team_name: 'team-1' }, score: 99, passCount: 1 }];
    if (path.endsWith('/ranking')) {
      assert.equal(params.contestId, '6a9e2d04bf41025d60f21804');
      return { pages: 2, total: 2, rows: params.page === 1 ? [makeRow(1)] : incomplete ? [] : [makeRow(2)] };
    }
    if (path.includes('/api/problems/contest/')) return [{ _id: 'problem-1', name: 'demo', title: 'Demo' }];
    return { title: 'Contest' };
  };
}

test('combines all pages into the existing dashboard schema', async () => {
  const data = await buildSnapshot(upstream());
  assert.equal(data.by_problem['problem-1'].rows.length, 2);
  assert.equal(data.by_problem['problem-1'].complete, true);
  assert.equal(data.total.rows[0].rank, 1);
  assert.equal(data.by_problem['problem-1'].rows[0].status, 'Pass');
});

test('partial pagination fails instead of reporting a fresh complete snapshot', async () => {
  await assert.rejects(buildSnapshot(upstream(true)), /Incomplete/);
});

test('accepts only the snapshot route and GET or OPTIONS', async () => {
  assert.equal((await worker.fetch(new Request('https://example.com/api/users/login'), {}, {})).status, 404);
  assert.equal((await worker.fetch(new Request('https://example.com/api/snapshot', { method: 'POST' }), {}, {})).status, 405);
  assert.equal((await worker.fetch(new Request('https://example.com/api/snapshot', { headers: { Origin: 'https://elsewhere.example' } }), {}, {})).status, 403);
  const response = await worker.fetch(new Request('https://example.com/api/snapshot', { method: 'OPTIONS' }), {}, {});
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://shawdeandory.github.io');
});
