'use strict';

const API = 'https://api.sleeper.app/v1';
// Undocumented Sleeper endpoint used for live game clock / kickoff info.
const SCORES_API = 'https://api.sleeper.com/scores/nfl';
const CDN = 'https://sleepercdn.com';

const CONFIG_KEY = 'matchup:config';
const PLAYERS_KEY = 'matchup:players';
const REFRESH_MS = 15000;
const PLAYER_TTL_MS = 12 * 60 * 60 * 1000;

// Roster slots that are never shown.
const HIDDEN_SLOTS = new Set(['BN', 'IR', 'TAXI']);

// Badge text for each Sleeper roster slot. Unknown slots fall back to the raw name.
const SLOT_LABELS = {
  QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', K: 'K', DEF: 'DEF',
  FLEX: 'FLEX', WRRB_FLEX: 'W/R', REC_FLEX: 'W/T', SUPER_FLEX: 'SF',
  DL: 'DL', LB: 'LB', DB: 'DB', IDP_FLEX: 'IDP',
};

const INJURY_ABBR = {
  Questionable: 'Q', Doubtful: 'D', Out: 'O', IR: 'IR', PUP: 'PUP', Sus: 'SUS', NA: 'NA', DNR: 'DNR',
};

const NFL_TEAMS = {
  ARI: 'Cardinals', ATL: 'Falcons', BAL: 'Ravens', BUF: 'Bills', CAR: 'Panthers', CHI: 'Bears',
  CIN: 'Bengals', CLE: 'Browns', DAL: 'Cowboys', DEN: 'Broncos', DET: 'Lions', GB: 'Packers',
  HOU: 'Texans', IND: 'Colts', JAX: 'Jaguars', KC: 'Chiefs', LAC: 'Chargers', LAR: 'Rams',
  LV: 'Raiders', MIA: 'Dolphins', MIN: 'Vikings', NE: 'Patriots', NO: 'Saints', NYG: 'Giants',
  NYJ: 'Jets', PHI: 'Eagles', PIT: 'Steelers', SEA: 'Seahawks', SF: '49ers', TB: 'Buccaneers',
  TEN: 'Titans', WAS: 'Commanders',
};

const GEAR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.14 12.94a7.07 7.07 0 0 0 .05-.94 7.07 7.07 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.65 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54c.05.24.25.42.5.42h3.84c.25 0 .45-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.63-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>';
const BACK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.4 4.6 8 12l7.4 7.4 1.4-1.4-6-6 6-6z"/></svg>';

const app = document.getElementById('app');
const ptr = document.getElementById('ptr');
const toastEl = document.getElementById('toast');

let config = readStore(CONFIG_KEY);
let view = null;          // 'setup' | 'matchup' | 'settings'
let lastData = null;      // last successfully loaded matchup data
let lastUpdated = 0;
let refreshTimer = null;
let agoTimer = null;
let inFlight = null;

/* ---------- storage ---------- */

function readStore(key) {
  try { return JSON.parse(localStorage.getItem(key)) || null; } catch { return null; }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}
