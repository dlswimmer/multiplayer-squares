import {
  COLORS, AVATARS, MAX_PLAYERS, clampSize, newGame, applyMove, skipTurn, winners,
} from './game.js';
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
};

// ---------------------------------------------------------------------------
// The session: what we're doing right now
// ---------------------------------------------------------------------------
// mode: null | 'host' | 'guest' | 'local'
// room (what every screen renders from):
//   { code, phase: 'lobby'|'playing'|'over', rows, cols, round,
//     players: [{ name, avatar, color, connected, host }], game }
let session = { mode: null };

// Effects tracking, so sounds/toasts fire once per move.
let seen = { key: null, moveCount: -1, myTurn: false, overShownFor: null };

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
    round: 0,
    players: [{ cid: clientId, name: cleanName(profile.name), avatar: cleanAvatar(profile.avatar), color: COLORS[0], connected: true, host: true }],
    game: null,
  };
  room.players.forEach((p) => (p.connected = p.cid === clientId));
  const conns = new Map(); // conn -> cid
  const net = createHost(code);
  session = { mode: 'host', room, net, conns, online: false, status: 'Opening the room…' };
  seen = { key: null, moveCount: -1, myTurn: false, overShownFor: null };

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
      // Still connected on another tab/connection? Then nothing changed.
      if ([...conns.values()].includes(cid)) return;
      const i = room.players.findIndex((p) => p.cid === cid);
      if (i < 0) return;
      if (room.phase === 'lobby') room.players.splice(i, 1);
      else room.players[i].connected = false;
      hostBroadcast();
    });
  });
  hostBroadcast();
}

function hostHandle(conn, m) {
  const { room, conns } = session;
  if (!m || typeof m !== 'object') return;
  if (m.t === 'hello') {
    const cid = String(m.clientId || '').slice(0, 40);
    if (!cid || cid === clientId) return conn.send({ t: 'error', msg: "You can't join your own game from the same browser." });
    conns.set(conn, cid);
    let p = room.players.find((x) => x.cid === cid);
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
        const used = new Set(room.players.map((x) => x.color));
        room.players.push({
          cid,
          name: cleanName(m.name),
          avatar: cleanAvatar(m.avatar),
          color: COLORS.find((c) => !used.has(c)),
          connected: true,
        });
      }
    }
    // Anyone who isn't a player (joined mid-game) can still watch.
    hostBroadcast();
    return;
  }
  const cid = conns.get(conn);
  const idx = room.players.findIndex((p) => p.cid === cid);
  if (idx < 0) return;
  if (m.t === 'move') hostMove(idx, m, conn);
  else if (m.t === 'color' && room.phase === 'lobby') {
    if (COLORS.includes(m.color) && !room.players.some((p) => p.color === m.color)) {
      room.players[idx].color = m.color;
      hostBroadcast();
    }
  }
}

function hostMove(idx, m, conn) {
  const { room } = session;
  if (!room.game) return;
  const res = applyMove(room.game, idx, { k: m.k, r: m.r, c: m.c });
  if (!res.ok) {
    if (conn) conn.send({ t: 'error', msg: res.error });
    else toast(res.error);
    hostBroadcast(); // resync whoever was confused
    return;
  }
  room.game = res.state;
  if (room.game.phase === 'over') room.phase = 'over';
  hostBroadcast();
}

function publicRoom(room) {
  return {
    code: room.code,
    phase: room.phase,
    rows: room.rows,
    cols: room.cols,
    round: room.round,
    players: room.players.map(({ name, avatar, color, connected, host }) => ({ name, avatar, color, connected, host: !!host })),
    game: room.game,
  };
}

function hostBroadcast() {
  const { room, conns } = session;
  const pub = publicRoom(room);
  for (const [conn, cid] of conns) {
    conn.send({ t: 'room', room: pub, you: room.players.findIndex((p) => p.cid === cid) });
  }
  store.set('sq-host', room);
  session.view = { room: pub, you: 0 };
  render();
}

