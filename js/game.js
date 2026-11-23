// Pure game rules. No DOM, no networking, so it can be tested in Node.
//
// Grid of `rows` x `cols` boxes, which means (rows+1) x (cols+1) dots.
// Horizontal edges: (rows+1) rows of `cols` edges  -> h[r * cols + c]
// Vertical edges:   `rows` rows of (cols+1) edges   -> v[r * (cols + 1) + c]
//
// Edge values:  -2 = not part of this board shape, -1 = free, n = drawn by player n
//               -3 = drawn before the game started (belongs to nobody)
// Box values:   -2 = hole (not part of the shape), -4 = blocked square,
//               -1 = unclaimed, n = claimed by player n

export const COLORS = [
  '#e63946', // red
  '#1d72f3', // blue
  '#2a9d4b', // green
  '#f39c12', // orange
  '#8e44ad', // purple
  '#e84393', // pink
  '#12a3a3', // teal
  '#8d5b3a', // brown
];

export const AVATARS = [
  '🦊', '🐼', '🐸', '🦁', '🐙', '🐢', '🦄', '🐝', '🐳', '🐯', '🐵', '🦖',
  '🐶', '🐱', '🐰', '🐧', '🦉', '🐞', '🦈', '🐲', '🚀', '⚽', '🍕', '🌈',
  '👻', '🤖', '👑', '💎', '🔥', '🌟',
];

export const TEAMS = [
  { name: 'Red team', color: '#e63946' },
  { name: 'Blue team', color: '#1d72f3' },
  { name: 'Green team', color: '#2a9d4b' },
  { name: 'Orange team', color: '#f39c12' },
];

export const SHAPES = [
  { id: 'square', label: 'Square', icon: '⬛' },
  { id: 'plus', label: 'Plus', icon: '➕' },
  { id: 'heart', label: 'Heart', icon: '❤️' },
  { id: 'holes', label: 'Holes', icon: '🧀' },
  { id: 'random', label: 'Surprise', icon: '🎲' },
];

export const TIMERS = [0, 10, 20, 30, 60];

export const DEFAULT_OPTS = { shape: 'square', blocked: 0, presets: 0, bonus: false, powerups: false, teams: 0, timer: 0 };

export const PRESET = -3;
export const BLOCKED = -4;
const isDrawn = (x) => x >= 0 || x === PRESET;

export const MIN_SIZE = 2;
export const MAX_SIZE = 20;
export const MAX_PLAYERS = 8;

export function clampSize(n) {
  n = Math.round(Number(n));
  if (!Number.isFinite(n)) return 4;
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, n));
}

export function cleanOpts(o = {}) {
  return {
    shape: SHAPES.some((s) => s.id === o.shape) ? o.shape : 'square',
    blocked: [1, 2].includes(o.blocked) ? o.blocked : 0,
    presets: [1, 2, 3].includes(o.presets) ? o.presets : 0,
    bonus: !!o.bonus,
    powerups: !!o.powerups,
    teams: [2, 3, 4].includes(o.teams) ? o.teams : 0,
    timer: TIMERS.includes(o.timer) ? o.timer : 0,
  };
}

/** Small seeded random generator, so every device builds the same board. */
export function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Which boxes are part of the board (1) or holes (0). */
export function shapeMask(rows, cols, shape, rand = Math.random) {
  const m = new Array(rows * cols).fill(1);
  const set = (fn) => {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) m[r * cols + c] = fn(r, c) ? 1 : 0;
  };
  if (shape === 'plus' && rows >= 3 && cols >= 3) {
    const band = (i, n) => {
      let w = Math.max(1, Math.round(n / 3));
      if ((n - w) % 2) w++; // keep the bar centred
      const start = (n - w) / 2;
      return i >= start && i < start + w;
    };
    set((r, c) => band(r, rows) || band(c, cols));
  } else if (shape === 'heart' && rows >= 4 && cols >= 4) {
    set((r, c) => {
      const x = ((c + 0.5) / cols * 2 - 1) * 1.18;
      const y = 1.3 - ((r + 0.5) / rows) * 2.25;
      const a = x * x + y * y - 1;
      return a * a * a - x * x * y * y * y <= 0;
    });
  } else if (shape === 'holes' && rows >= 3 && cols >= 3) {
    // Evenly spread holes, never on the outside ring.
    set((r, c) => !(r % 3 === 1 && c % 3 === 1 && r < rows - 1 && c < cols - 1));
  } else if (shape === 'random' && rows * cols >= 6) {
    const holes = Math.floor(rows * cols * 0.2);
    for (let i = 0; i < holes; i++) m[Math.floor(rand() * m.length)] = 0;
  }
  if (m.filter(Boolean).length < 2) m.fill(1);
  return m;
}

