import {
  COLORS, AVATARS, TEAMS, SHAPES, TIMERS, DEFAULT_OPTS, MAX_PLAYERS,
  clampSize, cleanOpts, newGame, applyMove, usePower, skipTurn, winners, teamScores, freeEdges,
} from './game.js';
import { chooseAction, LEVELS, BOT_NAMES } from './ai.js';
import { createHost, joinHost, randomCode, normalizeCode } from './net.js';
import { createBoard } from './board.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
// In ?net=local test mode every tab is its own player, so keep data per tab.
const LOCAL_NET = params.get('net') === 'local';
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const storage = () => (LOCAL_NET ? sessionStorage : localStorage);
const store = {
  get(key, fallback) {
    try {
      const v = storage().getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { storage().setItem(key, JSON.stringify(value)); } catch {}
  },
  del(key) {
    try { storage().removeItem(key); } catch {}
  },
};

let clientId = store.get('sq-client', null);
if (!clientId) {
  clientId = randomCode(12) + Date.now().toString(36);
  store.set('sq-client', clientId);
}
const profile = store.get('sq-profile', { name: '', avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)] });
const prefs = store.get('sq-prefs', {
  confirm: matchMedia('(pointer: coarse)').matches,
  sound: true,
});
const saveProfile = () => store.set('sq-profile', profile);
const savePrefs = () => store.set('sq-prefs', prefs);

const cleanName = (s, fallback = 'Player') => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 14) || fallback;
const cleanAvatar = (a) => (AVATARS.includes(a) ? a : AVATARS[0]);

const SIZES = [
  { label: 'Tiny', r: 3, c: 3 },
  { label: 'Small', r: 4, c: 4 },
  { label: 'Medium', r: 6, c: 6 },
  { label: 'Big', r: 9, c: 9 },
];