function hostStartGame() {
  const { room } = session;
  const n = room.players.length;
  if (n < 2) return showError('You need at least 2 players. Share the code!');
  room.game = newGame(room.rows, room.cols, room.players.map(({ name, avatar, color }) => ({ name, avatar, color })), room.round % n);
  room.phase = 'playing';
  hostBroadcast();
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
  seen = { key: null, moveCount: -1, myTurn: false, overShownFor: null };
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
      s.view = { room: m.room, you: m.you };
      s.waiting = false;
      render();
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

function renderConnecting() {
  showScreen('lobby');
  $('room-code').textContent = session.code;
  $('lobby-status').textContent = session.status;
  $('lobby-players').innerHTML = '<li><span class="nm">Connecting to the game…</span></li>';
  $('host-settings').classList.add('hidden');
  $('guest-wait').classList.add('hidden');
  $('my-color').parentElement.classList.add('hidden');
  renderShare(session.code);
}

// ---------------------------------------------------------------------------
// LOCAL (pass and play on one device)
// ---------------------------------------------------------------------------
let localSetup = store.get('sq-local-setup', null);
function startLocalSetup() {
  if (!localSetup) {
    localSetup = {
      rows: 4,
      cols: 4,
      players: [
        { name: cleanName(profile.name, 'Player 1'), avatar: cleanAvatar(profile.avatar), color: COLORS[0] },
        { name: 'Player 2', avatar: AVATARS.find((a) => a !== profile.avatar), color: COLORS[1] },
      ],
    };
  }
  session = { mode: 'local-setup' };
  showScreen('local');
  renderLocalSetup();
}

function renderLocalSetup() {
  const list = $('local-players');
  list.innerHTML = localSetup.players.map((p, i) => `
    <li style="--pc:${p.color}">
      <button class="av-btn" data-i="${i}" data-act="avatar" aria-label="Change animal">${p.avatar}</button>
      <input data-i="${i}" value="${esc(p.name)}" maxlength="14" aria-label="Player ${i + 1} name">
      <button class="sw" data-i="${i}" data-act="color" style="background:${p.color}" aria-label="Change color"></button>
      ${localSetup.players.length > 2 ? `<button class="x" data-i="${i}" data-act="remove" aria-label="Remove player">✕</button>` : ''}
    </li>`).join('');
  $('btn-local-add').disabled = localSetup.players.length >= MAX_PLAYERS;
  renderSizePicker('local-size-presets', 'local-rows', 'local-cols', localSetup, () => saveLocalSetup());
}
function saveLocalSetup() { store.set('sq-local-setup', localSetup); }

$('local-players').addEventListener('input', (e) => {
  const i = +e.target.dataset.i;
  if (e.target.tagName === 'INPUT') { localSetup.players[i].name = e.target.value; saveLocalSetup(); }
});
$('local-players').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const i = +b.dataset.i;
  const p = localSetup.players[i];
  if (b.dataset.act === 'avatar') p.avatar = AVATARS[(AVATARS.indexOf(p.avatar) + 1) % AVATARS.length];
  if (b.dataset.act === 'color') {
    const used = new Set(localSetup.players.map((x) => x.color));
    let j = COLORS.indexOf(p.color);
    for (let n = 0; n < COLORS.length; n++) {
      j = (j + 1) % COLORS.length;
      if (!used.has(COLORS[j])) { p.color = COLORS[j]; break; }
    }
  }
  if (b.dataset.act === 'remove') localSetup.players.splice(i, 1);
  saveLocalSetup();
  renderLocalSetup();
});
$('btn-local-add').addEventListener('click', () => {
  const n = localSetup.players.length;
  if (n >= MAX_PLAYERS) return;
  const used = new Set(localSetup.players.map((x) => x.color));
  const usedAv = new Set(localSetup.players.map((x) => x.avatar));
  localSetup.players.push({
    name: `Player ${n + 1}`,
    avatar: AVATARS.find((a) => !usedAv.has(a)),
    color: COLORS.find((c) => !used.has(c)),
  });
  saveLocalSetup();
  renderLocalSetup();
});
$('btn-local-start').addEventListener('click', () => startLocalGame(0));