function removeStore(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

/* ---------- fetching ---------- */

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Small in-memory TTL cache for data that changes rarely (league, rosters, NFL state).
const memo = new Map();
async function cached(key, ttlMs, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  memo.set(key, { at: Date.now(), value });
  return value;
}

async function ensurePlayers(ids) {
  const store = readStore(PLAYERS_KEY) || {};
  const now = Date.now();
  const missing = ids.filter((id) => !store[id] || now - store[id].ts > PLAYER_TTL_MS);
  await Promise.all(missing.map(async (id) => {
    if (!/^\d+$/.test(id)) {
      // Team defenses use the team abbreviation as their player id.
      store[id] = { n: NFL_TEAMS[id] || id, p: 'DEF', t: id, ts: now };
      return;
    }
    try {
      const p = await getJSON(`${API}/players/nfl/${id}`);
      store[id] = {
        n: p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim(),
        f: p.first_name || '',
        l: p.last_name || '',
        p: p.position || (p.fantasy_positions || [])[0] || '',
        t: p.team || '',
        i: p.injury_status || '',
        ts: now,
      };
    } catch {
      // Keep any stale copy; otherwise the row shows a placeholder name.
    }
  }));
  if (missing.length) writeStore(PLAYERS_KEY, store);
  return store;
}

/* ---------- helpers ---------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function cssUrl(url) {
  return url ? `background-image:url('${encodeURI(url).replace(/['()]/g, '')}')` : '';
}
function initials(name) {
  return esc((name || '?').trim().charAt(0).toUpperCase());
}
function fmtPts(n) {
  return (Number(n) || 0).toFixed(2);
}
function shortName(p) {
  if (!p) return 'Unknown';
  if (p.p === 'DEF') return p.n;
  if (p.f && p.l) return `${p.f.charAt(0)}. ${p.l}`;
  return p.n || 'Unknown';
}
function userAvatar(user) {
  if (!user) return null;
  if (user.metadata && user.metadata.avatar) return user.metadata.avatar;
  return user.avatar ? `${CDN}/avatars/thumbs/${user.avatar}` : null;
}
function record(roster) {
  const s = (roster && roster.settings) || {};
  const w = s.wins || 0, l = s.losses || 0, t = s.ties || 0;
  return t ? `${w}-${l}-${t}` : `${w}-${l}`;
}
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

/* ---------- games ---------- */

function buildGames(scores) {
  if (!Array.isArray(scores)) return null;
  const games = {};
  for (const g of scores) {
    const m = g.metadata || {};
    const game = {
      status: g.status,
      start: g.start_time,
      quarter: m.quarter,
      clock: m.time_remaining,
      home: m.home_team,
      away: m.away_team,
      homeScore: m.home_score,
      awayScore: m.away_score,
    };
    if (game.home) games[game.home] = game;
    if (game.away) games[game.away] = game;
  }
  return games;
}

function quarterLabel(q) {
  const s = String(q ?? '').trim();
  if (/^h/i.test(s)) return 'Half';
  const n = parseInt(s, 10);
  if (!n) return s;
  return n > 4 ? 'OT' : `Q${n}`;
}

// Returns { text, live } describing a player's NFL game, or null if unknown.
function gameInfo(team, games) {
  if (!games) return null;
  if (!team) return { text: 'Free agent', live: false };
  const g = games[team];
  if (!g) return { text: 'BYE', live: false };
  const opp = team === g.home ? `vs ${g.away}` : `@${g.home}`;
  if (g.status === 'in_game') {
    const clock = g.clock && g.clock !== '00:00' ? ` ${g.clock}` : '';
    return { text: `${quarterLabel(g.quarter)}${clock} ${opp}`, live: true };
  }
  if (g.status === 'complete') {
    const mine = team === g.home ? g.homeScore : g.awayScore;
    const theirs = team === g.home ? g.awayScore : g.homeScore;
    return { text: `Final ${mine ?? 0}-${theirs ?? 0}`, live: false };
  }
  if (g.start) {
    const d = new Date(g.start);
    const day = d.toDateString() === new Date().toDateString() ? '' : d.toLocaleDateString([], { weekday: 'short' });
    // "6:20 PM" -> "6:20p" to fit the narrow columns
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      .replace(/\s?([AP])M$/i, (_, m) => m.toLowerCase());
    return { text: `${day ? `${day} ` : ''}${time} ${opp}`, live: false };
  }
  return { text: opp, live: false };
}

/* ---------- data loading ---------- */

async function loadMatchup() {
  const { leagueId, userId } = config;
  const state = await cached('state', 5 * 60e3, () => getJSON(`${API}/state/nfl`));
  const league = await cached(`league:${leagueId}`, 60 * 60e3, () => getJSON(`${API}/league/${leagueId}`));
  const [users, rosters] = await Promise.all([
    cached(`users:${leagueId}`, 10 * 60e3, () => getJSON(`${API}/league/${leagueId}/users`)),
    cached(`rosters:${leagueId}`, 5 * 60e3, () => getJSON(`${API}/league/${leagueId}/rosters`)),
  ]);

  const week = state.display_week || state.week;
  const base = { league, week };
  if (!week || state.season_type === 'off' || state.season_type === 'pre') {
    return { ...base, empty: 'The NFL regular season hasn’t started yet.' };
  }

  const myRoster = rosters.find((r) => r.owner_id === userId || (r.co_owners || []).includes(userId));
  if (!myRoster) return { ...base, empty: 'You don’t have a team in this league.' };

  const [matchups, scores] = await Promise.all([
    getJSON(`${API}/league/${leagueId}/matchups/${week}`),
    getJSON(`${SCORES_API}/${state.season_type}/${state.season}/${week}`).catch(() => null),
  ]);

  const me = (matchups || []).find((m) => m.roster_id === myRoster.roster_id);
  if (!me) return { ...base, empty: `No matchup for week ${week}.` };
  const opp = me.matchup_id != null
    ? matchups.find((m) => m.matchup_id === me.matchup_id && m.roster_id !== me.roster_id)
    : null;
  const oppRoster = opp ? rosters.find((r) => r.roster_id === opp.roster_id) : null;

  const slots = (league.roster_positions || []).filter((p) => !HIDDEN_SLOTS.has(p));
  const ids = [...(me.starters || []), ...((opp && opp.starters) || [])].filter((id) => id && id !== '0');
  const players = await ensurePlayers([...new Set(ids)]);

  const userById = Object.fromEntries(users.map((u) => [u.user_id, u]));
  const team = (roster, m) => {
    const user = userById[roster.owner_id];
    return {
      name: (user && user.metadata && user.metadata.team_name) || (user && user.display_name) || `Team ${roster.roster_id}`,
      owner: user ? user.display_name : '',
      avatar: userAvatar(user),
      record: record(roster),
      points: m.custom_points ?? m.points ?? 0,
      starters: m.starters || [],
      starterPoints: m.starters_points || [],
      playerPoints: m.players_points || {},
    };
  };

  return {
    ...base,
    slots,
    players,
    games: buildGames(scores),
    me: team(myRoster, me),
    opp: opp && oppRoster ? team(oppRoster, opp) : null,
  };
}

/* ---------- rendering: matchup ---------- */

function topbar(title, sub, button) {
  return `
    <header class="topbar">
      <div class="topbar-title">
        <h1>${esc(title)}</h1>
        ${sub ? `<div class="league">${esc(sub)}</div>` : ''}
      </div>
      ${button || ''}
    </header>`;
}

function teamBlock(t, side, leading) {
  if (!t) {
    return `
      <div class="team ${side}">
        <div class="avatar">–</div>
        <div class="team-name">No opponent</div>
        <div class="team-sub">&nbsp;</div>
        <div class="team-score">&nbsp;</div>
      </div>`;
  }
  return `
    <div class="team ${side}">
      <div class="avatar" style="${cssUrl(t.avatar)}">${t.avatar ? '' : initials(t.name)}</div>
      <div class="team-name">${esc(t.name)}</div>
      <div class="team-sub">${esc(t.record)}${t.owner ? ` · @${esc(t.owner)}` : ''}</div>
      <div class="team-score ${leading ? 'leading' : ''}">${fmtPts(t.points)}</div>
    </div>`;
}

function playerCell(t, index, side, data, isTop) {
  if (!t) return `<div class="player ${side}"></div>`;
  const id = t.starters[index];
  if (!id || id === '0') {
    return `
      <div class="player ${side} emptyslot">
        <div class="headshot empty"></div>
        <div class="pinfo"><div class="pname">Empty</div></div>
        <div class="ppts">–</div>
      </div>`;
  }
  const p = data.players[id];
  const isDef = p && p.p === 'DEF';
  const img = isDef
    ? `${CDN}/images/team_logos/nfl/${String(id).toLowerCase()}.png`
    : `${CDN}/content/nfl/players/thumb/${id}.jpg`;
  const info = gameInfo(p && p.t, data.games);
  const g = p && p.t && data.games ? data.games[p.t] : null;
  const finished = g && g.status === 'complete';
  const inj = p && p.i && !finished ? INJURY_ABBR[p.i] || p.i : '';
  const pts = t.starterPoints[index] ?? t.playerPoints[id] ?? 0;
  const notStarted = g && g.status === 'pre_game' && !pts;
  const injTag = inj ? `<span class="inj">${esc(inj)}</span>` : '';
  const name = esc(shortName(p));
  return `
    <div class="player ${side}">
      <div class="headshot ${isDef ? 'def' : ''}" style="${cssUrl(img)}"></div>
      <div class="pinfo">
        <div class="pname">${side === 'left' ? name + injTag : injTag + name}</div>
        <div class="pmeta">${esc(p ? [p.p, p.t].filter(Boolean).join(' - ') : '')}</div>
        ${info ? `<div class="pgame ${info.live ? 'live' : ''}">${esc(info.text)}</div>` : ''}
      </div>
      <div class="ppts ${isTop ? 'top' : ''}">${notStarted ? '–' : fmtPts(pts)}</div>
    </div>`;
}

function rowPoints(t, i) {
  if (!t) return -Infinity;
  const id = t.starters[i];
  if (!id || id === '0') return -Infinity;
  return Number(t.starterPoints[i] ?? t.playerPoints[id] ?? 0);
}

function statusText() {
  if (!lastUpdated) return '';
  const s = Math.round((Date.now() - lastUpdated) / 1000);
  return s < 5 ? 'Updated just now' : s < 60 ? `Updated ${s}s ago` : `Updated ${Math.floor(s / 60)}m ago`;
}

function anyLive(data) {
  if (!data.games) return false;
  const teams = [data.me, data.opp].filter(Boolean);
  return teams.some((t) => t.starters.some((id) => {
    const p = data.players[id];
    const g = p && p.t && data.games[p.t];
    return g && g.status === 'in_game';
  }));
}

function renderMatchup(data) {
  view = 'matchup';
  const settingsBtn = `<button class="icon-btn" id="settings-btn" aria-label="Settings">${GEAR_ICON}</button>`;
  const head = topbar(`Week ${data.week}`, data.league.name, settingsBtn);

  if (data.empty) {
    app.innerHTML = `${head}<div class="message"><strong>Nothing to show</strong>${esc(data.empty)}</div>`;
    bindSettings();
    return;
  }

  const { me, opp } = data;
  const meLead = !opp || me.points >= opp.points;
  const oppLead = opp && opp.points > me.points;
  const live = anyLive(data);

  const rows = data.slots.map((slot, i) => {
    const a = rowPoints(me, i), b = rowPoints(opp, i);
    return `
      <div class="row">
        ${playerCell(me, i, 'left', data, a > b && a > 0)}
        <div class="slot ${esc(slot)}">${esc(SLOT_LABELS[slot] || slot.replace(/_/g, ' '))}</div>
        ${playerCell(opp, i, 'right', data, b > a && b > 0)}
      </div>`;
  }).join('');

  app.innerHTML = `
    ${head}
    <section class="score-card">
      <div class="teams">
        ${teamBlock(me, 'left', meLead && opp)}
        <div class="vs">VS</div>
        ${teamBlock(opp, 'right', oppLead)}
      </div>
    </section>
    <div class="status-line">${live ? '<span class="live-dot"></span><span>Live</span><span>·</span>' : ''}<span id="ago">${statusText()}</span></div>
    <div class="section-label">Starters</div>
    <section class="starters">${rows}</section>`;
  bindSettings();
}

function bindSettings() {
  const btn = document.getElementById('settings-btn');
  if (btn) btn.onclick = renderSettings;
}

function renderLoading() {
  app.innerHTML = '<div class="loading"><div class="ptr-spinner"></div></div>';
}

function renderLoadError() {
  view = 'matchup';
  app.innerHTML = `
    ${topbar('Matchup', config.leagueName, `<button class="icon-btn" id="settings-btn" aria-label="Settings">${GEAR_ICON}</button>`)}
    <div class="message"><strong>Couldn’t reach Sleeper</strong>Check your connection and try again.
      <div><button class="primary" id="retry" style="max-width:200px">Retry</button></div>
    </div>`;
  bindSettings();
  document.getElementById('retry').onclick = () => { renderLoading(); refresh(); };
}

/* ---------- refresh loop ---------- */

function refresh() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const data = await loadMatchup();
      lastData = data;
      lastUpdated = Date.now();
      if (view === 'matchup' || view === null) renderMatchup(data);
    } catch (err) {
      console.error(err);
      if (view === 'matchup' || view === null) {
        if (lastData) toast('Couldn’t update. Showing last scores.');
        else renderLoadError();
      }
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function startTimers() {
  stopTimers();
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && view === 'matchup') refresh();
  }, REFRESH_MS);
  agoTimer = setInterval(() => {
    const el = document.getElementById('ago');
    if (el) el.textContent = statusText();
  }, 5000);
}
function stopTimers() {
  clearInterval(refreshTimer);
  clearInterval(agoTimer);
}

