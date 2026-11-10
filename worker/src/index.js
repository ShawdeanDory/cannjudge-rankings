const CONTEST = '6a9e2d04bf41025d60f21804';
const ORIGIN = 'https://shawdeandory.github.io';
const UPSTREAM = 'https://cannjudge.cn';

function reply(body, status = 200) {
  return Response.json(body, { status, headers: {
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store',
  } });
}


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const fixed = [`/api/contests/${CONTEST}`, `/api/problems/contest/${CONTEST}`, `/api/submissions/contest/${CONTEST}/stats`];
    const rank = url.pathname.match(/^\/api\/problems\/([a-f0-9]{24})\/ranking$/);
    const problemIds = new Set(['6ad9857c3ff2fef7e8fd34ab','6ad9878b3ff2fef7e8fe31c1','6ad9a6b63ff2fef7e80bf2ab','6ad9a82a3ff2fef7e80ca549','6ad9a9933ff2fef7e80d562e','6ad9ab403ff2fef7e80e2a1d','6ad9acd63ff2fef7e80ed46e','6ad9af1f3ff2fef7e80fec69','6ad9b1783ff2fef7e81136f2','6ad9b33d3ff2fef7e8129852']);
    if (!fixed.includes(url.pathname) && !(rank && problemIds.has(rank[1]))) return reply({ error: 'Not found' }, 404);
    const target = new URL(url.pathname, UPSTREAM);
    if (rank) {
      const page = Number(url.searchParams.get('page') || 1);
      if (!Number.isInteger(page) || page < 1 || page > 30) return reply({ error: 'Invalid page' }, 400);
      target.search = new URLSearchParams({ contestId: CONTEST, page, size: 100 });
    }
    const origin = request.headers.get('Origin');
    if (origin && origin !== ORIGIN) return reply({ error: 'Origin not allowed' }, 403);
    if (request.method === 'OPTIONS') return reply({ ok: true });
    if (request.method !== 'GET') return reply({ error: 'Method not allowed' }, 405);
    const cacheKey = new Request(new URL(target.pathname + target.search, url.origin));
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      const response = new Response(cached.body, cached);
      response.headers.set('Cache-Control', 'no-store');
      return response;
    }
    try {
      const upstream = await fetch(target, {
        headers: { Accept: 'application/json', 'User-Agent': 'CANNJudgePublicRankings/1.2' },
        signal: AbortSignal.timeout(20000),
      });
      if (!upstream.ok) return reply({ error: `Upstream HTTP ${upstream.status}` }, 502);
      const response = new Response(upstream.body, { headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': ORIGIN,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Cache-Control': 'no-store',
      } });
      const stored = response.clone();
      stored.headers.set('Cache-Control', 'public, max-age=60');
      ctx.waitUntil(caches.default.put(cacheKey, stored));
      return response;
    } catch (error) {
      console.error('Snapshot fetch failed', error.message);
      return reply({ error: 'Upstream rankings unavailable' }, 502);
    }
  },
};