function startLocalGame(round) {
  const players = localSetup.players.map((p, i) => ({
    name: cleanName(p.name, `Player ${i + 1}`), avatar: p.avatar, color: p.color, connected: true,
  }));
  const room = {
    code: null, phase: 'playing', rows: localSetup.rows, cols: localSetup.cols, round, players,
    game: newGame(localSetup.rows, localSetup.cols, players, round % players.length),
  };
  session = { mode: 'local', room };
  seen = { key: null, moveCount: -1, myTurn: false, overShownFor: null };
  localUpdate();
}
function localUpdate() {
  session.view = { room: session.room, you: session.room.game.turn };
  render();
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

function renderLobby() {
  const { room, you } = session.view;
  const isHost = session.mode === 'host';
  showScreen('lobby');
  $('room-code').textContent = room.code;
  renderShare(room.code);
  const st = $('lobby-status');
  st.textContent = session.status || '';
  st.className = 'status-pill ' + (session.online ? 'ok' : 'bad');

  $('lobby-players').innerHTML = room.players.map((p, i) => `
    <li style="--pc:${p.color}" class="${p.connected ? '' : 'off'}">
      <span class="av">${p.avatar}</span>
      <span class="nm">${esc(p.name)}</span>
      ${i === you ? '<span class="tag">YOU</span>' : ''}
      ${p.host ? '<span class="tag">HOST</span>' : ''}
      ${isHost && !p.host ? `<button class="x" data-kick="${i}" aria-label="Remove ${esc(p.name)}">✕</button>` : ''}
    </li>`).join('') +
    (room.players.length < 2 ? '<li><span class="nm" style="color:var(--muted)">Waiting for someone to join…</span></li>' : '');

  // Color picker for me
  const me = room.players[you];
  const cp = $('my-color');
  cp.parentElement.classList.toggle('hidden', !me);
  if (me) {
    cp.innerHTML = COLORS.map((c) => {
      const taken = room.players.some((p, i) => p.color === c && i !== you);
      return `<button role="radio" aria-checked="${c === me.color}" ${taken ? 'disabled' : ''} data-color="${c}" style="background:${c}" aria-label="Color"></button>`;
    }).join('');
  }

  $('host-settings').classList.toggle('hidden', !isHost);
  $('guest-wait').classList.toggle('hidden', isHost);
  if (isHost) {
    renderSizePicker('size-presets', 'rows', 'cols', session.room, () => hostBroadcast());
    $('btn-start').disabled = room.players.length < 2;
    $('btn-start').textContent = room.players.length < 2 ? 'Waiting for players…' : `▶ Start game (${room.players.length} players)`;
  } else {
    const host = room.players.find((p) => p.host);
    $('guest-wait').textContent = me
      ? `⏳ Waiting for ${host ? host.name : 'the host'} to start a ${room.rows} × ${room.cols} game…`
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

const board = createBoard($('board'), {
  onPick: (e) => pickLine(e),
  canPlay: () => isMyTurn() && !session.waiting,
  myColor: () => {
    const v = session.view;
    const p = v && v.room.game && v.room.game.players[session.mode === 'local' ? v.room.game.turn : v.you];
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

function isMyTurn() {
  const v = session.view;
  if (!v || !v.room.game || v.room.game.phase !== 'playing') return false;
  if (session.mode === 'local') return true;
  return v.room.game.turn === v.you;
}

function pickLine(e) {
  if (session.mode === 'host') hostMove(0, e, null);
  else if (session.mode === 'guest') {
    if (!session.online) return toast('Not connected right now…');
    session.waiting = true;
    session.net.send({ t: 'move', k: e.k, r: e.r, c: e.c });
    setTimeout(() => { if (session.waiting) { session.waiting = false; } }, 4000);
  } else if (session.mode === 'local') {
    const res = applyMove(session.room.game, session.room.game.turn, e);
    if (!res.ok) return toast(res.error);
    session.room.game = res.state;
    if (res.state.phase === 'over') session.room.phase = 'over';
    localUpdate();
  }
}

function renderGame() {
  const { room, you } = session.view;
  const game = room.game;
  const wasHidden = $('screen-game').classList.contains('hidden');
  showScreen('game');
  const local = session.mode === 'local';
  const meIdx = local ? game.turn : you;

  // Scoreboard
  $('scores').innerHTML = game.players.map((p, i) => {
    const off = !local && room.players[i] && !room.players[i].connected;
    return `<div class="chip${i === game.turn && game.phase === 'playing' ? ' turn' : ''}${off ? ' off' : ''}" style="--pc:${p.color}">
      <span class="av">${p.avatar}</span><span class="nm">${esc(p.name)}${!local && i === you ? ' (you)' : ''}</span><span class="sc">${p.score}</span></div>`;
  }).join('');
  const turnChip = $('scores').querySelector('.chip.turn');
  if (turnChip) turnChip.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  // Turn banner
  const cur = game.players[game.turn];
  const banner = $('turn-banner');
  const mine = isMyTurn();
  banner.style.setProperty('--pc', cur.color);
  banner.classList.toggle('mine', mine && !local);
  if (game.phase === 'over') {
    banner.textContent = '🏁 Game over!';
  } else if (session.mode === 'guest' && !session.online) {
    banner.textContent = '📡 ' + session.status;
  } else if (local) {
    banner.innerHTML = `<span style="color:${cur.color}">${cur.avatar} ${esc(cur.name)}'s turn</span>`;
  } else if (mine) {
    banner.textContent = `${cur.avatar} Your turn, ${cur.name}!`;
  } else {
    const off = room.players[game.turn] && !room.players[game.turn].connected;
    banner.innerHTML = `Waiting for <span style="color:${cur.color}">${cur.avatar} ${esc(cur.name)}</span>…` +
      (off ? ' <small>(lost connection)</small>' : '') +
      (off && session.mode === 'host' ? ' <button class="btn small" id="btn-skip-turn">Skip their turn</button>' : '');
  }
  document.title = mine && !local && game.phase === 'playing' ? '🟢 Your turn! · Squares' : 'Squares';

  board.render(game);
  if (wasHidden) requestAnimationFrame(() => board.fit());

  // Menu details
  $('menu-room').textContent = room.code ? `Room ${room.code}` : 'Playing on this device';

  // Sounds, toasts, buzz
  const key = `${room.code}:${room.round}:${game.rows}x${game.cols}`;
  if (seen.key !== key) seen = { key, moveCount: game.moveCount, myTurn: false, overShownFor: null };
  if (game.moveCount > seen.moveCount && game.lastMove) {
    const lm = game.lastMove;
    if (lm.claimed) {
      sounds.box();
      const who = game.players[lm.player];
      toast(`${who.avatar} ${local || lm.player !== you ? who.name : 'You'} got ${lm.claimed === 2 ? 'two boxes' : 'a box'}! Go again!`);
    } else sounds.line();
  }
  if (!local && mine && !seen.myTurn && game.moveCount > 0) {
    setTimeout(sounds.turn, 250);
    if (navigator.vibrate) navigator.vibrate(120);
  }
  seen.moveCount = game.moveCount;
  seen.myTurn = mine;

  if (game.phase === 'over' && seen.overShownFor !== key) {
    seen.overShownFor = key;
    setTimeout(() => showGameOver(), 700);
  }
  if (game.phase !== 'over') $('over').classList.add('hidden');
}

function showGameOver() {
  const v = session.view;
  if (!v || !v.room.game || v.room.game.phase !== 'over') return;
  const { room, you } = v;
  const game = room.game;
  const win = winners(game);
  const local = session.mode === 'local';
  const iWon = !local && win.some((w) => w.index === you);
  if (win.length > 1) {
    $('over-emoji').textContent = '🤝';
    $('over-title').textContent = `It's a tie between ${win.map((w) => w.name).join(' and ')}!`;
  } else {
    $('over-emoji').textContent = win[0].avatar + '🏆';
    $('over-title').textContent = iWon ? 'You win! 🎉' : `${win[0].name} wins!`;
  }
  const order = game.players.map((p, i) => ({ ...p, index: i })).sort((a, b) => b.score - a.score);
  $('over-scores').innerHTML = order.map((p) => `<li style="--pc:${p.color}" class="${win.some((w) => w.index === p.index) ? 'win' : ''}">
    <span>${p.avatar}</span><span class="nm">${esc(p.name)}</span><span>${p.score}</span></li>`).join('');
  const canRestart = session.mode === 'host' || local;
  $('over-host').classList.toggle('hidden', !canRestart);
  $('btn-to-lobby').textContent = local ? 'Change board or players' : 'Back to the lobby';
  const host = room.players.find((p) => p.host);
  $('over-guest').textContent = canRestart ? '' : `Waiting for ${host ? host.name : 'the host'} to start another game…`;
  $('over').classList.remove('hidden');
  if (iWon || local || win.length === 1) confetti(win.map((w) => w.color));
  sounds.win();
}

function confetti(colors) {
  for (let i = 0; i < 60; i++) {
    const d = document.createElement('div');
    d.className = 'confetti';
    d.style.left = Math.random() * 100 + 'vw';
    d.style.background = [...colors, ...COLORS][Math.floor(Math.random() * (colors.length + COLORS.length))];
    d.style.animationDuration = 1.8 + Math.random() * 1.8 + 's';
    d.style.animationDelay = Math.random() * 0.6 + 's';
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 4500);
  }
}

// ---------------------------------------------------------------------------
// Leaving, errors, URL
// ---------------------------------------------------------------------------
function showError(msg) {
  if (!$('screen-game').classList.contains('hidden')) return toast(msg);
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
    if (session.mode === 'host' && session.room.phase !== 'lobby' && session.room.phase !== 'over' &&
      !confirm('Leave the game? This ends it for everyone.')) return;
    if (session.mode === 'guest' && session.view && session.view.room.phase === 'playing' &&
      !confirm('Leave the game?')) return;
  }
  if (session.mode === 'host') store.del('sq-host');
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
    hostBroadcast();
  } else if (session.mode === 'guest' && session.net) session.net.send({ t: 'color', color: b.dataset.color });
});
$('lobby-players').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-kick]');
  if (!b || session.mode !== 'host') return;
  const i = +b.dataset.kick;
  const p = session.room.players[i];
  if (!p || p.host) return;
  for (const [conn, cid] of session.conns) {
    if (cid === p.cid) {
      conn.send({ t: 'error', msg: 'The host removed you from the game.' });
      session.conns.delete(conn);
      setTimeout(() => conn.close(), 300);
    }
  }
  session.room.players.splice(i, 1);
  hostBroadcast();
});
$('btn-start').addEventListener('click', hostStartGame);
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
$('turn-banner').addEventListener('click', (e) => {
  if (e.target.id !== 'btn-skip-turn' || session.mode !== 'host') return;
  session.room.game = skipTurn(session.room.game);
  hostBroadcast();
});
$('btn-again').addEventListener('click', () => {
  $('over').classList.add('hidden');
  if (session.mode === 'local') return startLocalGame(session.room.round + 1);
  session.room.round++;
  hostStartGame();
});
$('btn-to-lobby').addEventListener('click', () => {
  $('over').classList.add('hidden');
  if (session.mode === 'local') {
    try { session.net && session.net.close(); } catch {}
    return startLocalSetup();
  }
  const room = session.room;
  room.phase = 'lobby';
  room.game = null;
  room.round++;
  room.players = room.players.filter((p) => p.connected);
  hostBroadcast();
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
  if (e.key === 'Escape') { $('menu').classList.add('hidden'); $('over').classList.add('hidden'); }
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
