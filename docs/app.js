/* CANNJudge 实时排名监视器 —— 纯前端渲染逻辑 */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const DEFAULT_TEAM = 'd0uB4o';
  const STORE_TEAM = 'cannjudge.monitor.team';
  const STORE_PAUSED = 'cannjudge.monitor.paused';
  const POLL_MS = 3000;
  const STATIC_POLL_MS = 60000;

  const state = {
    mode: 'unknown',
    data: null,
    version: null,
    team: '',
    search: '',
    paused: false,
    connected: false,
    inflight: false,
    totalKey: '',
    cardKeys: new Map(),
    cardTeam: null,
    cards: new Map(),
    problemsSignature: '',
    teamSignature: '',
    lastRank: null,
    lastRankTeam: null,
    deltaTimer: null,
    lastGenerated: 0,
    toastTimer: null,
    rebuildCards: false,
  };

  const STATUS_ZH = {
    Pass: '通过',
    Accepted: '通过',
    Fail: '未通过',
    'Wrong Answer': '答案错误',
    'Compile Error': '编译错误',
    'Runtime Error': '运行错误',
    'Time Limit Exceeded': '超时',
    'Memory Limit Exceeded': '超内存',
    'System Error': '系统错误',
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

  function statusClass(status) {
    const s = String(status || '').toLowerCase();
    if (s.includes('pass') || s.includes('accept')) return 'ok';
    if (s.includes('fail') || s.includes('wrong')) return 'bad';
    if (s.includes('error') || s.includes('limit') || s.includes('timeout')) return 'warn';
    return 'idle';
  }

  function statusText(status) {
    if (!status) return '暂无';
    return STATUS_ZH[status] || status;
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

  function updateLiveStatus() {
    const badge = $('#modeBadge');
    if (badge) {
      if (state.mode === 'static') {
        const age = Math.max(0, Math.round(Date.now() / 1000 - (state.lastGenerated || 0)));
        badge.className = 'mode-badge static' + (age > 900 ? ' stale' : '');
        badge.textContent = 'GitHub Pages 快照';
      } else if (state.mode === 'local') {
        badge.className = 'mode-badge local';
        badge.textContent = '本地实时';
      }
    }
    if (!state.connected) {
      if (state.mode === 'static' && !state.data) {
        setLive('offline', '等待 GitHub Actions 生成首个快照…');
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
      setLive('', `快照于 ${fmtClock(state.lastGenerated)} · ${fmtAgo(state.lastGenerated)}`);
    } else {
      setLive('', `实时更新 · ${fmtAgo(state.lastGenerated)}`);
    }
  }

  function renderContestLine() {
    const data = state.data;
    if (!data) return;
    const title = data.contest && data.contest.title ? data.contest.title : 'CANNJudge';
    const problemCount = (data.problems || []).length;
    const teams = totalRows().length;
    const parts = [title];
    if (problemCount) parts.push(`${problemCount} 道题`);
    if (teams) parts.push(`${teams} 支队伍`);
    $('#contestLine').textContent = parts.join(' · ');
    $('#buildInfo').textContent = 'v' + (data.app_version || '1.0.0');
  }

  /* ---------- 队伍选择 ---------- */
  function pickDefaultTeam(rows) {
    const names = new Set(rows.map((row) => row.team));
    let saved = '';
    try { saved = localStorage.getItem(STORE_TEAM) || ''; } catch (e) { saved = ''; }
    if (saved && names.has(saved)) return saved;
    if (names.has(DEFAULT_TEAM)) return DEFAULT_TEAM;
    return rows.length ? rows[0].team : '';
  }

  function renderTeamOptions(force = false) {
    const select = $('#teamSelect');
    const rows = totalRows();
    const names = rows.map((row) => row.team);
    const signature = names.join('\u0001');
    if (!force && signature === state.teamSignature && select.options.length) {
      return;
    }
    state.teamSignature = signature;

    if (!names.length) {
      select.innerHTML = '<option value="">暂无队伍</option>';
      return;
    }
    const myTeamName = myTeam();
    const hasMine = names.includes(myTeamName);
    const options = names.map((name, index) => {
      const rank = index + 1;
      return `<option value="${esc(name)}">#${rank} ${esc(name)}</option>`;
    });
    if (myTeamName && !hasMine) {
      options.unshift(`<option value="${esc(myTeamName)}">未上榜：${esc(myTeamName)}</option>`);
    }
    select.innerHTML = options.join('');
    if (myTeamName) select.value = myTeamName;
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
      meta.textContent = '请先在右上角选择你的队伍';
    } else if (!me) {
      meta.innerHTML = `未在总榜找到队伍 <b>${esc(team)}</b>，请在右上角重新选择`;
    } else {
      meta.innerHTML = [
        `队伍 <b>${esc(me.team)}</b>`,
        `总分 <b>${fmtScore(me.score)}</b>`,
        `通过 <b>${me.pass}/10</b>`,
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

    if (me && document.title.indexOf(`#${me.rank}`) !== 0) {
      document.title = `#${me.rank} ${team} · CANNJudge 实时排名`;
    }

    renderHeroChips();
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
        : `<span>▼</span> 排名下降 ${Math.abs(delta)} 位 <span class="hint">（上次 #${state.lastRank}）</span>`;
      clearTimeout(state.deltaTimer);
      state.deltaTimer = setTimeout(() => {
        node.textContent = '';
        node.className = 'hero-delta';
      }, 9000);
    }
    state.lastRank = rank;
  }

  function renderHeroChips() {
    const container = $('#heroChips');
    const problems = (state.data && state.data.problems) || [];
    if (!problems.length) return;

    const chips = problems.map((problem) => {
      const entry = problemEntry(problem.id);
      const mine = myProblemRow(problem.id);
      const cls = statusClass(mine && mine.status);
      const count = entry ? ` / ${entry.total || entry.rows.length}` : '';
      if (!mine) {
        const loading = !entry;
        return `<button type="button" class="hero-chip unsubmitted" data-pid="${esc(problem.id)}" title="${esc(problem.title)}">
          <span class="chip-dot"></span>
          <span class="chip-name">${esc(problem.title)}</span>
          <span class="chip-rank">${loading ? '加载中' : '未提交'}<small></small></span>
          <span class="chip-score">${loading ? '正在读取…' : '暂无成绩'}</span>
        </button>`;
      }
      return `<button type="button" class="hero-chip is-me" data-pid="${esc(problem.id)}" title="${esc(problem.title)} · ${esc(statusText(mine.status))}">
        <span class="chip-dot ${cls}"></span>
        <span class="chip-name">${esc(problem.title)}</span>
        <span class="chip-rank">#${mine.rank}<small>${count}</small></span>
        <span class="chip-score"><b>${fmtScore(mine.score)}</b> 分</span>
      </button>`;
    });
    container.innerHTML = chips.join('');
  }

  /* ---------- 总排行榜 ---------- */
  function renderTotal(force = false) {
    const data = state.data;
    if (!data) return;
    const total = data.total || { rows: [], at: null, error: null };
    const key = `${total.at}|${total.error}|${myTeam()}|${state.search}`;
    if (!force && key === state.totalKey) return;
    state.totalKey = key;

    const rows = total.rows || [];
    const query = state.search.trim().toLowerCase();
    const filtered = query ? rows.filter((row) => row.team.toLowerCase().includes(query)) : rows;
    const body = $('#totalBody');
    const scroller = $('#totalScroll');
    const keepScroll = scroller.scrollTop;

    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="6" class="empty">${total.error ? '总榜暂时不可用，正在重试…' : '正在加载总排行榜…'}</td></tr>`;
    } else if (!filtered.length) {
      body.innerHTML = `<tr><td colspan="6" class="empty">没有匹配「${esc(state.search)}」的队伍</td></tr>`;
    } else {
      body.innerHTML = filtered.map((row) => {
        const isMe = row.team === myTeam();
        return `<tr class="${isMe ? 'me' : ''}">
          <td><span class="rank ${rankClass(row.rank)}">${row.rank}</span></td>
          <td><div class="team-cell"><span class="team-name" title="${esc(row.team)}">${esc(row.team)}</span>${isMe ? '<span class="me-tag">我</span>' : ''}</div></td>
          <td class="num col-pass">${row.pass}</td>
          <td class="num">${fmtScore(row.score)}</td>
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
    foot.innerHTML = `<span>更新于 ${fmtClock(total.at)} · ${fmtAgo(total.at)}</span>${error}`;
  }

  /* ---------- 各题区域 ---------- */
  function buildProblemCards(problems) {
    const grid = $('#problemGrid');
    grid.innerHTML = '';
    state.cards.clear();

    problems.forEach((problem, index) => {
      const card = document.createElement('article');
      card.className = 'panel prob-card';
      card.id = 'prob-' + problem.id;
      card.innerHTML = `
        <div class="prob-head">
          <div class="prob-title">
            <h3><span class="prob-index">${String(index + 1).padStart(2, '0')}</span>${esc(problem.title)}</h3>
            <p class="prob-slug">${esc(problem.name)}</p>
          </div>
          <div class="my-chip none" data-role="mychip">
            <span class="lbl">我的排名</span>
            <span class="val">–</span>
          </div>
        </div>
        <div class="table-scroll prob-scroll" data-role="scroll">
          <table class="rank-table">
            <thead>
              <tr>
                <th class="col-rank">排名</th>
                <th>队伍</th>
                <th class="num">得分</th>
                <th>状态</th>
                <th class="col-time">提交时间</th>
              </tr>
            </thead>
            <tbody data-role="body">
              <tr><td colspan="5" class="empty">正在加载…</td></tr>
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
      <td><div class="team-cell"><span class="team-name" title="${esc(row.user ? row.team + ' · ' + row.user : row.team)}">${esc(row.team)}</span>${isMe ? '<span class="me-tag">我</span>' : ''}</div></td>
      <td class="num">${fmtScore(row.score)}</td>
      <td><span class="pill ${statusClass(row.status)}">${esc(statusText(row.status))}</span></td>
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
      el.chip.innerHTML = `<span class="lbl">我的排名</span><span class="val">#${mine.rank}<small>${fmtScore(mine.score)} 分</small></span>`;
    } else {
      el.chip.className = 'my-chip none';
      el.chip.innerHTML = `<span class="lbl">我的排名</span><span class="val">${entry ? '未提交' : '加载中'}</span>`;
    }

    const key = `${entry ? entry.at : null}|${entry ? entry.error : null}|${state.team}|${entry ? entry.rows.length : 0}`;
    if (!force && key === state.cardKeys.get(problem.id)) {
      return;
    }
    state.cardKeys.set(problem.id, key);

    const scroller = el.scroll;
    const keepScroll = scroller.scrollTop;

    if (!entry || (!entry.rows.length && !entry.error)) {
      el.body.innerHTML = '<tr><td colspan="5" class="empty">正在加载…</td></tr>';
      el.count.textContent = '–';
      el.updated.textContent = '–';
      return;
    }

    if (!entry.rows.length && entry.error) {
      el.body.innerHTML = '<tr><td colspan="5" class="empty">该题榜单暂时不可用，正在重试…</td></tr>';
      el.count.textContent = '–';
      el.updated.innerHTML = '<span class="warn">刷新失败</span>';
      return;
    }

    el.body.innerHTML = entry.rows.map(problemRowHtml).join('');
    scroller.scrollTop = keepScroll;

    el.count.textContent = entry.total && entry.total !== entry.rows.length
      ? `${entry.rows.length} / ${entry.total} 支队伍`
      : `${entry.rows.length} 支队伍`;
    el.updated.innerHTML = entry.error
      ? `<span class="warn">刷新失败 · 缓存于 ${fmtClock(entry.at)}</span>`
      : `更新于 ${fmtClock(entry.at)}`;
  }

  function renderProblems(force = false) {
    const data = state.data;
    if (!data) return;
    const problems = data.problems || [];
    if (!problems.length) return;

    const signature = problems.map((p) => p.id).join('|');
    if (force || signature !== state.problemsSignature) {
      state.problemsSignature = signature;
      buildProblemCards(problems);
      state.cardKeys.clear();
      force = true;
    }
    problems.forEach((problem) => updateProblemCard(problem, force));
  }

  function renderAll(force = false) {
    renderContestLine();
    renderHero();
    renderTotal(force);
    renderProblems(force);
    $('#problemCount').textContent = `${(state.data.problems || []).length} 道题`;
  }

  /* ---------- 数据 ---------- */
  async function detectMode() {
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
    state.mode = 'static';
  }

  function applyModeChrome() {
    const quit = $('#quitBtn');
    if (state.mode === 'static') {
      if (quit) quit.style.display = 'none';
      $('#footerNote').innerHTML = '数据来源 <a href="https://cannjudge.cn/public/ictcompetition" target="_blank" rel="noreferrer">CANNJudge</a> · GitHub Pages 静态快照，由 GitHub Actions 定时生成';
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

    if (first) {
      state.team = pickDefaultTeam(totalRows());
      state.lastRank = null;
      state.lastRankTeam = null;
      renderTeamOptions(true);
      const select = $('#teamSelect');
      if (state.team) select.value = state.team;
    } else {
      renderTeamOptions(false);
    }

    renderAll(first);
    updateLiveStatus();
  }

  async function poll(force = false) {
    if (state.inflight) return;
    if (state.paused && !force) return;
    state.inflight = true;
    try {
      if (state.mode === 'static') {
        // no-cache 让浏览器带 If-None-Match 校验，未变化时只收到 304，不会反复下载 500 KiB
        const res = await fetch('data/snapshot.json', { cache: force ? 'reload' : 'no-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (data.version !== state.version) {
          applySnapshot(data);
        } else {
          state.connected = true;
          state.lastGenerated = data.generated_at;
          updateLiveStatus();
        }
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
          applySnapshot(data);
        }
      }
    } catch (err) {
      state.connected = false;
      updateLiveStatus();
    } finally {
      state.inflight = false;
    }
  }

  /* ---------- 交互 ---------- */
  function setupInteractions() {
    $('#teamSelect').addEventListener('change', (event) => {
      const value = event.target.value;
      if (!value) return;
      state.team = value;
      state.lastRank = null;
      state.lastRankTeam = null;
      try { localStorage.setItem(STORE_TEAM, value); } catch (e) { /* ignore */ }
      state.cardKeys.clear();
      renderAll(true);
      toast(`已切换到队伍 ${value}`);
    });

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
      }, 120);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
        event.preventDefault();
        search.focus();
        search.select();
      } else if (event.key === 'Escape' && document.activeElement === search) {
        search.value = '';
        state.search = '';
        state.totalKey = '';
        renderTotal(true);
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
          toast(`已重新载入快照 · ${fmtClock(state.lastGenerated)}`);
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

    $('#heroChips').addEventListener('click', (event) => {
      const chip = event.target.closest('.hero-chip[data-pid]');
      if (!chip) return;
      const target = document.getElementById('prob-' + chip.dataset.pid);
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      target.classList.add('target');
      setTimeout(() => target.classList.remove('target'), 1800);
    });

    $('#quitBtn').addEventListener('click', async () => {
      if (!window.confirm('确定退出本地排名监视器吗？退出后此页面将无法继续刷新。')) return;
      try { await fetch('/api/shutdown', { method: 'POST' }); } catch (e) { /* ignore */ }
      document.body.innerHTML = '<div style="display:grid;place-items:center;height:100vh;color:#8ea0c2;font:14px \'Microsoft YaHei\',sans-serif">监视器已退出，可以关闭此页面。</div>';
    });
  }

  async function init() {
    try {
      state.paused = localStorage.getItem(STORE_PAUSED) === '1';
    } catch (e) { state.paused = false; }
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
    await poll(true);

    const schedule = () => {
      const delay = state.mode === 'static'
        ? (state.data ? STATIC_POLL_MS : 15000)
        : POLL_MS;
      setTimeout(async () => {
        await poll(false);
        updateLiveStatus();
        schedule();
      }, delay);
    };
    schedule();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