function showMatchup() {
  view = 'matchup';
  if (lastData && lastData.league && lastData.league.league_id === config.leagueId) renderMatchup(lastData);
  else renderLoading();
  refresh();
  startTimers();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && view === 'matchup') {
    refresh();
    startTimers();
  } else if (document.visibilityState === 'hidden') {
    stopTimers();
  }
});

/* ---------- pull to refresh ---------- */

(function pullToRefresh() {
  const THRESHOLD = 64;
  let startY = null;
  let dist = 0;
  let busy = false;

  const set = (d) => {
    ptr.style.transform = `translateY(${d - 44}px)`;
    ptr.style.opacity = Math.min(1, d / THRESHOLD);
    ptr.firstElementChild.style.transform = `rotate(${d * 5}deg)`;
  };
  const reset = () => {
    ptr.style.transition = 'transform .2s, opacity .2s';
    ptr.style.transform = 'translateY(-60px)';
    ptr.style.opacity = 0;
    setTimeout(() => { ptr.style.transition = ''; }, 220);
  };

  window.addEventListener('touchstart', (e) => {
    if (view !== 'matchup' || busy || window.scrollY > 0 || e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    dist = 0;
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || window.scrollY > 0) { dist = 0; set(0); return; }
    dist = Math.min(dy * 0.5, 100);
    set(dist);
    if (e.cancelable) e.preventDefault();
  }, { passive: false });

  window.addEventListener('touchend', async () => {
    if (startY == null) return;
    startY = null;
    if (dist < THRESHOLD) { reset(); return; }
    busy = true;
    ptr.style.transform = `translateY(${THRESHOLD - 44}px)`;
    ptr.firstElementChild.style.transform = '';
    ptr.classList.add('spinning');
    memo.clear();
    await refresh();
    ptr.classList.remove('spinning');
    reset();
    busy = false;
  });
})();