export function newBoard(rows, cols, shape = 'square', rand = Math.random, { blocked = 0, presets = 0 } = {}) {
  rows = clampSize(rows);
  cols = clampSize(cols);
  const mask = shapeMask(rows, cols, shape, rand);
  const boxes = mask.map((on) => (on ? -1 : -2));
  // Blocked squares: rocks in the middle of the board nobody can claim.
  if (blocked) {
    const open = boxes.map((b, i) => (b === -1 ? i : -1)).filter((i) => i >= 0);
    const count = Math.min(open.length - 2, Math.round(open.length * (blocked === 1 ? 0.08 : 0.16)) || 1);
    shuffle(open, rand);
    for (const i of open.slice(0, Math.max(0, count))) boxes[i] = BLOCKED;
  }
  const board = {
    rows,
    cols,
    h: new Array((rows + 1) * cols).fill(-2),
    v: new Array(rows * (cols + 1)).fill(-2),
    boxes,
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (boxes[r * cols + c] !== -1) continue;
      board.h[r * cols + c] = -1;
      board.h[(r + 1) * cols + c] = -1;
      board.v[r * (cols + 1) + c] = -1;
      board.v[r * (cols + 1) + c + 1] = -1;
    }
  }
  // Lines already drawn at the start. Never so many that a box is nearly
  // finished (at most 2 sides of any box), so nobody gets a free box.
  if (presets) {
    const free = shuffle(freeEdges(board), rand);
    const want = Math.round(free.length * [0, 0.1, 0.2, 0.3][presets]);
    let placed = 0;
    for (const e of free) {
      if (placed >= want) break;
      if (adjacentBoxes(board, e.k, e.r, e.c).every(([br, bc]) => sidesDrawn(board, br, bc) < 2)) {
        board[e.k][edgeIndex(board, e.k, e.r, e.c)] = PRESET;
        placed++;
      }
    }
  }
  return board;
}

function shuffle(a, rand) {
  for (let k = a.length - 1; k > 0; k--) {
    const j = Math.floor(rand() * (k + 1));
    [a[k], a[j]] = [a[j], a[k]];
  }
  return a;
}

/** Turn order: players of different teams take turns one after another. */
export function turnOrder(players, teams) {
  const idx = players.map((_, i) => i);
  if (!teams) return idx;
  const byTeam = Array.from({ length: teams }, (_, t) => idx.filter((i) => players[i].team === t));
  const out = [];
  for (let k = 0; out.length < idx.length; k++) {
    for (const list of byTeam) if (k < list.length) out.push(list[k]);
  }
  return out;
}

/**
 * Create a full game.
 * players: [{ name, color, avatar, team?, bot? }]
 */
export function newGame({ rows, cols, players, opts, firstTurn = 0, seed = Date.now() }) {
  opts = cleanOpts(opts);
  const rand = rng(seed);
  const board = newBoard(rows, cols, opts.shape, rand, opts);
  const n = board.boxes.length;
  const values = new Array(n).fill(1);
  const stars = new Array(n).fill(0);
  if (opts.bonus) {
    const open = shuffle(board.boxes.map((b, i) => (b === -1 ? i : -1)).filter((i) => i >= 0), rand);
    const count = Math.max(2, Math.round(open.length * 0.18));
    open.slice(0, count).forEach((i, k) => {
      if (k % 3 === 2) stars[i] = 1;
      else values[i] = k % 3 === 0 ? 2 : 3;
    });
  }
  const ps = players.map((p) => ({
    name: p.name,
    avatar: p.avatar,
    color: opts.teams ? TEAMS[p.team || 0].color : p.color,
    team: opts.teams ? p.team || 0 : null,
    bot: p.bot || null,
    score: 0,
    extraTurns: 0,
    powers: opts.powerups ? { double: 1, skip: 1 } : { double: 0, skip: 0 },
  }));
  const order = turnOrder(ps, opts.teams);
  return {
    ...board,
    values,
    stars,
    opts,
    players: ps,
    order,
    turn: order.length ? order[firstTurn % order.length] : 0,
    phase: 'playing',
    skipNext: false,
    lastMove: null, // { k, r, c, player, claimed, points, stars, auto }
    lastEvent: null, // { type: 'power'|'skip'|'extra', ... } for toasts
    moveCount: 0,
  };
}