function showScreen(name) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== 'screen-' + name);
  if (name !== 'game') {
    $('menu').classList.add('hidden');
    $('over').classList.add('hidden');
  }
  syncWakeLock(name === 'game');
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// Keep phones awake during a game, so they don't drop off the connection.
let wakeLock = null;
async function syncWakeLock(want) {
  try {
    if (want && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => syncWakeLock(!$('screen-game').classList.contains('hidden')));

// Safari's page pinch-zoom would fight with the board's own zoom.
document.addEventListener('gesturestart', (e) => e.preventDefault());

// ---------------------------------------------------------------------------
// Sounds (tiny synth beeps, no files needed)
// ---------------------------------------------------------------------------
let audio = null;
addEventListener('pointerdown', () => {
  if (!audio) {
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  }
  if (audio && audio.state === 'suspended') audio.resume();
}, { capture: true });
function beep(notes) {
  if (!prefs.sound || !audio) return;
  let t = audio.currentTime;
  for (const [freq, dur] of notes) {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = 'triangle';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
    t += dur * 0.8;
  }
}
const sounds = {
  line: () => beep([[520, 0.07]]),
  box: () => beep([[660, 0.1], [880, 0.1], [1180, 0.16]]),
  turn: () => beep([[440, 0.09], [660, 0.12]]),
  win: () => beep([[523, 0.14], [659, 0.14], [784, 0.14], [1046, 0.3]]),
  power: () => beep([[300, 0.08], [600, 0.08], [900, 0.12]]),
  tick: () => beep([[1400, 0.03]]),
  pop: () => beep([[880, 0.05]]),
};

const REACTIONS = ['👍', '😂', '😮', '😱', '🎉', '❤️', '😡', '🤔'];

// ---------------------------------------------------------------------------
// The session: what we're doing right now
// ---------------------------------------------------------------------------
// mode: null | 'host' | 'guest' | 'local'
//
// Host and local games share the same "room" and game loop; a local game just
// has no network. A room:
//   { code, phase: 'lobby'|'playing'|'over', rows, cols, opts, round,
//     players: [{ cid, name, avatar, color, connected, host, bot, team, wins }],
//     game, turnEndsAt }
// Guests get a public copy of it (no client ids) after every change.
let session = { mode: null };

// Effects tracking, so sounds/toasts fire once per move.
let seen = { key: null, moveCount: -1, eventId: 0, myTurn: false, overShownFor: null };
const resetSeen = () => (seen = { key: null, moveCount: -1, eventId: 0, myTurn: false, overShownFor: null });

const runsGame = () => session.mode === 'host' || session.mode === 'local';

function freeColor(players) {
  const used = new Set(players.map((x) => x.color));
  return COLORS.find((c) => !used.has(c)) || COLORS[players.length % COLORS.length];
}
function freeAvatar(players, prefer) {
  const used = new Set(players.map((x) => x.avatar));
  if (prefer && !used.has(prefer)) return prefer;
  return AVATARS.find((a) => !used.has(a)) || AVATARS[0];
}
function makeBot(players, level = 'medium') {
  const usedNames = new Set(players.map((p) => p.name));
  const name = BOT_NAMES.find((n) => !usedNames.has(n)) || 'Robo';
  return {
    cid: 'bot-' + randomCode(6),
    name,
    avatar: freeAvatar(players, '🤖'),
    color: freeColor(players),
    connected: true,
    bot: level,
    team: 0,
    wins: 0,
  };
}
/** Make sure every player has a team when teams are on. `reset` deals everyone out again. */
function fixTeams(room, reset = false) {
  const t = room.opts.teams;
  if (!t) return;
  room.players.forEach((p, i) => {
    if (reset || !(p.team >= 0 && p.team < t)) p.team = i % t;
  });
}

// ---------------------------------------------------------------------------
// HOST
// ---------------------------------------------------------------------------
// The host's device holds the real game. Everyone else sends their moves to it
// and gets the whole room back after every change.
function startHost(saved) {
  const code = saved ? saved.code : randomCode();
  const room = saved || {
    code,
    phase: 'lobby',
    rows: 5,
    cols: 5,
    opts: { ...DEFAULT_OPTS, ...store.get('sq-last-opts', {}) },
    round: 0,
    players: [{ cid: clientId, name: cleanName(profile.name), avatar: cleanAvatar(profile.avatar), color: COLORS[0], connected: true, host: true, team: 0, wins: 0 }],
    game: null,
  };
  room.opts = cleanOpts(room.opts);
  room.players.forEach((p) => (p.connected = p.cid === clientId || !!p.bot));
  const conns = new Map(); // conn -> cid
  const net = createHost(code);
  session = { mode: 'host', room, net, conns, online: false, status: 'Opening the room…', lastReact: {} };
  resetSeen();

  net.on('ready', () => {
    session.online = true;
    session.status = 'Room is open';
    render();
  });
  net.on('status', (s) => { session.status = s; render(); });
  net.on('error', (msg) => {
    session.online = false;
    session.status = 'Not connected';
    showError(msg);
    render();
  });
  net.on('connection', (conn) => {
    conn.on('data', (m) => hostHandle(conn, m));
    conn.on('close', () => {
      const cid = conns.get(conn);
      conns.delete(conn);
      if (cid == null) return;
      if ([...conns.values()].includes(cid)) return; // still here on another connection
      const i = room.players.findIndex((p) => p.cid === cid);
      if (i < 0) return;
      if (room.phase === 'lobby') room.players.splice(i, 1);
      else room.players[i].connected = false;
      commit();
    });
  });
  commit();
}

function hostHandle(conn, m) {
  const { room, conns } = session;
  if (!m || typeof m !== 'object') return;
  if (m.t === 'hello') {
    const cid = String(m.clientId || '').slice(0, 40);
    if (!cid || cid === clientId) return conn.send({ t: 'error', msg: "You can't join your own game from the same browser." });
    conns.set(conn, cid);
    const p = room.players.find((x) => x.cid === cid);
    if (p) {
      p.connected = true;
      if (room.phase === 'lobby') {
        p.name = cleanName(m.name);
        p.avatar = cleanAvatar(m.avatar);
      }
    } else if (room.phase === 'lobby') {
      if (room.players.length >= MAX_PLAYERS) {
        conn.send({ t: 'error', msg: `This game already has ${MAX_PLAYERS} players.` });
      } else {
        room.players.push({
          cid,
          name: cleanName(m.name),
          avatar: cleanAvatar(m.avatar),
          color: freeColor(room.players),
          connected: true,
          team: room.opts.teams ? room.players.length % room.opts.teams : 0,
          wins: 0,
        });
      }
    }
    // Anyone who isn't a player (joined mid-game) can still watch.
    commit();
    return;
  }
  const cid = conns.get(conn);
  const idx = room.players.findIndex((p) => p.cid === cid);
  if (idx < 0) return;
  if (m.t === 'move') doMove(idx, m, conn);
  else if (m.t === 'power') doPower(idx, m.kind, conn);
  else if (m.t === 'react') doReact(idx, m.e);
  else if (m.t === 'profile' && room.phase === 'lobby') {
    const p = room.players[idx];
    if (m.color && COLORS.includes(m.color) && !room.players.some((x) => x.color === m.color)) p.color = m.color;
    if (m.avatar && AVATARS.includes(m.avatar)) p.avatar = m.avatar;
    commit();
  }
}

function doMove(idx, m, conn, auto = false) {
  const { room } = session;
  if (!room.game) return;
  const res = applyMove(room.game, idx, { k: m.k, r: m.r, c: m.c }, { auto });
  if (!res.ok) {
    if (conn) conn.send({ t: 'error', msg: res.error });
    else if (!auto) toast(res.error);
    commit(); // resync whoever was confused
    return;
  }
  room.game = res.state;
  if (room.game.phase === 'over') finishGame();
  commit();
}

function doPower(idx, kind, conn) {
  const { room } = session;
  if (!room.game) return;
  const res = usePower(room.game, idx, kind);
  if (!res.ok) {
    if (conn) conn.send({ t: 'error', msg: res.error });
    else toast(res.error);
    return;
  }
  room.game = res.state;
  commit();
}

function doReact(idx, e) {
  if (!REACTIONS.includes(e)) return;
  const now = Date.now();
  if (now - (session.lastReact[idx] || 0) < 600) return;
  session.lastReact[idx] = now;
  if (session.conns) for (const conn of session.conns.keys()) conn.send({ t: 'reaction', p: idx, e });
  showReaction(idx, e);
}

function finishGame() {
  const { room } = session;
  room.phase = 'over';
  room.turnEndsAt = null;
  for (const w of winners(room.game).players) if (room.players[w.index]) room.players[w.index].wins = (room.players[w.index].wins || 0) + 1;
}

function publicRoom(room) {
  return {
    code: room.code,
    phase: room.phase,
    rows: room.rows,
    cols: room.cols,
    opts: room.opts,
    round: room.round,
    players: room.players.map(({ name, avatar, color, connected, host, bot, team, wins }) => ({
      name, avatar, color, connected, host: !!host, bot: bot || null, team: team || 0, wins: wins || 0,
    })),
    game: room.game,
    timerLeft: room.turnEndsAt ? Math.max(0, room.turnEndsAt - Date.now()) : null,
  };
}

/** After every change: tell everyone, save, redraw, and run computer players / the timer. */
function commit() {
  const { room } = session;
  updateTimer();
  const pub = publicRoom(room);
  if (session.mode === 'host') {
    for (const [conn, cid] of session.conns) {
      conn.send({ t: 'room', room: pub, you: room.players.findIndex((p) => p.cid === cid) });
    }
    store.set('sq-host', room);
  }
  let you = 0;
  if (session.mode === 'local') {
    const g = room.game;
    you = g && !room.players[g.turn].bot ? g.turn : -1;
  }
  session.view = { room: pub, you, deadline: pub.timerLeft != null ? performance.now() + pub.timerLeft : null };
  render();
  scheduleAutomation();
}

// Turn timer: restart whenever a new turn starts.
function updateTimer() {
  const { room } = session;
  const g = room.game;
  if (!g || g.phase !== 'playing' || !room.opts.timer || room.players[g.turn].bot) {
    room.turnEndsAt = null;
    session.timerKey = null;
    return;
  }
  const key = `${room.round}:${g.moveCount}:${g.turn}`;
  if (session.timerKey !== key) {
    session.timerKey = key;
    room.turnEndsAt = Date.now() + room.opts.timer * 1000;
  }
}

function scheduleAutomation() {
  clearTimeout(session.autoTimer);
  const { room } = session;
  const g = room.game;
  if (!g || g.phase !== 'playing') return;
  const me = room.players[g.turn];
  if (me && me.bot) {
    session.autoTimer = setTimeout(() => botTurn(), 650 + Math.random() * 700);
  } else if (room.turnEndsAt) {
    session.autoTimer = setTimeout(() => {
      const gg = session.room && session.room.game;
      if (!gg || gg.phase !== 'playing' || Date.now() < session.room.turnEndsAt - 50) return;
      const free = freeEdges(gg);
      const e = free[Math.floor(Math.random() * free.length)];
      if (e) doMove(gg.turn, e, null, true);
    }, Math.max(0, room.turnEndsAt - Date.now()));
  }
}

function botTurn() {
  if (!runsGame()) return;
  const { room } = session;
  const g = room.game;
  if (!g || g.phase !== 'playing') return;
  const p = room.players[g.turn];
  if (!p || !p.bot) return;
  const action = chooseAction(g, p.bot);
  if (!action) return;
  if (action.power) {
    const res = usePower(g, g.turn, action.power);
    if (res.ok) {
      room.game = res.state;
      return commit();
    }
    // Couldn't use it: just draw a line instead.
    const free = freeEdges(g);
    return doMove(g.turn, free[Math.floor(Math.random() * free.length)], null);
  }
  doMove(g.turn, action.move, null);
}

function startGameFromRoom() {
  const { room } = session;
  const n = room.players.length;
  if (n < 2) return showError('You need at least 2 players. Share the code, or add a computer player!');
  room.opts = cleanOpts(room.opts);
  if (room.opts.teams) {
    fixTeams(room);
    for (let t = 0; t < room.opts.teams; t++) {
      if (!room.players.some((p) => p.team === t)) return showError(`The ${TEAMS[t].name.toLowerCase()} has nobody on it.`);
    }
  }
  store.set('sq-last-opts', room.opts);
  room.game = newGame({
    rows: room.rows,
    cols: room.cols,
    players: room.players.map(({ name, avatar, color, team, bot }) => ({ name, avatar, color, team, bot })),
    opts: room.opts,
    firstTurn: room.round,
    seed: Math.floor(Math.random() * 2 ** 31),
  });
  room.phase = 'playing';
  $('lobby-error').textContent = '';
  commit();
}

// ---------------------------------------------------------------------------
// GUEST
// ---------------------------------------------------------------------------
function startGuest(code) {
  code = normalizeCode(code);
  if (code.length < 4) return showError('Type the 4-letter room code.');
  if (!profile.name.trim()) {
    $('my-name').focus();
    return showError('Type your name first.');
  }
  session = { mode: 'guest', code, net: null, view: null, everConnected: false, status: 'Connecting…', waiting: false };
  resetSeen();
  store.set('sq-last-room', code);
  setRoomInUrl(code);
  guestConnect();
  renderConnecting();
}

function guestConnect() {
  const s = session;
  if (s.mode !== 'guest') return;
  const net = joinHost(s.code);
  s.net = net;
  let opened = false;
  const retry = () => {
    if (session !== s || s.net !== net) return;
    try { net.close(); } catch {}
    s.net = null;
    setTimeout(() => session === s && !s.net && guestConnect(), 2500);
  };
  net.on('open', () => {
    opened = true;
    s.everConnected = true;
    s.online = true;
    s.status = 'Connected';
    net.send({ t: 'hello', clientId, name: profile.name, avatar: profile.avatar });
  });
  net.on('data', (m) => {
    if (session !== s || !m) return;
    if (m.t === 'room') {
      s.view = { room: m.room, you: m.you, deadline: m.room.timerLeft != null ? performance.now() + m.room.timerLeft : null };
      s.waiting = false;
      render();
    } else if (m.t === 'reaction') {
      showReaction(m.p, m.e);
    } else if (m.t === 'error') {
      s.waiting = false;
      if (s.view) toast(m.msg);
      else {
        leave(true);
        showError(m.msg);
      }
    }
  });
  net.on('close', () => {
    if (session !== s) return;
    s.online = false;
    s.status = 'Lost connection, reconnecting…';
    render();
    retry();
  });
  net.on('error', (e) => {
    if (session !== s) return;
    if (e === 'notfound' && !s.everConnected) {
      leave(true);
      showError(`Couldn't find a game with code ${s.code}. Check the code, and make sure the game is still open on the host's screen.`);
      return;
    }
    s.online = false;
    s.status = 'Lost connection, reconnecting…';
    if (!opened) render();
    retry();
  });
}

function guestSend(msg) {
  if (session.mode !== 'guest' || !session.net || !session.online) {
    toast('Not connected right now…');
    return false;
  }
  session.net.send(msg);
  return true;
}

function renderConnecting() {
  showScreen('lobby');
  $('room-code').textContent = session.code;
  $('lobby-status').textContent = session.status;
  $('lobby-players').innerHTML = '<li><span class="nm">Connecting to the game…</span></li>';
  $('host-settings').classList.add('hidden');
  $('guest-wait').classList.add('hidden');
  $('guest-options').innerHTML = '';
  $('my-color').parentElement.classList.add('hidden');
  renderShare(session.code);
}

// ---------------------------------------------------------------------------
// LOCAL (pass and play on one device, optionally with computer players)
// ---------------------------------------------------------------------------
let localSetup = store.get('sq-local-setup-v2', null);
function startLocalSetup() {
  if (!localSetup) {
    localSetup = {
      rows: 4,
      cols: 4,
      opts: { ...DEFAULT_OPTS },
      players: [
        { name: cleanName(profile.name, 'Player 1'), avatar: cleanAvatar(profile.avatar), color: COLORS[0], team: 0 },
        { name: 'Player 2', avatar: AVATARS.find((a) => a !== profile.avatar), color: COLORS[1], team: 1 },
      ],
    };
  }
  localSetup.opts = cleanOpts(localSetup.opts);
  session = { mode: 'local-setup' };
  showScreen('local');
  renderLocalSetup();
}

function saveLocalSetup() { store.set('sq-local-setup-v2', localSetup); }

function renderLocalSetup() {
  const t = localSetup.opts.teams;
  if (t) localSetup.players.forEach((p, i) => { if (!(p.team >= 0 && p.team < t)) p.team = i % t; });
  const list = $('local-players');
  list.innerHTML = localSetup.players.map((p, i) => `
    <li style="--pc:${t ? TEAMS[p.team].color : p.color}">
      <button class="av-btn" data-i="${i}" data-act="avatar" aria-label="Change emoji">${p.avatar}</button>
      ${p.bot ? `<span class="nm">${esc(p.name)}</span>` : `<input data-i="${i}" value="${esc(p.name)}" maxlength="14" aria-label="Player ${i + 1} name">`}
      ${p.bot ? `<button class="tag-btn" data-i="${i}" data-act="level">${levelLabel(p.bot)}</button>` : ''}
      ${t ? `<button class="tag-btn team" data-i="${i}" data-act="team" style="--tc:${TEAMS[p.team].color}">${TEAMS[p.team].name.split(' ')[0]}</button>`
        : `<button class="sw" data-i="${i}" data-act="color" style="background:${p.color}" aria-label="Change color"></button>`}
      ${localSetup.players.length > 2 ? `<button class="x" data-i="${i}" data-act="remove" aria-label="Remove player">✕</button>` : ''}
    </li>`).join('');
  const full = localSetup.players.length >= MAX_PLAYERS;
  $('btn-local-add').disabled = full;
  $('btn-local-bot').disabled = full;
  renderSizePicker('local-size-presets', 'local-rows', 'local-cols', localSetup, saveLocalSetup);
  renderOptions($('local-options'), localSetup.opts, true, (key) => {
    if (key === 'teams' && localSetup.opts.teams) localSetup.players.forEach((p, i) => (p.team = i % localSetup.opts.teams));
    saveLocalSetup();
    renderLocalSetup();
  });
}

const levelLabel = (id) => {
  const l = LEVELS.find((x) => x.id === id) || LEVELS[1];
  return `🤖 ${l.label}`;
};
const nextLevel = (id) => LEVELS[(LEVELS.findIndex((x) => x.id === id) + 1) % LEVELS.length].id;

$('local-players').addEventListener('input', (e) => {
  const i = +e.target.dataset.i;
  if (e.target.tagName === 'INPUT') { localSetup.players[i].name = e.target.value; saveLocalSetup(); }
});
$('local-players').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const i = +b.dataset.i;
  const p = localSetup.players[i];
  const act = b.dataset.act;
  if (act === 'avatar') p.avatar = AVATARS[(AVATARS.indexOf(p.avatar) + 1) % AVATARS.length];
  if (act === 'color') {
    const used = new Set(localSetup.players.map((x) => x.color));
    let j = COLORS.indexOf(p.color);
    for (let n = 0; n < COLORS.length; n++) {
      j = (j + 1) % COLORS.length;
      if (!used.has(COLORS[j])) { p.color = COLORS[j]; break; }
    }
  }
  if (act === 'team') p.team = (p.team + 1) % localSetup.opts.teams;
  if (act === 'level') p.bot = nextLevel(p.bot);
  if (act === 'remove') localSetup.players.splice(i, 1);
  saveLocalSetup();
  renderLocalSetup();
});
$('btn-local-add').addEventListener('click', () => {
  const ps = localSetup.players;
  if (ps.length >= MAX_PLAYERS) return;
  ps.push({ name: `Player ${ps.length + 1}`, avatar: freeAvatar(ps), color: freeColor(ps), team: ps.length % (localSetup.opts.teams || 1) });
  saveLocalSetup();
  renderLocalSetup();
});
$('btn-local-bot').addEventListener('click', () => {
  const ps = localSetup.players;
  if (ps.length >= MAX_PLAYERS) return;
  const b = makeBot(ps);
  ps.push({ name: b.name, avatar: b.avatar, color: b.color, bot: b.bot, team: ps.length % (localSetup.opts.teams || 1) });
  saveLocalSetup();
  renderLocalSetup();
});
$('btn-local-start').addEventListener('click', () => startLocalGame());

