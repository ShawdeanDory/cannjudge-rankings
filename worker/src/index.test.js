import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';
import { createSession } from './auth.js';
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

const env = { DASHBOARD_PASSWORD: 'test-password', SESSION_SECRET: 'test-session-signing-key-minimum-length' };

test('password login issues a signed session and rejects invalid credentials or throttled attempts', async () => {
  let allowed = true;
  const configured = { ...env, RANKING_STORE: { getByName: () => ({
    fetch: async () => new Response(null, { status: allowed ? 204 : 429 }),
  }) } };
  const login = password => worker.fetch(new Request('https://worker.example/login', {
    method: 'POST', body: JSON.stringify({ password }),
  }), configured, {});
  assert.equal((await login('incorrect')).status, 401);
  const response = await login(env.DASHBOARD_PASSWORD);
  assert.equal(response.status, 200);
  assert.match((await response.json()).token, /^\d+\.[a-f0-9-]+\.[a-f0-9]{64}$/);
  allowed = false;
  assert.equal((await login(env.DASHBOARD_PASSWORD)).status, 429);
});

test('backup, history and uploads reject unauthenticated or mismatched credentials', async () => {
  const origin = 'https://worker.example';
  const send = (path, method, token) => worker.fetch(new Request(origin + path, {
    method, headers: { Authorization: `Bearer ${token}` },
  }), env, {});
  assert.equal((await send('/backup', 'GET', 'bad')).status, 401);
  assert.equal((await send('/history', 'POST', 'bad')).status, 401);
  assert.equal((await send('/record', 'POST', await createSession(env))).status, 401);
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
    const token = await createSession(env);
    const request = new Request(url, { headers: { Authorization: `Bearer ${token}` } });
    const context = { waitUntil: promise => pending.push(promise) };
    const first = await worker.fetch(request, env, context);
    assert.equal(await first.text(), raw);
    await Promise.all(pending);
    const cached = await worker.fetch(request, env, context);
    assert.equal(await cached.text(), raw);
    assert.equal(cached.headers.get('Cache-Control'), 'no-store');
    assert.equal((await worker.fetch(new Request(url), env, context)).status, 401);
    assert.equal((await worker.fetch(new Request(url, { headers: { Authorization: `Bearer ${token.slice(0, -1)}` } }), env, context)).status, 401);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});