/* ---------- setup ---------- */

function renderUsername(prefill = '') {
  view = 'setup';
  stopTimers();
  app.innerHTML = `
    <div class="setup">
      <h2>Your matchup</h2>
      <p>Enter your Sleeper username to find your leagues. This is saved on this device.</p>
      <form id="user-form" autocomplete="off">
        <input class="field" id="username" placeholder="Sleeper username" value="${esc(prefill)}"
          autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="go" required>
        <button class="primary" id="user-go" type="submit">Continue</button>
        <div class="error" id="user-err"></div>
      </form>
    </div>`;
  const form = document.getElementById('user-form');
  const input = document.getElementById('username');
  const err = document.getElementById('user-err');
  const btn = document.getElementById('user-go');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    btn.disabled = true;
    btn.textContent = 'Looking up…';
    err.textContent = '';
    try {
      const user = await getJSON(`${API}/user/${encodeURIComponent(name)}`);
      if (!user || !user.user_id) throw new Error('not found');
      input.blur();
      await renderLeagues({ username: user.username || name, userId: user.user_id });
    } catch (ex) {
      err.textContent = ex.message === 'not found' ? 'No Sleeper user with that name.' : 'Couldn’t reach Sleeper. Try again.';
      btn.disabled = false;
      btn.textContent = 'Continue';
    }
  };
}

