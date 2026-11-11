import { buildSnapshot } from './snapshot-client.js?v=4';
import { createArchive, encodeArchive, isPass, mergeArchive, observeSnapshot, problemPeaks, replayScores } from './score-replay.js?v=2';
import { ACTIVITY_LIMIT, emptyHistory, fiveHourBaseline, recordRanking } from './ranking-history.js?v=1';
/* CANNJudge 实时排名监视器 —— 纯前端渲染逻辑 */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const WORKER_URL = (window.CANNJUDGE_WORKER_URL || '').replace(/\/$/, '');
  const DEFAULT_TEAM = 'd0uB4o';
  const STORE_PAUSED = 'cannjudge.monitor.paused';
  const STORE_THEME = 'cannjudge.monitor.theme';
  const PAGE_CODE = 'LGY';
  const STORE_ACCESS = 'cannjudge.monitor.page-unlocked';
  const STORE_PEAKS = 'cannjudge.monitor.score-peaks.v1';
  const POLL_MS = 3000;
  const STATIC_POLL_MS = 60000;
  const scoreArchive = createArchive();
  let archiveReady;
  let sharedArchiveAt = 0;
  let recentHistory = emptyHistory();

  const state = {
    mode: 'unknown',
    source: 'static',
    data: null,
    version: null,
    team: DEFAULT_TEAM,
    search: '',
    history: null,
    historyKey: '',
    historyError: false,
    paused: false,
    connected: false,
    inflight: false,
    totalKey: '',
    cardKeys: new Map(),
    cardTeam: null,
    cards: new Map(),
    problemPeaks: new Map(),
    problemsSignature: '',
    teamSignature: '',
    lastRank: null,
    lastRankTeam: null,
    deltaTimer: null,
    lastGenerated: 0,
    toastTimer: null,
  };

  /* ---------- 工具 ---------- */
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function fmtScore(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(2) : '–';
  }

  function scoreDelta(current, previous) {
    const cents = Math.round(current * 100) - Math.round(previous * 100);
    return deltaMarkup(cents, (cents > 0 ? '+' : '') + fmtScore(cents / 100));
  }

  function deltaMarkup(delta, label) {
    const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : '';
    const arrow = delta > 0 ? '▲ ' : delta < 0 ? '<span class="decline-arrow">▼</span> ' : '';
    return `<span class="score-delta ${direction}">${arrow}${label}</span>`;
  }

  function rankDelta(change) {
    return change == null ? '–' : deltaMarkup(change, `${Math.abs(change)} 位`);
  }

  function problemRankDelta(event) {
    if (!event) return '–';
    if (event.previousRank == null && event.rank != null) return deltaMarkup(1, '上榜');
    if (event.previousRank != null && event.rank == null) return deltaMarkup(-1, '掉榜');
    return event.rank == null ? '–' : rankDelta(event.previousRank - event.rank);
  }

  function difficultyBadge(problem) {
    const level = Number(problem.difficulty);
    const label = { 1: '简单', 2: '中等', 3: '困难' }[level] || '难度未知';
    return `<span class="difficulty level-${level}">${label}</span>`;
  }

  function fmtClock(epochSeconds) {
    if (!epochSeconds) return '–';
    const d = new Date(Number(epochSeconds) * 1000);
    if (Number.isNaN(d.getTime())) return '–';
    return d.toLocaleTimeString('zh-CN', { hour12: false });
  }

  function fmtDayTime(iso) {
    if (!iso) return '–';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '–';
    return d.toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }

  function fmtAgo(epochSeconds) {
    if (!epochSeconds) return '–';
    const diff = Math.max(0, Math.round(Date.now() / 1000 - Number(epochSeconds)));
    if (diff < 4) return '刚刚';
    if (diff < 60) return `${diff} 秒前`;
    if (diff < 3600) return `${Math.round(diff / 60)} 分钟前`;
    return `${Math.round(diff / 3600)} 小时前`;
  }

  function rankClass(rank) {
    return rank === 1 ? 'r1' : rank === 2 ? 'r2' : rank === 3 ? 'r3' : '';
  }

  function myTeam() {
    return state.team || '';
  }

  function totalRows() {
    return (state.data && state.data.total && state.data.total.rows) || [];
  }

  function myTotalRow() {
    const team = myTeam();
    if (!team) return null;
    return totalRows().find((row) => row.team === team) || null;
  }

  function problemEntry(pid) {
    return (state.data && state.data.by_problem && state.data.by_problem[pid]) || null;
  }

  function myProblemRow(pid) {
    const entry = problemEntry(pid);
    const team = myTeam();
    if (!entry || !team) return null;
    return entry.rows.find((row) => row.team === team) || null;
  }

  function toast(message, ms = 2600) {
    const node = $('#toast');
    if (!node) return;
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => node.classList.remove('show'), ms);
  }

  function syncTopbarHeight() {
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    document.documentElement.style.setProperty('--topbar-h', `${bar.offsetHeight}px`);
  }

  /* ---------- 顶栏 / 状态 ---------- */
  function setLive(mode, text) {
    const badge = $('#liveBadge');
    if (!badge) return;
    badge.className = 'live' + (mode ? ` ${mode}` : '');
    $('#liveText').textContent = text;
  }

  function repoWorkflowUrl() {
    const host = location.hostname;
    if (!host.endsWith('.github.io')) return '';
    const owner = host.slice(0, -'.github.io'.length);
    const segments = location.pathname.split('/').filter(Boolean);
    const repo = segments.length ? segments[0] : `${owner}.github.io`;
    return `https://github.com/${owner}/${repo}/actions/workflows/rankings-pages.yml`;
  }

  function renderUpdateLinks(ageSeconds) {
    const url = repoWorkflowUrl();
    const liveLink = $('#liveUpdateLink');
    const footerLink = $('#actionsLink');
    const banner = $('#staleBanner');
    if (state.mode !== 'static' || state.source === 'worker' || !url) {
      if (liveLink) liveLink.hidden = true;
      if (footerLink) footerLink.hidden = true;
      if (banner) banner.hidden = true;
      return;
    }
    const stale = ageSeconds > 900;
    if (liveLink) {
      liveLink.href = url;
      liveLink.hidden = !stale;
    }
    if (footerLink) {
      footerLink.href = url;
      footerLink.hidden = false;
      footerLink.textContent = stale
        ? `快照已 ${Math.round(ageSeconds / 60)} 分钟未更新 · 手动运行 Actions`
        : '手动更新数据';
      footerLink.classList.toggle('stale-link', stale);
    }
    if (banner) {
      const showBanner = ageSeconds > 600;
      banner.hidden = !showBanner;
      if (showBanner) {
        const age = $('#staleAge');
        const action = $('#staleAction');
        if (age) age.textContent = String(Math.max(1, Math.round(ageSeconds / 60)));
        if (action) action.href = url;
      }
    }
  }

  function updateLiveStatus() {
    const badge = $('#modeBadge');
    const age = state.data && state.lastGenerated
      ? Math.max(0, Math.round(Date.now() / 1000 - state.lastGenerated))
      : 0;
    if (badge) {
      if (state.mode === 'static') {
        badge.className = 'mode-badge static' + (age > 900 ? ' stale' : '');
        badge.textContent = state.source === 'worker' ? 'Cloudflare自动更新' : '备用快照';
      } else if (state.mode === 'local') {
        badge.className = 'mode-badge local';
        badge.textContent = '本地实时';
      }
    }
    renderUpdateLinks(age);
    if (!state.connected) {
      if (state.mode === 'static' && !state.data) {
        setLive('offline', '榜单暂不可用，正在重试…');
      } else {
        setLive('offline', '连接中断，重试中…');
      }
      return;
    }
    if (state.paused) {
      setLive('paused', '已暂停自动刷新');
      return;
    }
    const data = state.data;
    if (!data || !data.ready) {
      setLive('', '正在获取榜单…');
      return;
    }
    if (state.mode === 'static') {
      setLive('', `${state.source === 'worker' ? '更新于' : '快照于'} ${fmtClock(state.lastGenerated)} · ${fmtAgo(state.lastGenerated)}`);
    } else {
      setLive('', `实时更新 · ${fmtAgo(state.lastGenerated)}`);
    }
  }

  /* ---------- 队伍选择 ---------- */
  function matchingTeams() {
    const query = $('#teamSearch').value.trim().toLowerCase();
    return totalRows().filter(row => row.team.toLowerCase().includes(query));
  }

  function renderTeamOptions() {
    const select = $('#teamSelect');
    const rows = matchingTeams();
    const options = rows.map(row => `<option value="${esc(row.team)}">#${row.rank} ${esc(row.team)}</option>`);
    const hasSelected = rows.some(row => row.team === myTeam());
    const placeholder = rows.length ? '选择匹配队伍' : '无匹配队伍';
    if (!hasSelected) options.unshift(`<option value="" disabled>${placeholder} · 当前 ${esc(myTeam())}</option>`);
    const html = options.join('');
    if (html !== state.teamSignature) select.innerHTML = state.teamSignature = html;
    select.value = hasSelected ? myTeam() : '';
  }

  /* ---------- 我的排名 ---------- */
  function renderHero() {
    const data = state.data;
    if (!data) return;
    const rows = totalRows();
    const me = myTotalRow();
    const team = myTeam();

    $('#heroRank').textContent = me ? me.rank : '–';
    $('#heroTotal').textContent = rows.length ? `/ ${rows.length}` : '/ –';

    const meta = $('#heroMeta');
    if (!data.ready && !rows.length) {
      meta.textContent = '正在获取榜单数据…';
    } else if (!team) {
      meta.textContent = '请先选择队伍';
    } else if (!me) {
      meta.innerHTML = `未在总榜找到队伍 <b>${esc(team)}</b>`;
    } else {
      meta.innerHTML = [
        `队伍 <b>${esc(me.team)}</b>`,
        `总分 <b>${fmtScore(me.score)}</b>`,
        `通过 <b>${me.pass}/${data.problems?.length || 10}</b>`,
        `提交 <b>${me.subs}</b> 次`,
      ].join('<span class="sep">·</span>');
    }

    renderHeroDelta(me);

    const stripRank = $('#stripRank');
    if (stripRank) {
      const problemCount = (data.problems || []).length || 10;
      stripRank.textContent = me ? `#${me.rank}` : '#–';
      $('#stripTeam').textContent = team || '未选择队伍';
      $('#stripMeta').innerHTML = me
        ? `总分 <b>${fmtScore(me.score)}</b> · 通过 ${me.pass}/${problemCount} · 提交 ${me.subs} 次`
        : '未上榜';
    }

    document.title = me ? `#${me.rank} ${team} · CANNJudge 实时排名` : 'CANNJudge 实时排名监视器';

    const events = new Map(recentHistory.events).get(team) || [];
    renderActivity(events);
    renderProblemOverview(events);
  }

  function renderHeroDelta(me) {
    const node = $('#heroDelta');
    if (!node) return;
    const rank = me ? me.rank : null;
    if (state.lastRankTeam !== myTeam()) {
      state.lastRankTeam = myTeam();
      state.lastRank = rank;
      node.textContent = '';
      node.className = 'hero-delta';
      return;
    }
    if (rank && state.lastRank && rank !== state.lastRank) {
      const delta = state.lastRank - rank;
      const improved = delta > 0;
      node.className = 'hero-delta ' + (improved ? 'up' : 'down');
      node.innerHTML = improved
        ? `<span>▲</span> 排名上升 ${delta} 位 <span class="hint">（上次 #${state.lastRank}）</span>`
        : `<span class="decline-arrow">▼</span> 排名下降 ${Math.abs(delta)} 位 <span class="hint">（上次 #${state.lastRank}）</span>`;
      clearTimeout(state.deltaTimer);
      state.deltaTimer = setTimeout(() => {
        node.textContent = '';
        node.className = 'hero-delta';
      }, 9000);
    }
    state.lastRank = rank;
  }

  function renderActivity(events) {
    const titles = new Map((state.data.problems || []).map(p => [p.id, p.title]));
    const rows = events.slice(0, ACTIVITY_LIMIT).map(event => `<li>
      <div><b>${esc(titles.get(event.pid) || event.pid)}</b><time datetime="${new Date(event.time).toISOString()}">${fmtDayTime(event.time)}</time></div>
      <div>题分 ${scoreDelta(event.score, event.previousScore)} · 题名次 ${problemRankDelta(event)}</div>
      <div>区间总分 ${event.totalDelta == null ? '–' : scoreDelta(event.totalDelta, 0)} · 总名次 ${rankDelta(event.totalRankDelta)}</div>
    </li>`);
    $('#teamActivity').innerHTML = rows.join('') || '<li class="muted">暂无观测到的新提交。</li>';
  }

  function renderProblemOverview(events) {
    const newest = new Map();
    for (const event of events) if (!newest.has(event.pid)) newest.set(event.pid, event);
    $('#problemOverview').innerHTML = (state.data.problems || []).map(problem => {
      const mine = myProblemRow(problem.id);
      const last = newest.get(problem.id);
      const change = last?.sid === mine?.sid ? last : null;
      const peak = state.problemPeaks.get(problem.id);
      return `<li>
        <span class="overview-name"><button type="button" class="link-btn" data-pid="${esc(problem.id)}" title="${esc(problem.title)}">${esc(problem.title)}</button>${difficultyBadge(problem)}</span>
        <span>${isPass(mine) ? '#' + mine.rank : '–'}<small title="上次观测到的提交名次变化">${problemRankDelta(change)}</small></span>
        <span>${mine ? fmtScore(mine.score) : '–'}<small title="上次观测到的提交分数变化">${change ? scoreDelta(change.score, change.previousScore) : '–'}</small></span>
        <b title="${peak ? esc(peak.team) : ''}">${peak ? fmtScore(peak.score / 100) : '–'}</b>
      </li>`;
    }).join('');
  }

  /* ---------- 总排行榜 ---------- */
  function renderTotal(force = false) {
    const data = state.data;
    if (!data) return;
    const total = data.total || { rows: [], at: null, error: null };
    const baseline = fiveHourBaseline(recentHistory, total.at) || state.history?.baseline5h;
    const key = `${total.at}|${total.error}|${myTeam()}|${state.search}|${baseline?.at}|${state.historyError}`;
    if (!force && key === state.totalKey) return;
    state.totalKey = key;

    const rows = total.rows || [];
    const query = state.search.trim().toLowerCase();
    const filtered = query ? rows.filter((row) => row.team.toLowerCase().includes(query)) : rows;
    const body = $('#totalBody');
    const scroller = $('#totalScroll');
    const keepScroll = scroller.scrollTop;

    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="7" class="empty">${total.error ? '总榜暂时不可用，正在重试…' : '正在加载总排行榜…'}</td></tr>`;
    } else if (!filtered.length) {
      body.innerHTML = `<tr><td colspan="7" class="empty">没有匹配「${esc(state.search)}」的队伍</td></tr>`;
    } else {
      const pastScores = new Map(baseline?.scores);
      body.innerHTML = filtered.map((row) => {
        const isMe = row.team === myTeam();
        return `<tr class="${isMe ? 'me' : ''}">
          <td><span class="rank ${rankClass(row.rank)}">${row.rank}</span></td>
          <td><div class="team-cell"><span class="team-name" title="${esc(row.team)}">${esc(row.team)}</span>${isMe ? '<span class="me-tag">已选</span>' : ''}</div></td>
          <td class="num col-pass">${row.pass}</td>
          <td class="num">${fmtScore(row.score)}</td>
          <td class="num col-delta">${pastScores.has(row.team) ? scoreDelta(row.score, pastScores.get(row.team)) : '–'}</td>
          <td class="num muted col-attempt">${row.attempt}</td>
          <td class="num muted col-subs">${row.subs}</td>
        </tr>`;
      }).join('');
    }

    scroller.scrollTop = keepScroll;

    const meta = $('#totalMeta');
    if (rows.length) {
      meta.textContent = query
        ? `共 ${rows.length} 支队伍 · 匹配 ${filtered.length} 支`
        : `共 ${rows.length} 支队伍 · 按总分排序，同分按通过题数与提交次数`;
    } else {
      meta.textContent = '等待数据…';
    }

    const foot = $('#totalFoot');
    const error = total.error ? `<span class="warn">最近一次刷新失败，展示的是缓存数据</span>` : '';
    const comparison = baseline ? `5 小时对比基准 ${fmtDayTime(baseline.at * 1000)}`
      : '暂无接近 5 小时前的总榜快照';
    foot.innerHTML = `<span>更新于 ${fmtClock(total.at)} · ${fmtAgo(total.at)}</span><span>${comparison}</span>${error}`;
  }

  /* ---------- 各题区域 ---------- */
  function buildProblemCards(problems) {
    const grid = $('#problemGrid');
    grid.innerHTML = '';
    state.cards.clear();

    problems.forEach((problem) => {
      const card = document.createElement('article');
      card.className = 'panel prob-card';
      card.id = 'prob-' + problem.id;
      card.innerHTML = `
        <div class="prob-head">
          <div class="prob-title">
            <h3>${esc(problem.title)}${difficultyBadge(problem)}</h3>
          </div>
          <div class="my-chip none" data-role="mychip">
            <span class="lbl">查询队伍</span>
            <span class="val">–</span>
          </div>
        </div>
        <div class="table-scroll prob-scroll" data-role="scroll">
          <table class="rank-table">
            <thead>
              <tr>
                <th class="col-rank">排名</th>
                <th class="col-team">队伍</th>
                <th class="num">得分</th>
                <th class="col-time">提交时间</th>
              </tr>
            </thead>
            <tbody data-role="body">
              <tr><td colspan="4" class="empty">正在加载…</td></tr>
            </tbody>
          </table>
        </div>
        <div class="prob-foot">
          <span data-role="count">–</span>
          <span data-role="updated">–</span>
        </div>`;
      grid.appendChild(card);
      state.cards.set(problem.id, {
        card,
        chip: card.querySelector('[data-role="mychip"]'),
        body: card.querySelector('[data-role="body"]'),
        scroll: card.querySelector('[data-role="scroll"]'),
        count: card.querySelector('[data-role="count"]'),
        updated: card.querySelector('[data-role="updated"]'),
      });
    });
  }

  function problemRowHtml(row) {
    const isMe = row.team === myTeam();
    return `<tr class="${isMe ? 'me' : ''}">
      <td><span class="rank ${rankClass(row.rank)}">${row.rank}</span></td>
      <td><div class="team-cell"><span class="team-name" title="${esc(row.user ? row.team + ' · ' + row.user : row.team)}">${esc(row.team)}</span>${isMe ? '<span class="me-tag">已选</span>' : ''}</div></td>
      <td class="num">${fmtScore(row.score)}</td>
      <td class="muted col-time">${fmtDayTime(row.time)}</td>
    </tr>`;
  }

  function updateProblemCard(problem, force) {
    const el = state.cards.get(problem.id);
    if (!el) return;
    const entry = problemEntry(problem.id);
    const mine = myProblemRow(problem.id);

    if (mine) {
      el.chip.className = 'my-chip';
      el.chip.innerHTML = `<span class="lbl">查询队伍</span><span class="val">#${mine.rank}<small>${fmtScore(mine.score)} 分</small></span>`;
    } else {
      el.chip.className = 'my-chip none';
      el.chip.innerHTML = `<span class="lbl">查询队伍</span><span class="val">${entry ? '未提交' : '加载中'}</span>`;
    }
    const peak = state.problemPeaks.get(problem.id);

    const key = `${entry ? entry.at : null}|${entry ? entry.error : null}|${state.team}|${entry ? entry.rows.length : 0}`;
    if (!force && key === state.cardKeys.get(problem.id)) {
      return;
    }
    state.cardKeys.set(problem.id, key);

    const scroller = el.scroll;
    const keepScroll = scroller.scrollTop;

    if (!entry || (!entry.rows.length && !entry.error)) {
      el.body.innerHTML = '<tr><td colspan="4" class="empty">正在加载…</td></tr>';
      el.count.textContent = '–';
      el.updated.textContent = '–';
      return;
    }

    if (!entry.rows.length && entry.error) {
      el.body.innerHTML = '<tr><td colspan="4" class="empty">该题榜单暂时不可用，正在重试…</td></tr>';
      el.count.textContent = '–';
      el.updated.innerHTML = '<span class="warn">刷新失败</span>';
      return;
    }

    el.body.innerHTML = entry.rows.map(problemRowHtml).join('');
    scroller.scrollTop = keepScroll;

    el.count.textContent = entry.total && entry.total !== entry.rows.length
      ? `${entry.rows.length} / ${entry.total} 支队伍`
      : `${entry.rows.length} 支队伍`;
    if (peak) el.count.textContent += ` · 历史峰值 ${fmtScore(peak.score / 100)} · ${peak.team}`;
    el.updated.innerHTML = entry.error
      ? `<span class="warn">刷新失败 · 缓存于 ${fmtClock(entry.at)}</span>`
      : `更新于 ${fmtClock(entry.at)}`;
  }

  function renderProblems(force = false) {
    const data = state.data;
    if (!data) return;
    const problems = data.problems || [];
    if (!problems.length) return;

    const signature = JSON.stringify(problems);
    if (force || signature !== state.problemsSignature) {
      state.problemsSignature = signature;
      buildProblemCards(problems);
      state.cardKeys.clear();
      force = true;
    }
    problems.forEach((problem) => updateProblemCard(problem, force));
  }

  function renderAll(force = false) {
    $('#buildInfo').textContent = 'v' + (state.data.app_version || '1.0.0');
    renderHero();
    renderTotal(force);
    renderProblems(force);
    $('#problemCount').textContent = `${(state.data.problems || []).length} 道题`;
  }

  async function loadScoreArchive() {
    try { mergeArchive(scoreArchive, JSON.parse(localStorage.getItem(STORE_PEAKS))); } catch { /* optional storage */ }
    try {
      const response = await fetch('score-peaks.json', { cache: 'no-cache', signal: AbortSignal.timeout(8000) });
      if (response.ok) {
        const shared = await response.json();
        mergeArchive(scoreArchive, shared);
        sharedArchiveAt = shared.latestAt;
      }
    } catch { /* continue with observed browser samples */ }
  }

  async function loadRecentHistory() {
    try {
      const response = await fetch('ranking-history.json', { cache: 'no-cache', signal: AbortSignal.timeout(8000) });
      if (!response.ok) return;
      const history = await response.json();
      if (Array.isArray(history.samples) && Array.isArray(history.events)) recentHistory = history;
    } catch { /* collect new observations during this visit */ }
  }

  function renderReplay() {
    const table = $('#replayTable');
    const meta = $('#replayMeta');
    const replay = replayScores(state.data, scoreArchive, myTeam());
    table.hidden = !replay;
    if (!replay) {
      meta.textContent = '等待总榜、题目难度和完整题榜。';
      return;
    }
    const { ranked, selected, ambiguousLeaders } = replay;
    const flagged = ranked.filter(row => row.drops.length);
    const coverage = [scoreArchive.firstAt, Math.min(scoreArchive.latestAt, state.data.generated_at)]
      .map(at => fmtDayTime(at * 1000)).join(' 至 ');
    const result = selected ? `${selected.team} 公开 #${selected.rank} · 回放 #${selected.replayRank} · ` : '';
    meta.textContent = `${result}${flagged.length} 支队伍有已观测回退 · 样本覆盖 ${coverage}` +
      (sharedArchiveAt ? ` · 共享采样截至 ${fmtDayTime(sharedArchiveAt * 1000)}` : '') +
      (ambiguousLeaders ? ` · ${ambiguousLeaders} 道题的模拟榜首分数并列，奖励归属为估算` : '');
    const body = $('#replayBody');
    const open = new Set([...body.querySelectorAll('details[open]')].map(el => el.dataset.key));
    const details = (key, label, items) => `<details data-key="${esc(key)}"${open.has(key) ? ' open' : ''}>
      <summary>${label}</summary><ul>${items.join('')}</ul></details>`;
    const query = state.search.trim().toLowerCase();
    body.innerHTML = ranked.filter(row => row.team.toLowerCase().includes(query)).map(row => {
      const drops = row.drops.length ? details('drop:' + row.team, `${row.drops.length} 题`, row.drops.map(drop =>
        `<li><b>${esc(drop.problem.title)}</b> ${fmtScore(drop.earlier.score / 100)} → ${fmtScore(drop.base / 100)}
          <small>旧提交 ${fmtDayTime(drop.earlier.submittedAt)} · 新提交 ${fmtDayTime(drop.latest.time)} · 基础分差折合 ${fmtScore((drop.earlier.score - drop.base) * drop.weight / 100)} 分</small></li>`)) : '–';
      const first = row.thresholds[0];
      const thresholds = first ? details('threshold:' + row.team, `${esc(first.problem.title)} ${fmtScore(first.score / 100)}`,
        row.thresholds.map(item => `<li>${esc(item.problem.title)} ≥ ${fmtScore(item.score / 100)} 基础分</li>`)) : '–';
      return `<tr class="${row === selected ? 'me' : ''}">
        <td>#${row.replayRank}</td><td><span class="team-name" title="${esc(row.team)}">${esc(row.team)}</span></td><td class="num">${fmtScore(row.score)}</td>
        <td class="num">${fmtScore(row.replay / 100)}<small>${scoreDelta(row.replay / 100, row.score)}<br>${rankDelta(row.rank - row.replayRank)}</small></td><td>${drops}</td><td>${thresholds}</td></tr>`;
    }).join('') || '<tr><td colspan="6" class="empty">没有匹配的队伍</td></tr>';
  }

  function renderHistory() {
    const history = state.history;
    const table = $('#historyTable');
    const meta = $('#historyMeta');
    table.hidden = !history?.sampleCount;
    if (table.hidden) {
      meta.textContent = state.mode === 'local' ? '在线版会定时积累历史快照。'
        : state.historyError ? '暂时无法读取历史，稍后会重试。'
        : history ? '等待首次定时采样。' : '正在读取历史快照…';
      return;
    }
    const time = at => fmtDayTime(at * 1000);
    const from = history.firstAt;
    meta.textContent = `${history.baseline24h ? '24 小时基准' : '暂无 24 小时基准 · 已采样'} ${time(from)} 至 ${time(history.latestAt)} · ${history.sampleCount} 次采样 · 展开查看得分与排名变动`;
    const problems = state.data.problems;
    const top = totalRows().slice(0, 10);
    const byTeam = new Map(history.byTeam);
    const liveScores = problems.map(({ id }) => {
      const rows = problemEntry(id)?.rows || [];
      return new Map(rows.slice().reverse().map(({ team, score, rank }) => [team, [score, rank]]));
    });
    const body = $('#historyBody');
    const open = new Set([...body.querySelectorAll('details[open]')].map(el => el.dataset.key));
    $('#historyHead').innerHTML = `<tr><th scope="col" class="col-team">队伍</th>${problems.map(problem =>
      `<th scope="col">${esc(problem.title)} ${difficultyBadge(problem)}</th>`).join('')}</tr>`;
    body.innerHTML = top.map(({ rank, team }) => {
      const teamHistory = byTeam.get(team);
      const series = new Map(teamHistory?.problems);
      const cells = problems.map(({ id }, index) => {
        const points = (series.get(id) || []).slice();
        const [current, rank] = liveScores[index].get(team) || [null, null];
        const at = Math.floor(state.data.generated_at);
        const last = points.at(-1);
        if (at > history.latestAt && ((last?.[1] ?? null) !== current || (last?.[2] ?? null) !== rank)) {
          if (!last && teamHistory?.firstAt) points.push([teamHistory.firstAt, null, null]);
          points.push([at, current, rank]);
        }
        const changes = Math.max(0, points.length - 1);
        const label = current == null ? '–' : `#${rank} · ${fmtScore(current)}`;
        if (!changes) return `<td>${label}</td>`;
        const first = points[0][1];
        const delta = first == null || current == null || current === first ? '' : scoreDelta(current, first);
        const key = JSON.stringify([team, id]);
        const list = points.map(([at, score, rank]) => `<li><time datetime="${new Date(at * 1000).toISOString()}">${time(at)}</time> <b>${score == null ? '未上题榜' : `#${rank} · ${fmtScore(score)}`}</b></li>`);
        return `<td><details data-key="${esc(key)}"${open.has(key) ? ' open' : ''}>
          <summary>${label} ${delta}<small>${changes} 次变动</small></summary><ol>${list.join('')}</ol>
        </details></td>`;
      });
      return `<tr${team === myTeam() ? ' class="me"' : ''}><th scope="row"><span class="team-name" title="${esc(team)}">#${rank} ${esc(team)}</span></th>${cells.join('')}</tr>`;
    }).join('');
  }

  async function loadHistory() {
    if (state.mode !== 'static') {
      renderHistory();
      return;
    }
    const at = Math.floor(state.data.generated_at);
    const teams = totalRows().slice(0, 10).map(row => row.team);
    const key = JSON.stringify([Math.floor(at / 300), ...teams]);
    if (key !== state.historyKey) {
      try {
        const response = await workerFetch('/history', {
          method: 'POST', body: JSON.stringify({ at, teams }), headers: { 'Content-Type': 'application/json' },
        });
        if (!response.ok) throw new Error('History unavailable');
        state.history = await response.json();
        state.historyKey = key;
        state.historyError = false;
      } catch {
        state.historyError = true;
        state.history = null;
        state.historyKey = '';
      }
    }
    renderTotal();
    renderHistory();
  }

  /* ---------- 数据 ---------- */
  async function detectMode() {
    state.mode = 'static';
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) return;
    try {
      const res = await fetch('/api/ping', { cache: 'no-store' });
      if (res.ok) {
        const info = await res.json();
        if (info && info.app === 'cannjudge-rank-monitor') {
          state.mode = 'local';
          return;
        }
      }
    } catch (err) { /* 静态托管的正常分支 */ }
  }

  function applyModeChrome() {
    const quit = $('#quitBtn');
    if (state.mode === 'static') {
      if (quit) quit.style.display = 'none';
      $('#footerNote').innerHTML = '数据来源 <a href="https://cannjudge.cn/public/ictcompetition" target="_blank" rel="noreferrer">CANNJudge</a> · 每分钟更新 · 历史以定时快照为准';
      const label = $('#refreshBtn .btn-label');
      if (label) label.textContent = '重新加载';
    } else {
      if (quit) quit.style.display = '';
      $('#footerNote').innerHTML = '数据来源 <a href="https://cannjudge.cn/public/ictcompetition" target="_blank" rel="noreferrer">CANNJudge</a> · 本地实时监视，不提交任何内容';
    }
  }

  function applySnapshot(data) {
    const first = !state.data;
    state.data = data;
    state.version = data.version;
    state.lastGenerated = data.generated_at;
    state.connected = true;

    observeSnapshot(scoreArchive, data);
    recordRanking(recentHistory, data);
    state.problemPeaks = problemPeaks(data, scoreArchive);
    renderTeamOptions();
    renderAll(first);
    try { localStorage.setItem(STORE_PEAKS, JSON.stringify(encodeArchive(scoreArchive))); } catch { /* optional storage */ }
    renderReplay();
    updateLiveStatus();
  }

  async function workerFetch(path, options = {}) {
    if (!WORKER_URL) throw new Error('Worker URL not configured');
    return fetch(new URL(path, WORKER_URL), {
      ...options, cache: 'no-store', signal: AbortSignal.timeout(20000),
    });
  }

  async function fetchOnlineSnapshot() {
    try {
      const data = await buildSnapshot(async (path, params = {}) => {
        const response = await workerFetch(`${path}?${new URLSearchParams(params)}`);
        if (!response.ok) throw new Error('Worker HTTP ' + response.status);
        return response.json();
      });
      state.source = 'worker';
      return data;
    } catch { /* use the latest complete backup */ }
    const response = await workerFetch('/backup');
    if (!response.ok) throw new Error('Snapshot HTTP ' + response.status);
    state.source = 'static';
    return response.json();
  }

  async function poll(force = false) {
    if (state.inflight || $('#dashboard').hidden) return;
    if (state.paused && !force) return;
    state.inflight = true;
    archiveReady ??= Promise.all([loadScoreArchive(), loadRecentHistory()]);
    try {
      if (state.mode === 'static') {
        const data = await fetchOnlineSnapshot();
        if (data.version !== state.version) {
          await archiveReady;
          applySnapshot(data);
        } else {
          state.connected = true;
          state.lastGenerated = data.generated_at;
          updateLiveStatus();
        }
        await loadHistory();
      } else {
        const params = new URLSearchParams();
        if (!force && state.version != null) params.set('version', state.version);
        const query = params.toString();
        const res = await fetch('/api/snapshot' + (query ? '?' + query : ''), { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (data.unchanged) {
          state.connected = true;
          state.lastGenerated = data.generated_at;
          updateLiveStatus();
        } else {
          await archiveReady;
          applySnapshot(data);
          renderHistory();
        }
      }
    } catch {
      state.connected = false;
      updateLiveStatus();
    } finally {
      state.inflight = false;
    }
  }

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('#themeBtn').textContent = theme === 'light' ? '深色模式' : '浅色模式';
    try { localStorage.setItem(STORE_THEME, theme); } catch { /* optional preference */ }
  }

  function showDashboard() {
    $('#accessView').hidden = true;
    $('#dashboard').hidden = false;
    syncTopbarHeight();
  }

  function unlockDashboard(event) {
    event.preventDefault();
    const input = $('#accessCode');
    const valid = input.value.trim() === PAGE_CODE;
    input.value = '';
    if (!valid) {
      $('#accessMessage').textContent = '口令不正确。';
      input.focus();
      return;
    }
    try { sessionStorage.setItem(STORE_ACCESS, '1'); } catch { /* the current page can still be unlocked */ }
    showDashboard();
    poll(true);
  }

  /* ---------- 交互 ---------- */
  function setupInteractions() {
    const teamSearch = $('#teamSearch');
    function selectTeam(value) {
      if (!value) return;
      state.team = value;
      teamSearch.value = '';
      renderTeamOptions();
      renderAll();
      renderHistory();
      renderReplay();
      toast(`已切换到队伍 ${value}`);
    }
    $('#teamSelect').addEventListener('change', event => selectTeam(event.target.value));
    teamSearch.addEventListener('input', renderTeamOptions);
    teamSearch.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && teamSearch.value.trim()) {
        const rows = matchingTeams();
        if (rows.length === 1) selectTeam(rows[0].team);
        else if (rows.length > 1) $('#teamSelect').focus();
      } else if (event.key === 'Escape') {
        teamSearch.value = '';
        renderTeamOptions();
      }
    });
    $('#themeBtn').addEventListener('click', () => {
      setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
    });
    $('#accessForm').addEventListener('submit', unlockDashboard);

    const search = $('#searchInput');
    let searchTimer = null;
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = search.value;
        state.totalKey = '';
        const scroller = $('#totalScroll');
        if (scroller) scroller.scrollTop = 0;
        renderTotal(true);
        if (state.data) renderReplay();
      }, 120);
    });

    document.addEventListener('keydown', (event) => {
      if ($('#dashboard').hidden) return;
      if (event.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
        event.preventDefault();
        teamSearch.focus();
        teamSearch.select();
      } else if (event.key === 'Escape' && document.activeElement === search) {
        search.value = '';
        state.search = '';
        state.totalKey = '';
        renderTotal(true);
        if (state.data) renderReplay();
        search.blur();
      }
    });

    $('#pauseBtn').addEventListener('click', () => {
      state.paused = !state.paused;
      try { localStorage.setItem(STORE_PAUSED, state.paused ? '1' : '0'); } catch (e) { /* ignore */ }
      $('#pauseBtn').textContent = state.paused ? '恢复刷新' : '暂停刷新';
      updateLiveStatus();
      if (!state.paused) poll(true);
      toast(state.paused ? '已暂停自动刷新' : '已恢复自动刷新');
    });

    $('#refreshBtn').addEventListener('click', async () => {
      const btn = $('#refreshBtn');
      btn.classList.add('busy');
      if (state.mode === 'static') {
        try {
          await poll(true);
          toast(state.connected ? `已更新榜单 · ${fmtClock(state.lastGenerated)}` : '暂时无法更新榜单');
        } finally {
          btn.classList.remove('busy');
        }
        return;
      }
      try {
        await fetch('/api/refresh', { method: 'POST' });
      } catch (e) { /* ignore */ }
      toast('已请求刷新全部榜单，请稍候…');
      let tries = 0;
      const tick = async () => {
        tries += 1;
        await poll(true);
        if (tries < 4) {
          setTimeout(tick, 1600);
        } else {
          btn.classList.remove('busy');
        }
      };
      setTimeout(tick, 900);
    });

    $('#problemOverview').addEventListener('click', (event) => {
      const problem = event.target.closest('button[data-pid]');
      if (!problem) return;
      const target = document.getElementById('prob-' + problem.dataset.pid);
      if (!target) return;
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
      target.classList.add('target');
      setTimeout(() => target.classList.remove('target'), 1800);
    });

    $('#quitBtn').addEventListener('click', async () => {
      if (!window.confirm('确定退出本地排名监视器吗？退出后此页面将无法继续刷新。')) return;
      try { await fetch('/api/shutdown', { method: 'POST' }); } catch (e) { /* ignore */ }
      document.body.innerHTML = '<div style="display:grid;place-items:center;height:100vh;color:var(--muted)">监视器已退出，可以关闭此页面。</div>';
    });
  }

  async function init() {
    let theme = 'light';
    let unlocked = false;
    try {
      state.paused = localStorage.getItem(STORE_PAUSED) === '1';
      if (localStorage.getItem(STORE_THEME) === 'dark') theme = 'dark';
    } catch { /* optional preferences */ }
    try { unlocked = sessionStorage.getItem(STORE_ACCESS) === '1'; } catch { /* optional storage */ }
    setTheme(theme);
    if (state.paused) {
      const btn = $('#pauseBtn');
      if (btn) btn.textContent = '恢复刷新';
    }
    syncTopbarHeight();
    window.addEventListener('resize', syncTopbarHeight);
    if (window.ResizeObserver) {
      const bar = document.querySelector('.topbar');
      if (bar) new ResizeObserver(syncTopbarHeight).observe(bar);
    }
    setupInteractions();
    await detectMode();
    applyModeChrome();
    if (state.mode === 'local' || unlocked) showDashboard();
    else {
      $('#accessView').hidden = false;
      $('#accessCode').focus();
    }
    await poll(true);

    setInterval(() => poll(false), state.mode === 'static' ? STATIC_POLL_MS : POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) poll(false);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