function startLocalGame() {
  const room = {
    code: null,
    phase: 'lobby',
    rows: localSetup.rows,
    cols: localSetup.cols,
    opts: cleanOpts(localSetup.opts),
    round: 0,
    players: localSetup.players.map((p, i) => ({
      cid: 'local-' + i,
      name: cleanName(p.name, `Player ${i + 1}`),
      avatar: p.avatar,
      color: p.color,
      bot: p.bot || null,
      team: p.team || 0,
      connected: true,
      wins: 0,
    })),
    game: null,
  };
  session = { mode: 'local', room, lastReact: {} };
  resetSeen();
  startGameFromRoom();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  const v = session.view;
  if (!v) {
    if (session.mode === 'guest') renderConnecting();
    return;
  }
  if (v.room.phase === 'lobby') renderLobby();
  else renderGame();
}

function renderShare(code) {
  const link = shareLink(code);
  if ($('qr').dataset.link !== link) {
    $('qr').dataset.link = link;
    try {
      const qr = qrcode(0, 'M');
      qr.addData(link);
      qr.make();
      $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    } catch {
      $('qr').innerHTML = '';
    }
  }
}

function shareLink(code) {
  const u = new URL(location.pathname, location.origin);
  u.searchParams.set('room', code);
  if (LOCAL_NET) u.searchParams.set('net', 'local');
  return u.toString();
}

