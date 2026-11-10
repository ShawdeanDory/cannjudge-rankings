import { createSession, secretsMatch, validSession } from './auth.js';
export { RankingStore } from './history.js';

const CONTEST = '6a9e2d04bf41025d60f21804';
const ORIGIN = 'https://shawdeandory.github.io';
const UPSTREAM = 'https://cannjudge.cn';

function respond(response, origin) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
  })) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}


export default {
  async fetch(request, env, ctx) {
    const origin = env.DASHBOARD_ORIGIN || ORIGIN;
    const reply = (body, status = 200) => respond(Response.json(body, { status }), origin);
    const url = new URL(request.url);
    const fixed = [`/api/contests/${CONTEST}`, `/api/problems/contest/${CONTEST}`, `/api/submissions/contest/${CONTEST}/stats`];
    const rank = url.pathname.match(/^\/api\/problems\/([a-f0-9]{24})\/ranking$/);
    const problemIds = new Set(['6ad9857c3ff2fef7e8fd34ab','6ad9878b3ff2fef7e8fe31c1','6ad9a6b63ff2fef7e80bf2ab','6ad9a82a3ff2fef7e80ca549','6ad9a9933ff2fef7e80d562e','6ad9ab403ff2fef7e80e2a1d','6ad9acd63ff2fef7e80ed46e','6ad9af1f3ff2fef7e80fec69','6ad9b1783ff2fef7e81136f2','6ad9b33d3ff2fef7e8129852']);
    const internal = ['/login', '/history', '/backup', '/record'].includes(url.pathname);
    if (!internal && !fixed.includes(url.pathname) && !(rank && problemIds.has(rank[1]))) return reply({ error: 'Not found' }, 404);
    if (request.headers.has('Origin') && request.headers.get('Origin') !== origin) {
      return reply({ error: 'Origin not allowed' }, 403);
    }
    if (request.method === 'OPTIONS') return reply({ ok: true });
    const method = ['/login', '/history', '/record'].includes(url.pathname) ? 'POST' : 'GET';
    if (request.method !== method) return reply({ error: 'Method not allowed' }, 405);
    const token = request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1] || '';
    const store = () => env.RANKING_STORE.getByName('ictcompetition');
    if (url.pathname === '/login') {
      if (!env.DASHBOARD_PASSWORD || !env.SESSION_SECRET || !env.RANKING_STORE) {
        return reply({ error: 'Login unavailable' }, 503);
      }
      const ip = request.headers.get('CF-Connecting-IP') || 'local';
      const limit = await store().fetch('https://store/allow-login', { method: 'POST', body: ip });
      if (limit.status === 429) return reply({ error: 'Too many attempts' }, 429);
      if (!limit.ok) return reply({ error: 'Login unavailable' }, 503);
      const body = await request.json().catch(() => null);
      if (!await secretsMatch(body?.password, env.DASHBOARD_PASSWORD)) return reply({ error: 'Invalid password' }, 401);
      const session = await createSession(env);
      return session ? reply({ token: session }) : reply({ error: 'Login unavailable' }, 503);
    }
    if (url.pathname === '/record') {
      if (!await secretsMatch(token, env.COLLECTOR_SECRET)) return reply({ error: 'Unauthorized' }, 401);
      return respond(await store().fetch('https://store/record', { method: 'POST', body: request.body }), origin);
    }
    if (!await validSession(token, env)) return reply({ error: 'Unauthorized' }, 401);
    if (url.pathname === '/history') {
      const body = await request.json().catch(() => null);
      const at = Math.floor(body?.at);
      const now = Date.now() / 1000;
      const teams = body?.teams;
      if (!Number.isSafeInteger(at) || at < now - 26 * 3600 || at > now + 60 || !Array.isArray(teams)
        || teams.length > 10 || teams.some(team => typeof team !== 'string' || !team || team.length > 1024)) {
        return reply({ error: 'Invalid history query' }, 400);
      }
      return respond(await store().fetch('https://store/history', {
        method: 'POST', body: JSON.stringify({ at, teams: [...new Set(teams)] }),
      }), origin);
    }
    if (url.pathname === '/backup') return respond(await store().fetch('https://store/backup'), origin);

    const target = new URL(url.pathname, UPSTREAM);
    if (rank) {
      const page = Number(url.searchParams.get('page') || 1);
      if (!Number.isInteger(page) || page < 1 || page > 30) return reply({ error: 'Invalid page' }, 400);
      target.search = new URLSearchParams({ contestId: CONTEST, page, size: 100 });
    }
    const cacheKey = new Request(new URL(target.pathname + target.search, url.origin));
    const cached = await caches.default.match(cacheKey);
    if (cached) return respond(cached, origin);
    try {
      const upstream = await fetch(target, {
        headers: { Accept: 'application/json', 'User-Agent': 'CANNJudgePublicRankings/1.2' },
        signal: AbortSignal.timeout(20000),
      });
      if (!upstream.ok) return reply({ error: `Upstream HTTP ${upstream.status}` }, 502);
      const stored = new Response(upstream.body, { headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
      } });
      ctx.waitUntil(caches.default.put(cacheKey, stored.clone()));
      return respond(stored, origin);
    } catch (error) {
      console.error('Snapshot fetch failed', error.message);
      return reply({ error: 'Upstream rankings unavailable' }, 502);
    }
  },
};
