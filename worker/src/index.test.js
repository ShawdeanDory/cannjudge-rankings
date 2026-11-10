import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';
import { buildSnapshot } from '../../docs/snapshot-client.js';

const makeRow = rank => ({ rank, team: { team_name: `team-${rank}` }, score: 100 - rank, submission: { status: 'Pass' } });

function upstream(incomplete = false) {
  return async (path, params) => {
    if (path.endsWith('/stats')) return [{ team: { team_name: 'team-1' }, score: 99, passCount: 1 }];
    if (path.endsWith('/ranking')) {
      assert.equal(params.contestId, '6a9e2d04bf41025d60f21804');
      return { pages: 2, total: 2, rows: params.page === 1 ? [makeRow(1)] : incomplete ? [] : [makeRow(2)] };
    }
    if (path.includes('/api/problems/contest/')) return [{ _id: 'problem-1', name: 'demo', title: 'Demo', difficulty: 2 }];
    return { title: 'Contest' };
  };
}

test('combines all pages into the existing dashboard schema', async () => {
  const data = await buildSnapshot(upstream());
  assert.equal(data.by_problem['problem-1'].rows.length, 2);
  assert.equal(data.by_problem['problem-1'].complete, true);
  assert.equal(data.total.rows[0].rank, 1);
  assert.equal(data.problems[0].difficulty, 2);
  assert.equal(data.by_problem['problem-1'].rows[0].status, 'Pass');
});

test('reads history and backup without a session and restricts snapshot uploads to the collector', async () => {
  const env = {
    COLLECTOR_SECRET: 'collector-test-secret',
    RANKING_STORE: { getByName: () => ({
      fetch: async url => Response.json({ path: new URL(url).pathname }),
    }) },
  };
  const send = (path, options) => worker.fetch(new Request('https://worker.example' + path, options), env, {});
  assert.deepEqual(await (await send('/backup')).json(), { path: '/backup' });
  const history = await send('/history', {
    method: 'POST', body: JSON.stringify({ at: Math.floor(Date.now() / 1000), teams: ['team-1'] }),
  });
  assert.deepEqual(await history.json(), { path: '/history' });
  assert.equal((await send('/login', { method: 'POST' })).status, 404);
  const upload = token => send('/record', {
    method: 'POST', body: '{}', headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  assert.equal((await upload()).status, 401);
  assert.equal((await upload('wrong')).status, 401);
  assert.deepEqual(await (await upload(env.COLLECTOR_SECRET)).json(), { path: '/record' });
});
test('partial pagination fails instead of reporting a fresh complete snapshot', async () => {
  await assert.rejects(buildSnapshot(upstream(true)), /Incomplete/);
});

test('accepts only the snapshot route and GET or OPTIONS', async () => {
  assert.equal((await worker.fetch(new Request('https://example.com/api/users/login'), {}, {})).status, 404);
  assert.equal((await worker.fetch(new Request('https://example.com/api/contests/6a9e2d04bf41025d60f21804', { method: 'POST' }), {}, {})).status, 405);
  assert.equal((await worker.fetch(new Request('https://example.com/api/contests/6a9e2d04bf41025d60f21804', { headers: { Origin: 'https://elsewhere.example' } }), {}, {})).status, 403);
  const response = await worker.fetch(new Request('https://example.com/api/contests/6a9e2d04bf41025d60f21804', { method: 'OPTIONS' }), {}, {});
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://shawdeandory.github.io');
});


test('streams raw pages and caches each normalized pagination request', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const raw = JSON.stringify({ rows: [{ team: { team_name: 'raw' } }], pages: 1 });
  let calls = 0;
  const store = new Map();
  const pending = [];
  globalThis.caches = { default: {
    match: async key => store.get(key.url)?.clone(),
    put: async (key, value) => { store.set(key.url, value); },
  } };
  globalThis.fetch = async url => {
    calls++;
    assert.equal(url.origin, 'https://cannjudge.cn');
    assert.equal(url.searchParams.get('contestId'), '6a9e2d04bf41025d60f21804');
    assert.equal(url.searchParams.get('size'), '100');
    return new Response(raw);
  };
  try {
    const url = 'https://worker.example/api/problems/6ad9857c3ff2fef7e8fd34ab/ranking?page=2&size=999';
    const request = new Request(url);
    const context = { waitUntil: promise => pending.push(promise) };
    const first = await worker.fetch(request, {}, context);
    assert.equal(await first.text(), raw);
    await Promise.all(pending);
    const cached = await worker.fetch(request, {}, context);
    assert.equal(await cached.text(), raw);
    assert.equal(cached.headers.get('Cache-Control'), 'no-store');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});