export function edgeIndex(board, k, r, c) {
  const { rows, cols } = board;
  if (!Number.isInteger(r) || !Number.isInteger(c)) return -1;
  if (k === 'h') {
    if (r < 0 || r > rows || c < 0 || c >= cols) return -1;
    return r * cols + c;
  }
  if (k === 'v') {
    if (r < 0 || r >= rows || c < 0 || c > cols) return -1;
    return r * (cols + 1) + c;
  }
  return -1;
}

export function getEdge(board, k, r, c) {
  const i = edgeIndex(board, k, r, c);
  if (i < 0) return -2;
  return board[k][i];
}

/** The four sides of a box. */
export function boxSides(r, c) {
  return [
    { k: 'h', r, c },
    { k: 'h', r: r + 1, c },
    { k: 'v', r, c },
    { k: 'v', r, c: c + 1 },
  ];
}

export function sidesDrawn(board, r, c) {
  let n = 0;
  for (const e of boxSides(r, c)) if (isDrawn(getEdge(board, e.k, e.r, e.c))) n++;
  return n;
}

/** Boxes that touch an edge (one or two), only those that are part of the board. */
export function adjacentBoxes(board, k, r, c) {
  const out = [];
  if (k === 'h') {
    if (r > 0) out.push([r - 1, c]);
    if (r < board.rows) out.push([r, c]);
  } else {
    if (c > 0) out.push([r, c - 1]);
    if (c < board.cols) out.push([r, c]);
  }
  return out.filter(([br, bc]) => board.boxes[br * board.cols + bc] >= -1);
}

export function freeEdges(board) {
  const out = [];
  for (let i = 0; i < board.h.length; i++) if (board.h[i] === -1) out.push({ k: 'h', r: Math.floor(i / board.cols), c: i % board.cols });
  const w = board.cols + 1;
  for (let i = 0; i < board.v.length; i++) if (board.v[i] === -1) out.push({ k: 'v', r: Math.floor(i / w), c: i % w });
  return out;
}

export function totalEdges(board) {
  return board.h.filter((x) => x !== -2).length + board.v.filter((x) => x !== -2).length;
}

function cloneState(state) {
  return {
    ...state,
    h: state.h.slice(),
    v: state.v.slice(),
    boxes: state.boxes.slice(),
    players: state.players.map((p) => ({ ...p, powers: { ...p.powers } })),
  };
}

function nextInOrder(state, player, steps = 1) {
  const pos = state.order.indexOf(player);
  return state.order[(pos + steps) % state.order.length];
}

/**
 * Validate and apply a move. Returns { ok, error?, state, claimed }.
 * Does not mutate the input state.
 */
