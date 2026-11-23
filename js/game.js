// Pure game rules. No DOM, no networking, so it can be tested in Node.
//
// Grid of `rows` x `cols` boxes, which means (rows+1) x (cols+1) dots.
// Horizontal edges: (rows+1) rows of `cols` edges  -> key "h:r:c"
// Vertical edges:   `rows` rows of (cols+1) edges   -> key "v:r:c"
// Edge/box values are the index of the player who drew/claimed it, or -1.

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

export const AVATARS = ['🦊', '🐼', '🐸', '🦁', '🐙', '🐢', '🦄', '🐝', '🐳', '🐯', '🐵', '🦖'];

export const MIN_SIZE = 2;
export const MAX_SIZE = 20;
export const MAX_PLAYERS = 8;

export function clampSize(n) {
  n = Math.round(Number(n));
  if (!Number.isFinite(n)) return 4;
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, n));
}

export function newBoard(rows, cols) {
  rows = clampSize(rows);
  cols = clampSize(cols);
  return {
    rows,
    cols,
    h: new Array((rows + 1) * cols).fill(-1),
    v: new Array(rows * (cols + 1)).fill(-1),
    boxes: new Array(rows * cols).fill(-1),
  };
}

/**
 * Create a full game state.
 * players: [{ id, name, color, avatar }]
 */
export function newGame(rows, cols, players, firstTurn = 0) {
  const board = newBoard(rows, cols);
  return {
    ...board,
    players: players.map((p) => ({ ...p, score: 0 })),
    turn: players.length ? firstTurn % players.length : 0,
    phase: 'playing',
    lastMove: null, // { k, r, c, player }
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
  if (i < 0) return undefined;
  return board[k][i];
}

function boxComplete(board, r, c) {
  return (
    getEdge(board, 'h', r, c) >= 0 &&
    getEdge(board, 'h', r + 1, c) >= 0 &&
    getEdge(board, 'v', r, c) >= 0 &&
    getEdge(board, 'v', r, c + 1) >= 0
  );
}

/** Boxes that touch an edge (one or two of them). */
export function adjacentBoxes(board, k, r, c) {
  const out = [];
  if (k === 'h') {
    if (r > 0) out.push([r - 1, c]);
    if (r < board.rows) out.push([r, c]);
  } else {
    if (c > 0) out.push([r, c - 1]);
    if (c < board.cols) out.push([r, c]);
  }
  return out;
}

export function totalEdges(board) {
  return board.h.length + board.v.length;
}

/**
 * Validate and apply a move. Returns { ok, error?, state, claimed }.
 * Does not mutate the input state.
 */
export function applyMove(state, playerIndex, move) {
  if (state.phase !== 'playing') return { ok: false, error: 'The game is not running.', state, claimed: [] };
  if (playerIndex !== state.turn) return { ok: false, error: "It's not your turn.", state, claimed: [] };
  const { k, r, c } = move || {};
  const i = edgeIndex(state, k, r, c);
  if (i < 0) return { ok: false, error: 'That line is not on the board.', state, claimed: [] };
  if (state[k][i] >= 0) return { ok: false, error: 'That line is already taken.', state, claimed: [] };

  const next = {
    ...state,
    h: state.h.slice(),
    v: state.v.slice(),
    boxes: state.boxes.slice(),
    players: state.players.map((p) => ({ ...p })),
  };
  next[k][i] = playerIndex;

  const claimed = [];
  for (const [br, bc] of adjacentBoxes(next, k, r, c)) {
    const bi = br * next.cols + bc;
    if (next.boxes[bi] < 0 && boxComplete(next, br, bc)) {
      next.boxes[bi] = playerIndex;
      claimed.push([br, bc]);
    }
  }
  next.players[playerIndex].score += claimed.length;
  next.lastMove = { k, r, c, player: playerIndex, claimed: claimed.length };
  next.moveCount = (state.moveCount || 0) + 1;

  if (next.boxes.every((b) => b >= 0)) {
    next.phase = 'over';
  } else if (claimed.length === 0) {
    next.turn = (playerIndex + 1) % next.players.length;
  }
  return { ok: true, state: next, claimed };
}

/** Pass the turn to the next player (used when someone has dropped out). */
export function skipTurn(state) {
  if (state.phase !== 'playing') return state;
  return { ...state, turn: (state.turn + 1) % state.players.length };
}

export function winners(state) {
  const best = Math.max(...state.players.map((p) => p.score));
  return state.players.map((p, i) => ({ ...p, index: i })).filter((p) => p.score === best);
}