/** One-line description of the game options, for guests and the menu. */
function describeOpts(o, rows, cols) {
  const shape = SHAPES.find((s) => s.id === o.shape) || SHAPES[0];
  const bits = [`${rows} × ${cols}`, `${shape.icon} ${shape.label}`];
  if (o.blocked) bits.push(o.blocked === 1 ? '🪨 A few blocked squares' : '🪨 Lots of blocked squares');
  if (o.presets) bits.push(`✏️ ${['', 'A few', 'Some', 'Lots of'][o.presets]} lines to start`);
  if (o.bonus) bits.push('⭐ Bonus squares');
  if (o.powerups) bits.push('⚡ Power-ups');
  if (o.teams) bits.push(`👥 ${o.teams} teams`);
  if (o.timer) bits.push(`⏱️ ${o.timer}s turns`);
  return bits;
}

function renderLobby() {
  const { room, you } = session.view;
  const isHost = session.mode === 'host';
  showScreen('lobby');
  $('room-code').textContent = room.code;
  renderShare(room.code);
  const st = $('lobby-status');
  st.textContent = session.status || '';
  st.className = 'status-pill ' + (session.online ? 'ok' : 'bad');
  const t = room.opts.teams;

  $('lobby-players').innerHTML = room.players.map((p, i) => {
    const pc = t ? TEAMS[p.team].color : p.color;
    return `
    <li style="--pc:${pc}" class="${p.connected ? '' : 'off'}">
      <span class="av">${p.avatar}</span>
      <span class="nm">${esc(p.name)}</span>
      ${p.wins ? `<span class="tag">🏆 ${p.wins}</span>` : ''}
      ${i === you ? '<span class="tag">YOU</span>' : ''}
      ${p.host ? '<span class="tag">HOST</span>' : ''}
      ${p.bot ? (isHost ? `<button class="tag-btn" data-level="${i}">${levelLabel(p.bot)}</button>` : `<span class="tag">${levelLabel(p.bot)}</span>`) : ''}
      ${t ? (isHost ? `<button class="tag-btn team" data-team="${i}" style="--tc:${pc}">${TEAMS[p.team].name.split(' ')[0]}</button>`
        : `<span class="tag team" style="--tc:${pc}">${TEAMS[p.team].name.split(' ')[0]}</span>`) : ''}
      ${isHost && !p.host ? `<button class="x" data-kick="${i}" aria-label="Remove ${esc(p.name)}">✕</button>` : ''}
    </li>`;
  }).join('') +
    (room.players.length < 2 ? '<li><span class="nm" style="color:var(--muted)">Waiting for someone to join…</span></li>' : '');

  // My color and emoji
  const me = room.players[you];
  const cp = $('my-color');
  cp.parentElement.classList.toggle('hidden', !me || !!t);
  if (me && !t) {
    cp.innerHTML = COLORS.map((c) => {
      const taken = room.players.some((p, i) => p.color === c && i !== you);
      return `<button role="radio" aria-checked="${c === me.color}" ${taken ? 'disabled' : ''} data-color="${c}" style="background:${c}" aria-label="Color"></button>`;
    }).join('');
  }

  $('host-settings').classList.toggle('hidden', !isHost);
  $('guest-wait').classList.toggle('hidden', isHost);
  if (isHost) {
    renderSizePicker('size-presets', 'rows', 'cols', session.room, () => commit());
    renderOptions($('lobby-options'), session.room.opts, true, (key) => {
      fixTeams(session.room, key === 'teams');
      commit();
    });
    $('btn-add-bot').disabled = room.players.length >= MAX_PLAYERS;
    $('btn-start').disabled = room.players.length < 2;
    $('btn-start').textContent = room.players.length < 2 ? 'Waiting for players…' : `▶ Start game (${room.players.length} players)`;
    $('guest-options').innerHTML = '';
  } else {
    const host = room.players.find((p) => p.host);
    $('guest-options').innerHTML = `<h2>Game options</h2><div class="opt-summary">${describeOpts(room.opts, room.rows, room.cols).map((b) => `<span>${esc(b)}</span>`).join('')}</div>`;
    $('guest-wait').textContent = me
      ? `⏳ Waiting for ${host ? host.name : 'the host'} to start the game…`
      : 'This game is full. You can watch once it starts.';
  }
}

