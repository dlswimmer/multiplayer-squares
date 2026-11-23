// Computer players.
//   easy   – usually grabs a box it can close, otherwise draws any line.
//   medium – always closes boxes, and avoids drawing the 3rd side of a box.
//   hard   – like medium, and when every line gives something away it picks
//            the line that gives away the fewest points. It also uses its
//            power-ups at good moments.
import { freeEdges, adjacentBoxes, sidesDrawn, boxSides, getEdge } from './game.js';

export const LEVELS = [
  { id: 'easy', label: 'Easy', icon: '🙂' },
  { id: 'medium', label: 'Medium', icon: '😎' },
  { id: 'hard', label: 'Hard', icon: '🤓' },
];
export const BOT_NAMES = ['Robo', 'Beep', 'Chip', 'Gizmo', 'Bolt', 'Pixel', 'Sprocket', 'Widget'];

const pick = (list, rand) => list[Math.floor(rand() * list.length)];

function completes(state, e) {
  return adjacentBoxes(state, e.k, e.r, e.c).some(([r, c]) => state.boxes[r * state.cols + c] === -1 && sidesDrawn(state, r, c) === 3);
}
function isSafe(state, e) {
  return adjacentBoxes(state, e.k, e.r, e.c).every(([r, c]) => sidesDrawn(state, r, c) < 2);
}
function boxValue(state, r, c) {
  const i = r * state.cols + c;
  return state.values[i] + state.stars[i] * 2;
}
/** Best completing line, preferring the most valuable boxes. */
function bestCompleting(state, list) {
  let best = null, bestV = -1;
  for (const e of list) {
    let v = 0;
    for (const [r, c] of adjacentBoxes(state, e.k, e.r, e.c)) {
      if (state.boxes[r * state.cols + c] === -1 && sidesDrawn(state, r, c) === 3) v += boxValue(state, r, c);
    }
    if (v > bestV) { bestV = v; best = e; }
  }
  return best;
}

/** How many points the next player could grab if we drew line e (follows the chain it opens). */
function giveaway(state, e) {
  const b = { rows: state.rows, cols: state.cols, h: state.h.slice(), v: state.v.slice(), boxes: state.boxes.slice() };
  const draw = (x) => { b[x.k][x.k === 'h' ? x.r * b.cols + x.c : x.r * (b.cols + 1) + x.c] = 0; };
  draw(e);
  let total = 0;
  const queue = [e];
  while (queue.length) {
    const x = queue.pop();
    for (const [r, c] of adjacentBoxes(b, x.k, x.r, x.c)) {
      const i = r * b.cols + c;
      if (b.boxes[i] !== -1) continue;
      const n = sidesDrawn(b, r, c);
      if (n < 3) continue;
      b.boxes[i] = 0;
      total += boxValue(state, r, c);
      if (n === 3) {
        const missing = boxSides(r, c).find((s) => getEdge(b, s.k, s.r, s.c) === -1);
        draw(missing);
        queue.push(missing);
      }
    }
  }
  return total;
}

/**
 * Decide what the computer does on its turn.
 * Returns { power: 'double'|'skip' } or { move: {k, r, c} }.
 */
export function chooseAction(state, level = 'medium', rand = Math.random) {
  const me = state.players[state.turn];
  const free = freeEdges(state);
  if (!free.length) return null;
  const closing = free.filter((e) => completes(state, e));

  if (level === 'easy') {
    if (closing.length && rand() < 0.6) return { move: pick(closing, rand) };
    return { move: pick(free, rand) };
  }

  if (closing.length) return { move: bestCompleting(state, closing) };

  const safe = free.filter((e) => isSafe(state, e));
  if (safe.length) {
    // Hard: with exactly two safe lines left, drawing both (double turn)
    // leaves the next player with nothing safe.
    if (level === 'hard' && safe.length === 2 && me.powers && me.powers.double > 0 && !me.extraTurns) {
      return { power: 'double' };
    }
    return { move: pick(safe, rand) };
  }
  if (level === 'medium') return { move: pick(free, rand) };

  // Hard: nothing safe left, so give away as little as possible.
  let best = [], bestCost = Infinity;
  for (const e of free) {
    const cost = giveaway(state, e);
    if (cost < bestCost) { bestCost = cost; best = [e]; }
    else if (cost === bestCost) best.push(e);
  }
  // Skipping the next player can keep a big gift away from them.
  if (bestCost >= 4 && me.powers && me.powers.skip > 0 && state.order.length > 2 && !state.skipNext && rand() < 0.5) return { power: 'skip' };
  return { move: pick(best, rand) };
}