export function applyMove(state, playerIndex, move, { auto = false } = {}) {
  const fail = (error) => ({ ok: false, error, state, claimed: [] });
  if (state.phase !== 'playing') return fail('The game is not running.');
  if (playerIndex !== state.turn) return fail("It's not your turn.");
  const { k, r, c } = move || {};
  const i = edgeIndex(state, k, r, c);
  if (i < 0 || state[k][i] === -2) return fail('That line is not on the board.');
  if (state[k][i] !== -1) return fail('That line is already taken.');

  const next = cloneState(state);
  next[k][i] = playerIndex;

  const claimed = [];
  let points = 0;
  let stars = 0;
  for (const [br, bc] of adjacentBoxes(next, k, r, c)) {
    const bi = br * next.cols + bc;
    if (next.boxes[bi] === -1 && sidesDrawn(next, br, bc) === 4) {
      next.boxes[bi] = playerIndex;
      claimed.push([br, bc]);
      points += next.values[bi];
      stars += next.stars[bi];
    }
  }
  const me = next.players[playerIndex];
  me.score += points;
  me.extraTurns += stars;
  next.lastMove = { k, r, c, player: playerIndex, claimed: claimed.length, points, stars, auto };
  // The last few lines, so people can see what happened while they looked away.
  next.recent = [...(state.recent || []), { k, r, c, player: playerIndex }].slice(-24);
  next.lastEvent = null;
  next.moveCount = (state.moveCount || 0) + 1;

  if (!next.boxes.includes(-1)) {
    next.phase = 'over';
  } else if (claimed.length === 0) {
    if (me.extraTurns > 0) {
      me.extraTurns--;
      next.lastEvent = { type: 'extra', player: playerIndex, id: (state.eventId || 0) + 1 };
    } else {
      const skip = next.skipNext;
      next.skipNext = false;
      if (skip && next.order.length > 2) {
        next.lastEvent = { type: 'skipped', player: playerIndex, skipped: nextInOrder(next, playerIndex, 1), id: (state.eventId || 0) + 1 };
        next.turn = nextInOrder(next, playerIndex, 2);
      } else {
        next.turn = nextInOrder(next, playerIndex, 1);
      }
    }
  }
  if (next.lastEvent) next.eventId = next.lastEvent.id;
  return { ok: true, state: next, claimed };
}

/** Use a power-up on your own turn: 'double' (draw two lines) or 'skip' (skip the next player). */
export function usePower(state, playerIndex, kind) {
  const fail = (error) => ({ ok: false, error, state });
  if (state.phase !== 'playing') return fail('The game is not running.');
  if (playerIndex !== state.turn) return fail("It's not your turn.");
  const p = state.players[playerIndex];
  if (!p.powers || !(p.powers[kind] > 0)) return fail("You don't have that power-up.");
  if (kind === 'skip' && state.skipNext) return fail('Already skipping the next player.');
  if (kind === 'skip' && state.order.length < 3) return fail('Skipping needs 3 or more players.');
  const next = cloneState(state);
  const me = next.players[playerIndex];
  me.powers[kind]--;
  if (kind === 'double') me.extraTurns++;
  else if (kind === 'skip') next.skipNext = true;
  else return fail('Unknown power-up.');
  next.lastEvent = { type: 'power', kind, player: playerIndex, id: (state.eventId || 0) + 1 };
  next.eventId = next.lastEvent.id;
  return { ok: true, state: next };
}

/** Pass the turn to the next player (used when someone has dropped out). */
export function skipTurn(state) {
  if (state.phase !== 'playing') return state;
  const next = cloneState(state);
  next.players[state.turn].extraTurns = 0;
  next.turn = nextInOrder(state, state.turn, 1);
  next.lastEvent = null;
  return next;
}

/** Team totals, or null when teams are off. */
export function teamScores(state) {
  if (!state.opts || !state.opts.teams) return null;
  return TEAMS.slice(0, state.opts.teams).map((t, i) => ({
    ...t,
    index: i,
    score: state.players.filter((p) => p.team === i).reduce((s, p) => s + p.score, 0),
    members: state.players.map((p, j) => ({ ...p, index: j })).filter((p) => p.team === i),
  }));
}

/**
 * Who won. Returns { teams: [winning teams] | null, players: [winning players with .index] }.
 * With teams, every member of a winning team counts as a winner.
 */
export function winners(state) {
  const teams = teamScores(state);
  if (teams) {
    const best = Math.max(...teams.map((t) => t.score));
    const win = teams.filter((t) => t.score === best);
    return { teams: win, players: win.flatMap((t) => t.members) };
  }
  const best = Math.max(...state.players.map((p) => p.score));
  return { teams: null, players: state.players.map((p, i) => ({ ...p, index: i })).filter((p) => p.score === best) };
}