function renderSizePicker(presetsId, rowsId, colsId, target, onChange) {
  const el = $(presetsId);
  el.innerHTML = SIZES.map((s, i) => `<button data-i="${i}" aria-pressed="${s.r === target.rows && s.c === target.cols}">${s.label}<small>${s.r}×${s.c}</small></button>`).join('');
  el.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const s = SIZES[+b.dataset.i];
    target.rows = s.r;
    target.cols = s.c;
    onChange();
    renderSizePicker(presetsId, rowsId, colsId, target, onChange);
  };
  for (const [id, key] of [[rowsId, 'rows'], [colsId, 'cols']]) {
    const input = $(id);
    if (document.activeElement !== input) input.value = target[key];
    input.onchange = () => {
      target[key] = clampSize(input.value);
      input.value = target[key];
      onChange();
      renderSizePicker(presetsId, rowsId, colsId, target, onChange);
    };
  }
}

/** The game options picker (board shape, bonus squares, power-ups, teams, timer). */
const OPTION_ROWS = [
  { key: 'shape', label: 'Board shape', hint: 'The board is a different shape. 🎲 Surprise makes a new one every game.', choices: SHAPES.map((s) => ({ v: s.id, label: `${s.icon} ${s.label}` })) },
  { key: 'blocked', label: 'Blocked squares', hint: '🪨 Rocks sit on some squares. Nobody can claim them.', choices: [{ v: 0, label: 'Off' }, { v: 1, label: '🪨 A few' }, { v: 2, label: 'Lots' }] },
  { key: 'presets', label: 'Lines to start', hint: 'Some grey lines are already drawn when the game starts.', choices: [{ v: 0, label: 'Off' }, { v: 1, label: 'A few' }, { v: 2, label: 'Some' }, { v: 3, label: 'Lots' }] },
  { key: 'bonus', label: 'Bonus squares', hint: '×2 and ×3 squares are worth more points. ⭐ squares give you a free extra turn later.', choices: [{ v: false, label: 'Off' }, { v: true, label: '⭐ On' }] },
  { key: 'powerups', label: 'Power-ups', hint: 'Everyone gets one ⏩ Double (draw two lines) and one 🚫 Skip (skip the next player).', choices: [{ v: false, label: 'Off' }, { v: true, label: '⚡ On' }] },
  { key: 'teams', label: 'Teams', hint: 'Team mates share their points and take turns in between the other team.', choices: [{ v: 0, label: 'Off' }, { v: 2, label: '2 teams' }, { v: 3, label: '3' }, { v: 4, label: '4' }] },
  { key: 'timer', label: 'Turn timer', hint: 'Run out of time and a line is drawn for you!', choices: TIMERS.map((t) => ({ v: t, label: t ? `${t}s` : 'Off' })) },
];
function renderOptions(container, opts, editable, onChange) {
  container.innerHTML = `<h2>Game options</h2>` + OPTION_ROWS.map((row) => `
    <div class="opt-row">
      <div class="opt-label">${row.label}</div>
      <div class="seg" data-key="${row.key}">${row.choices.map((c) => `<button data-v='${JSON.stringify(c.v)}' aria-pressed="${opts[row.key] === c.v}" ${editable ? '' : 'disabled'}>${c.label}</button>`).join('')}</div>
      ${opts[row.key] && opts[row.key] !== 'square' ? `<div class="opt-hint">${row.hint}</div>` : ''}
    </div>`).join('');
  container.onclick = (e) => {
    const b = e.target.closest('.seg button');
    if (!b || !editable) return;
    const key = b.parentElement.dataset.key;
    opts[key] = JSON.parse(b.dataset.v);
    Object.assign(opts, cleanOpts(opts));
    onChange(key);
  };
}

const board = createBoard($('board'), {
  onPick: (e) => pickLine(e),
  canPlay: () => isMyTurn() && !session.waiting,
  myColor: () => {
    const p = myPlayer();
    return p ? p.color : '#888';
  },
  confirmTaps: () => prefs.confirm,
  onPending: (on) => {
    // Remind people how tap-twice works, but only the first few times.
    if (!on || (prefs.hints || 0) >= 3) return;
    prefs.hints = (prefs.hints || 0) + 1;
    savePrefs();
    toast('Tap the same line again to draw it');
  },
});

function myPlayer() {
  const v = session.view;
  if (!v || !v.room.game) return null;
  const g = v.room.game;
  return g.players[session.mode === 'local' ? g.turn : v.you] || null;
}

function isMyTurn() {
  const v = session.view;
  if (!v || !v.room.game || v.room.game.phase !== 'playing') return false;
  const g = v.room.game;
  if (session.mode === 'local') return !g.players[g.turn].bot;
  return g.turn === v.you;
}

function pickLine(e) {
  if (runsGame()) {
    const g = session.room.game;
    doMove(session.mode === 'local' ? g.turn : 0, e, null);
  } else if (session.mode === 'guest') {
    if (!guestSend({ t: 'move', k: e.k, r: e.r, c: e.c })) return;
    session.waiting = true;
    setTimeout(() => { if (session.waiting) session.waiting = false; }, 4000);
  }
}

function pressPower(kind) {
  if (!isMyTurn()) return;
  if (runsGame()) {
    const g = session.room.game;
    doPower(session.mode === 'local' ? g.turn : 0, kind, null);
  } else guestSend({ t: 'power', kind });
}

function sendReaction(e) {
  $('react-tray').classList.add('hidden');
  if (runsGame()) {
    const g = session.room.game;
    // On a shared device, the reaction comes from whoever's turn it is.
    doReact(session.mode === 'local' ? (g ? g.turn : 0) : 0, e);
  } else guestSend({ t: 'react', e });
}

function nameOf(game, i, you) {
  const p = game.players[i];
  if (!p) return '';
  return session.mode !== 'local' && i === you ? 'You' : p.name;
}

/**
 * Lines drawn since this player's own last line (what they may have missed),
 * oldest first. Falls back to just the last line.
 */