async function renderLeagues(user) {
  view = 'setup';
  stopTimers();
  renderLoading();
  let leagues = [];
  let season = '';
  try {
    const state = await cached('state', 5 * 60e3, () => getJSON(`${API}/state/nfl`));
    season = state.league_season || state.season;
    leagues = await getJSON(`${API}/user/${user.userId}/leagues/nfl/${season}`) || [];
  } catch {
    app.innerHTML = `<div class="setup"><div class="message"><strong>Couldn’t load leagues</strong>Check your connection.</div>
      <button class="link-btn" id="back">← Back</button></div>`;
    document.getElementById('back').onclick = () => renderUsername(user.username);
    return;
  }

  const items = leagues.map((l, i) => `
    <button class="league-item" data-i="${i}">
      <div class="avatar" style="${cssUrl(l.avatar ? `${CDN}/avatars/thumbs/${l.avatar}` : null)}">${l.avatar ? '' : initials(l.name)}</div>
      <div>
        <div class="lname">${esc(l.name)}</div>
        <div class="lsub">${esc(`${l.total_rosters} teams · ${l.season}`)}</div>
      </div>
      <span class="chev">›</span>
    </button>`).join('');

  app.innerHTML = `
    <div class="setup">
      <h2>Pick a league</h2>
      <p>Signed in as @${esc(user.username)}. Choose the league to follow.</p>
      ${leagues.length ? `<div class="league-list">${items}</div>` : `<div class="message">No ${esc(season)} NFL leagues found for this user.</div>`}
      <button class="link-btn" id="back">← Use a different username</button>
    </div>`;
  document.getElementById('back').onclick = () => renderUsername(user.username);
  app.querySelectorAll('.league-item').forEach((el) => {
    el.onclick = () => {
      const l = leagues[Number(el.dataset.i)];
      config = { username: user.username, userId: user.userId, leagueId: l.league_id, leagueName: l.name };
      writeStore(CONFIG_KEY, config);
      lastData = null;
      memo.clear();
      showMatchup();
    };
  });
}

function renderSettings() {
  view = 'settings';
  stopTimers();
  app.innerHTML = `
    <header class="topbar">
      <button class="icon-btn" id="back-btn" aria-label="Back">${BACK_ICON}</button>
      <div class="topbar-title" style="flex:1"><h1>Settings</h1></div>
    </header>
    <div class="setup" style="padding-top:12px">
      <p>Signed in as <strong style="color:var(--text)">@${esc(config.username)}</strong><br>
         League: <strong style="color:var(--text)">${esc(config.leagueName)}</strong></p>
      <button class="primary" id="change-league">Change league</button>
      <button class="link-btn" id="change-user">Use a different username</button>
    </div>`;
  document.getElementById('back-btn').onclick = showMatchup;
  document.getElementById('change-league').onclick = () => renderLeagues(config);
  document.getElementById('change-user').onclick = () => {
    removeStore(CONFIG_KEY);
    const name = config.username;
    config = null;
    lastData = null;
    renderUsername(name);
  };
}

/* ---------- boot ---------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

if (config && config.leagueId && config.userId) showMatchup();
else renderUsername();