function recentForViewer(game, viewer) {
  const list = game.recent || [];
  if (!list.length) return [];
  let start = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].player === viewer) { start = i + 1; break; }
  }
  const since = list.slice(start);
  return since.length ? since : list.slice(-1);
}

function renderGame() {
  const { room, you } = session.view;
  const game = room.game;
  const wasHidden = $('screen-game').classList.contains('hidden');
  showScreen('game');
  const local = session.mode === 'local';
  const teams = teamScores(game);

  // Scoreboard
  let chips = '';
  if (teams) {
    chips += teams.map((t) => `<div class="chip team-chip" style="--pc:${t.color}"><span class="nm">${t.name.split(' ')[0]}</span><span class="sc">${t.score}</span></div>`).join('');
  }
  chips += game.players.map((p, i) => {
    const off = room.players[i] && !room.players[i].connected;
    const powers = game.opts.powerups ? (p.powers.double ? '⏩' : '') + (p.powers.skip ? '🚫' : '') : '';
    const extra = p.extraTurns ? `<span class="xt" title="Extra turns saved">⭐${p.extraTurns > 1 ? p.extraTurns : ''}</span>` : '';
    return `<div class="chip${i === game.turn && game.phase === 'playing' ? ' turn' : ''}${off ? ' off' : ''}${teams ? ' member' : ''}" style="--pc:${p.color}">
      <span class="av">${p.avatar}</span><span class="nm">${esc(p.name)}${!local && i === you ? ' (you)' : ''}</span>${extra}${powers ? `<span class="pw">${powers}</span>` : ''}${teams ? '' : `<span class="sc">${p.score}</span>`}</div>`;
  }).join('');
  $('scores').innerHTML = chips;
  const turnChip = $('scores').querySelector('.chip.turn');
  if (turnChip) turnChip.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  // Turn banner
  const cur = game.players[game.turn];
  const banner = $('turn-banner');
  const mine = isMyTurn();
  banner.style.setProperty('--pc', cur.color);
  banner.classList.toggle('mine', mine && !local);
  const curPlayer = room.players[game.turn];
  const extraNote = cur.extraTurns ? ` <small>(+${cur.extraTurns} extra turn${cur.extraTurns > 1 ? 's' : ''})</small>` : '';
  if (game.phase === 'over') {
    banner.textContent = '🏁 Game over!';
  } else if (session.mode === 'guest' && !session.online) {
    banner.textContent = '📡 ' + session.status;
  } else if (cur.bot) {
    banner.innerHTML = `<span style="color:${cur.color}">${cur.avatar} ${esc(cur.name)}</span> is thinking…`;
  } else if (local) {
    banner.innerHTML = `<span style="color:${cur.color}">${cur.avatar} ${esc(cur.name)}'s turn</span>${extraNote}`;
  } else if (mine) {
    banner.innerHTML = `${cur.avatar} Your turn, ${esc(cur.name)}!${extraNote}`;
  } else {
    const off = curPlayer && !curPlayer.connected;
    banner.innerHTML = `Waiting for <span style="color:${cur.color}">${cur.avatar} ${esc(cur.name)}</span>…` +
      (off ? ' <small>(lost connection)</small>' : '') +
      (off && session.mode === 'host' && !room.opts.timer ? ' <button class="btn small" id="btn-skip-turn">Skip their turn</button>' : '');
  }
  document.title = mine && !local && game.phase === 'playing' ? '🟢 Your turn! · Squares' : 'Squares';

  // Power-up buttons (only on your turn)
  const pw = $('powers');
  const me = myPlayer();
  if (game.opts.powerups && mine && me && game.phase === 'playing') {
    pw.classList.remove('hidden');
    const canSkip = me.powers.skip > 0 && game.order.length > 2 && !game.skipNext;
    pw.innerHTML = `
      <button class="power" data-power="double" ${me.powers.double > 0 ? '' : 'disabled'}>⏩<span>Double</span></button>
      <button class="power" data-power="skip" ${canSkip ? '' : 'disabled'}>🚫<span>${game.skipNext ? 'Skipping!' : 'Skip next'}</span></button>`;
  } else pw.classList.add('hidden');

  board.render(game, recentForViewer(game, local ? game.turn : you));
  if (wasHidden) requestAnimationFrame(() => board.fit());

  $('menu-room').innerHTML = (room.code ? `Room ${room.code}` : 'Playing on this device') +
    `<div class="opt-summary">${describeOpts(game.opts, game.rows, game.cols).map((b) => `<span>${esc(b)}</span>`).join('')}</div>`;

  // Sounds, toasts, buzz
  const key = `${room.code}:${room.round}:${game.rows}x${game.cols}`;
  if (seen.key !== key) {
    seen = { key, moveCount: game.moveCount, eventId: game.eventId || 0, myTurn: false, overShownFor: null };
  }
  if (game.moveCount > seen.moveCount && game.lastMove) {
    const lm = game.lastMove;
    const who = game.players[lm.player];
    const name = nameOf(game, lm.player, you);
    if (lm.claimed) {
      sounds.box();
      const pts = lm.points > lm.claimed ? ` (${lm.points} points!)` : '';
      toast(lm.stars ? `⭐ ${name} got a star: a free extra turn saved for later!` :
        `${who.avatar} ${name} got ${lm.claimed === 2 ? 'two boxes' : 'a box'}${pts}! Go again!`);
    } else {
      sounds.line();
      if (lm.auto) toast(`⏰ Time's up! A line was drawn for ${name === 'You' ? 'you' : name}.`);
    }
  }
  if ((game.eventId || 0) > seen.eventId && game.lastEvent) {
    const ev = game.lastEvent;
    const name = nameOf(game, ev.player, you);
    if (ev.type === 'power') {
      sounds.power();
      toast(ev.kind === 'double' ? `⏩ ${name} used Double: two lines in a row!` : `🚫 ${name} will skip the next player!`);
    } else if (ev.type === 'extra') toast(`⭐ ${name} used a saved extra turn!`);
    else if (ev.type === 'skipped') toast(`🚫 ${nameOf(game, ev.skipped, you)} got skipped!`);
  }
  if (!local && mine && !seen.myTurn && game.moveCount > 0) {
    setTimeout(sounds.turn, 250);
    if (navigator.vibrate) navigator.vibrate(120);
  }
  seen.moveCount = game.moveCount;
  seen.eventId = game.eventId || 0;
  seen.myTurn = mine;

  if (game.phase === 'over' && seen.overShownFor !== key) {
    seen.overShownFor = key;
    setTimeout(() => showGameOver(), 700);
  }
  if (game.phase !== 'over') $('over').classList.add('hidden');
}

// Turn timer bar
let lastTick = 0;
function timerLoop() {
  const v = session.view;
  const bar = $('timer');
  const g = v && v.room.game;
  if (v && v.deadline && g && g.phase === 'playing' && !$('screen-game').classList.contains('hidden')) {
    const total = (v.room.opts.timer || 30) * 1000;
    const left = Math.max(0, v.deadline - performance.now());
    bar.classList.remove('hidden');
    bar.firstElementChild.style.width = (left / total) * 100 + '%';
    bar.classList.toggle('low', left < 5000);
    const secs = Math.ceil(left / 1000);
    bar.lastElementChild.textContent = secs + 's';
    if (left < 5000 && secs !== lastTick && isMyTurn() && left > 0) {
      lastTick = secs;
      sounds.tick();
    }
  } else bar.classList.add('hidden');
  requestAnimationFrame(timerLoop);
}
requestAnimationFrame(timerLoop);

// Floating emoji reactions
function showReaction(idx, e) {
  const v = session.view;
  const p = v && v.room.players[idx];
  const el = document.createElement('div');
  el.className = 'reaction';
  el.style.left = 15 + Math.random() * 60 + '%';
  el.innerHTML = `<span class="big">${e}</span><span class="who">${p ? esc(p.avatar + ' ' + p.name) : ''}</span>`;
  $('reactions').appendChild(el);
  sounds.pop();
  setTimeout(() => el.remove(), 2600);
}

function showGameOver() {
  const v = session.view;
  if (!v || !v.room.game || v.room.game.phase !== 'over') return;
  const { room, you } = v;
  const game = room.game;
  const win = winners(game);
  const local = session.mode === 'local';
  const iWon = !local && win.players.some((w) => w.index === you);
  if (win.teams) {
    $('over-emoji').textContent = win.teams.length > 1 ? '🤝' : '🏆';
    $('over-title').textContent = win.teams.length > 1
      ? `It's a tie between the ${win.teams.map((t) => t.name.split(' ')[0]).join(' and ')} teams!`
      : `${win.teams[0].name} wins!${iWon ? ' 🎉' : ''}`;
    $('over-scores').innerHTML = teamScores(game).sort((a, b) => b.score - a.score).map((t) => `
      <li style="--pc:${t.color}" class="${win.teams.some((w) => w.index === t.index) ? 'win' : ''}">
        <span class="nm">${t.name}<small>${t.members.map((m) => `${m.avatar} ${esc(m.name)} ${m.score}`).join(' · ')}</small></span><span>${t.score}</span></li>`).join('');
  } else {
    const ps = win.players;
    if (ps.length > 1) {
      $('over-emoji').textContent = '🤝';
      $('over-title').textContent = `It's a tie between ${ps.map((w) => w.name).join(' and ')}!`;
    } else {
      $('over-emoji').textContent = ps[0].avatar + '🏆';
      $('over-title').textContent = iWon ? 'You win! 🎉' : `${ps[0].name} wins!`;
    }
    const order = game.players.map((p, i) => ({ ...p, index: i })).sort((a, b) => b.score - a.score);
    $('over-scores').innerHTML = order.map((p) => `<li style="--pc:${p.color}" class="${ps.some((w) => w.index === p.index) ? 'win' : ''}">
      <span>${p.avatar}</span><span class="nm">${esc(p.name)}</span><span>${p.score}</span></li>`).join('');
  }
  // Running tally of wins
  const tally = room.players.map((p) => ({ ...p })).sort((a, b) => (b.wins || 0) - (a.wins || 0));
  $('over-tally').innerHTML = tally.some((p) => p.wins)
    ? `<div class="tally-title">Games won so far</div>` + tally.map((p) => `<span>${p.avatar} ${esc(p.name)} <b>${p.wins || 0}</b></span>`).join('')
    : '';
  const canRestart = runsGame();
  $('over-host').classList.toggle('hidden', !canRestart);
  $('btn-to-lobby').textContent = local ? 'Change players or options' : 'Back to the lobby';
  const host = room.players.find((p) => p.host);
  $('over-guest').textContent = canRestart ? '' : `Waiting for ${host ? host.name : 'the host'} to start a rematch…`;
  $('over').classList.remove('hidden');
  celebrate(win.players.map((w) => w.color), win.players.map((w) => w.avatar));
  sounds.win();
}

function celebrate(colors, emojis) {
  const palette = [...colors, ...colors, ...COLORS];
  for (let i = 0; i < 70; i++) {
    const d = document.createElement('div');
    d.className = 'confetti';
    d.style.left = Math.random() * 100 + 'vw';
    d.style.background = palette[Math.floor(Math.random() * palette.length)];
    d.style.animationDuration = 1.8 + Math.random() * 1.8 + 's';
    d.style.animationDelay = Math.random() * 0.6 + 's';
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 4500);
  }
  // The winners' emoji rain down too
  for (let i = 0; i < 18; i++) {
    const d = document.createElement('div');
    d.className = 'confetti emoji';
    d.textContent = emojis[i % emojis.length];
    d.style.left = Math.random() * 95 + 'vw';
    d.style.animationDuration = 2.2 + Math.random() * 1.6 + 's';
    d.style.animationDelay = Math.random() * 1.2 + 's';
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 5200);
  }
}

// ---------------------------------------------------------------------------
// Leaving, errors, URL
// ---------------------------------------------------------------------------
function showError(msg) {
  if (!$('screen-game').classList.contains('hidden')) return toast(msg);
  if (!$('screen-local').classList.contains('hidden') || session.mode === 'local') {
    return toast(msg);
  }
  const where = session.mode === 'host' && session.view && session.view.room.phase === 'lobby' ? 'lobby-error' : 'home-error';
  $(where).textContent = msg;
  if (where === 'home-error' && session.mode !== 'host') $('lobby-error').textContent = '';
}

function setRoomInUrl(code) {
  const u = new URL(location.href);
  if (code) u.searchParams.set('room', code);
  else u.searchParams.delete('room');
  history.replaceState(null, '', u);
}

function leave(silent) {
  if (!silent) {
    if (session.mode === 'host' && session.room.phase === 'playing' &&
      !confirm('Leave the game? This ends it for everyone.')) return;
    if (session.mode === 'guest' && session.view && session.view.room.phase === 'playing' &&
      !confirm('Leave the game?')) return;
  }
  if (session.mode === 'host') store.del('sq-host');
  clearTimeout(session.autoTimer);
  try { session.net && session.net.close(); } catch {}
  const wasLocal = session.mode === 'local';
  session = { mode: null };
  setRoomInUrl(null);
  $('home-error').textContent = '';
  $('lobby-error').textContent = '';
  if (wasLocal && !silent) return startLocalSetup();
  goHome();
}

function goHome() {
  clearTimeout(session.autoTimer);
  session = { mode: null };
  showScreen('home');
  renderHome();
}

// ---------------------------------------------------------------------------
// Home screen
// ---------------------------------------------------------------------------
function renderHome() {
  $('my-name').value = profile.name;
  $('my-avatar').innerHTML = AVATARS.map((a) => `<button role="radio" aria-checked="${a === profile.avatar}" data-a="${a}" aria-label="${a}">${a}</button>`).join('');
  const saved = store.get('sq-host', null);
  const resume = $('btn-resume');
  if (saved && saved.code && saved.phase !== 'lobby') {
    resume.textContent = `↩ Go back to your game (room ${saved.code})`;
    resume.classList.remove('hidden');
  } else resume.classList.add('hidden');
}

$('my-name').addEventListener('input', (e) => {
  profile.name = e.target.value.slice(0, 14);
  saveProfile();
});
$('my-avatar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  profile.avatar = b.dataset.a;
  saveProfile();
  renderHome();
});
$('btn-host').addEventListener('click', () => {
  if (!profile.name.trim()) {
    $('my-name').focus();
    return showError('Type your name first.');
  }
  $('home-error').textContent = '';
  startHost(null);
});
$('btn-resume').addEventListener('click', () => {
  const saved = store.get('sq-host', null);
  if (saved) startHost(saved);
});
$('btn-join').addEventListener('click', () => {
  $('home-error').textContent = '';
  startGuest($('join-code').value);
});
$('join-code').addEventListener('input', (e) => (e.target.value = normalizeCode(e.target.value)));
$('join-code').addEventListener('keydown', (e) => e.key === 'Enter' && $('btn-join').click());
$('btn-local').addEventListener('click', () => startLocalSetup());

// Lobby
$('my-color').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-color]');
  if (!b || b.disabled) return;
  if (session.mode === 'host') {
    session.room.players[0].color = b.dataset.color;
    commit();
  } else if (session.mode === 'guest') guestSend({ t: 'profile', color: b.dataset.color });
});
$('lobby-players').addEventListener('click', (e) => {
  if (session.mode !== 'host') return;
  const room = session.room;
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.level != null) {
    const p = room.players[+b.dataset.level];
    if (p && p.bot) p.bot = nextLevel(p.bot);
    return commit();
  }
  if (b.dataset.team != null) {
    const p = room.players[+b.dataset.team];
    if (p && room.opts.teams) p.team = (p.team + 1) % room.opts.teams;
    return commit();
  }
  if (b.dataset.kick != null) {
    const i = +b.dataset.kick;
    const p = room.players[i];
    if (!p || p.host) return;
    for (const [conn, cid] of session.conns) {
      if (cid === p.cid) {
        conn.send({ t: 'error', msg: 'The host removed you from the game.' });
        session.conns.delete(conn);
        setTimeout(() => conn.close(), 300);
      }
    }
    room.players.splice(i, 1);
    commit();
  }
});
$('btn-add-bot').addEventListener('click', () => {
  if (session.mode !== 'host') return;
  const room = session.room;
  if (room.players.length >= MAX_PLAYERS) return;
  const b = makeBot(room.players);
  b.team = room.opts.teams ? room.players.length % room.opts.teams : 0;
  room.players.push(b);
  commit();
});
$('btn-start').addEventListener('click', () => startGameFromRoom());
$('btn-copy').addEventListener('click', async () => {
  const link = shareLink($('room-code').textContent);
  try {
    await navigator.clipboard.writeText(link);
    $('btn-copy').textContent = '✅ Copied!';
  } catch {
    prompt('Copy this link:', link);
  }
  setTimeout(() => ($('btn-copy').textContent = '📋 Copy link'), 1500);
});
$('btn-share').addEventListener('click', async () => {
  const link = shareLink($('room-code').textContent);
  if (navigator.share) {
    try { await navigator.share({ title: 'Play Squares with me!', text: `Join my Squares game. Room code ${$('room-code').textContent}`, url: link }); } catch {}
  } else $('btn-copy').click();
});
if (!navigator.share) $('btn-share').classList.add('hidden');

// Game
$('zoom-in').addEventListener('click', () => board.zoomIn());
$('zoom-out').addEventListener('click', () => board.zoomOut());
$('zoom-fit').addEventListener('click', () => board.fit());
$('btn-menu').addEventListener('click', () => {
  $('opt-confirm').checked = prefs.confirm;
  $('opt-sound').checked = prefs.sound;
  $('menu').classList.remove('hidden');
});
$('opt-confirm').addEventListener('change', (e) => { prefs.confirm = e.target.checked; savePrefs(); board.clearPending(); });
$('opt-sound').addEventListener('change', (e) => { prefs.sound = e.target.checked; savePrefs(); });
$('powers').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-power]');
  if (b && !b.disabled) pressPower(b.dataset.power);
});
$('btn-react').addEventListener('click', () => $('react-tray').classList.toggle('hidden'));
$('react-tray').innerHTML = REACTIONS.map((r) => `<button data-r="${r}" aria-label="Send ${r}">${r}</button>`).join('');
$('react-tray').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-r]');
  if (b) sendReaction(b.dataset.r);
});
$('turn-banner').addEventListener('click', (e) => {
  if (e.target.id !== 'btn-skip-turn' || session.mode !== 'host') return;
  session.room.game = skipTurn(session.room.game);
  commit();
});
$('btn-again').addEventListener('click', () => {
  $('over').classList.add('hidden');
  if (!runsGame()) return;
  session.room.round++;
  startGameFromRoom();
});
$('btn-to-lobby').addEventListener('click', () => {
  $('over').classList.add('hidden');
  if (session.mode === 'local') {
    clearTimeout(session.autoTimer);
    return startLocalSetup();
  }
  const room = session.room;
  room.phase = 'lobby';
  room.game = null;
  room.round++;
  room.players = room.players.filter((p) => p.connected);
  commit();
});

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]');
  if (!a) return;
  const act = a.dataset.action;
  if (act === 'leave') { $('menu').classList.add('hidden'); leave(false); }
  if (act === 'home') goHome();
  if (act === 'close-menu') $('menu').classList.add('hidden');
  if (act === 'close-over') $('over').classList.add('hidden');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('menu').classList.add('hidden');
    $('over').classList.add('hidden');
    $('react-tray').classList.add('hidden');
  }
});
// Tap outside a sheet to close it
for (const id of ['menu', 'over']) {
  $(id).addEventListener('click', (e) => { if (e.target.id === id) $(id).classList.add('hidden'); });
}

// ---------------------------------------------------------------------------
// Start up
// ---------------------------------------------------------------------------
function boot() {
  if (typeof Peer === 'undefined' && !LOCAL_NET) {
    // Script tags with `defer` run before modules, so this only happens if the
    // file failed to load.
    $('btn-host').disabled = true;
    $('btn-join').disabled = true;
    showError('Online play could not load. You can still play on this device.');
  }
  goHome();
  const code = normalizeCode(params.get('room'));
  if (code) {
    $('join-code').value = code;
    if (profile.name.trim()) startGuest(code);
    else {
      $('home-error').textContent = '';
      $('my-name').focus();
      $('my-name').placeholder = 'Type your name, then tap Join';
    }
  }
}
boot();
