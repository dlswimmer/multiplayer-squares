import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newGame, applyMove, usePower, skipTurn, winners, teamScores, edgeIndex, totalEdges, clampSize,
  freeEdges, shapeMask, sidesDrawn, PRESET, BLOCKED,
} from '../js/game.js';
import { chooseAction } from '../js/ai.js';

const P = (n, extra = () => ({})) => Array.from({ length: n }, (_, i) => ({ name: 'P' + i, color: '#000', avatar: 'x', ...extra(i) }));
const G = (rows, cols, n, opts = {}, more = {}) => newGame({ rows, cols, players: P(n, more.extra), opts, seed: more.seed || 42, firstTurn: more.firstTurn || 0 });

/** Play until the end, using `pick` to choose each move. */
function playOut(g, pick = (s) => freeEdges(s)[0]) {
  for (let guard = 0; guard < 5000 && g.phase === 'playing'; guard++) {
    const res = applyMove(g, g.turn, pick(g));
    assert.ok(res.ok, res.error);
    g = res.state;
  }
  return g;
}

test('board has the right number of lines', () => {
  const g = G(3, 5, 2);
  assert.equal(g.h.length, 4 * 5);
  assert.equal(g.v.length, 3 * 6);
  assert.equal(totalEdges(g), 38);
  assert.equal(g.boxes.length, 15);
});

test('sizes are clamped', () => {
  assert.equal(clampSize(1), 2);
  assert.equal(clampSize(99), 20);
  assert.equal(clampSize('abc'), 4);
});

test('turns rotate through all players when no box is made', () => {
  let g = G(3, 3, 3);
  for (const [i, m] of [[0, { k: 'h', r: 0, c: 0 }], [1, { k: 'h', r: 0, c: 1 }], [2, { k: 'h', r: 0, c: 2 }]]) {
    const res = applyMove(g, i, m);
    assert.ok(res.ok, res.error);
    g = res.state;
  }
  assert.equal(g.turn, 0);
});

test('rejects wrong turn, taken line and off-board line', () => {
  let g = G(2, 2, 2);
  assert.equal(applyMove(g, 1, { k: 'h', r: 0, c: 0 }).ok, false);
  g = applyMove(g, 0, { k: 'h', r: 0, c: 0 }).state;
  assert.equal(applyMove(g, 1, { k: 'h', r: 0, c: 0 }).ok, false);
  assert.equal(applyMove(g, 1, { k: 'h', r: 3, c: 0 }).ok, false);
  assert.equal(applyMove(g, 1, { k: 'v', r: 0, c: 3 }).ok, false);
  assert.equal(applyMove(g, 1, { k: 'x', r: 0, c: 0 }).ok, false);
  assert.equal(applyMove(g, 1, { k: 'h', r: 0.5, c: 0 }).ok, false);
});

test('completing a box scores and keeps the turn; double box scores 2', () => {
  let g = G(2, 2, 2);
  const play = (m) => {
    const res = applyMove(g, g.turn, m);
    assert.ok(res.ok, res.error);
    g = res.state;
    return res;
  };
  play({ k: 'h', r: 0, c: 0 });
  play({ k: 'h', r: 1, c: 0 });
  play({ k: 'v', r: 0, c: 0 });
  play({ k: 'h', r: 0, c: 1 });
  play({ k: 'h', r: 1, c: 1 });
  play({ k: 'v', r: 0, c: 2 });
  const before = g.turn;
  const res = play({ k: 'v', r: 0, c: 1 });
  assert.equal(res.claimed.length, 2);
  assert.equal(g.players[before].score, 2);
  assert.equal(g.turn, before);
});

test('game ends when every box is taken, and does not mutate input', () => {
  const first = G(2, 2, 4);
  const g = playOut(first);
  assert.equal(first.h.every((x) => x === -1), true);
  assert.equal(g.phase, 'over');
  assert.equal(g.players.reduce((s, p) => s + p.score, 0), 4);
  assert.ok(winners(g).players.length >= 1);
});

test('shapes make holes but keep at least 2 boxes', () => {
  for (const shape of ['plus', 'heart', 'holes', 'random']) {
    for (const [r, c] of [[2, 2], [3, 3], [6, 6], [9, 7], [20, 20]]) {
      const m = shapeMask(r, c, shape, Math.random);
      assert.ok(m.filter(Boolean).length >= 2, `${shape} ${r}x${c}`);
    }
  }
  assert.ok(shapeMask(6, 6, 'heart').includes(0));
  assert.ok(shapeMask(5, 5, 'plus').includes(0));
  assert.ok(shapeMask(6, 6, 'holes').includes(0));
});

test('games on every shape, with blocked squares and preset lines, play to the end', () => {
  for (const shape of ['square', 'plus', 'heart', 'holes', 'random']) {
    for (const blocked of [0, 1, 2]) {
      for (const presets of [0, 1, 3]) {
        const g0 = G(7, 6, 3, { shape, blocked, presets, bonus: true }, { seed: 7 + blocked * 10 + presets });
        const holes = g0.boxes.filter((b) => b === -2).length;
        if (blocked) assert.ok(g0.boxes.includes(BLOCKED), `blocked ${shape}`);
        if (presets) {
          assert.ok(g0.h.includes(PRESET) || g0.v.includes(PRESET));
          // Pre-set lines never leave a box with 3 sides.
          for (let r = 0; r < g0.rows; r++) for (let c = 0; c < g0.cols; c++) if (g0.boxes[r * g0.cols + c] === -1) assert.ok(sidesDrawn(g0, r, c) <= 2);
        }
        const g = playOut(g0, (s) => freeEdges(s)[Math.floor(Math.random() * freeEdges(s).length)]);
        assert.equal(g.phase, 'over');
        assert.equal(g.boxes.filter((b) => b === -2).length, holes);
        const total = g.boxes.reduce((s, b, i) => s + (b >= 0 ? g.values[i] : 0), 0);
        assert.equal(g.players.reduce((s, p) => s + p.score, 0), total);
      }
    }
  }
});

test('bonus squares are worth their value and stars give an extra turn', () => {
  let g = G(2, 2, 2, { bonus: true });
  g = { ...g, values: [3, 1, 1, 1], stars: [0, 1, 0, 0] };
  // Close box 0 (worth 3)
  for (const m of [{ k: 'h', r: 0, c: 0 }, { k: 'h', r: 1, c: 0 }, { k: 'v', r: 0, c: 0 }]) g = applyMove(g, g.turn, m).state;
  const p = g.turn;
  g = applyMove(g, p, { k: 'v', r: 0, c: 1 }).state;
  assert.equal(g.players[p].score, 3);
  // Close box 1 (star) as the same player
  g = applyMove(g, p, { k: 'h', r: 0, c: 1 }).state;
  const q = g.turn;
  g = applyMove(g, q, { k: 'h', r: 1, c: 1 }).state;
  const r = g.turn;
  g = applyMove(g, r, { k: 'v', r: 0, c: 2 }).state; // closes the star box
  assert.equal(g.players[r].extraTurns, 1);
  // Next line that closes nothing uses up the extra turn instead of passing
  g = applyMove(g, r, { k: 'h', r: 2, c: 0 }).state;
  assert.equal(g.turn, r);
  assert.equal(g.players[r].extraTurns, 0);
  assert.equal(g.lastEvent.type, 'extra');
});

test('power-ups: double gives two lines, skip skips the next player', () => {
  let g = G(4, 4, 3, { powerups: true });
  let res = usePower(g, 0, 'double');
  assert.ok(res.ok);
  g = applyMove(res.state, 0, { k: 'h', r: 0, c: 0 }).state;
  assert.equal(g.turn, 0);
  g = applyMove(g, 0, { k: 'h', r: 0, c: 1 }).state;
  assert.equal(g.turn, 1);
  assert.equal(usePower(g, 1, 'double').ok, true);
  assert.equal(usePower(g, 0, 'skip').ok, false); // not their turn
  res = usePower(g, 1, 'skip');
  assert.ok(res.ok);
  g = applyMove(res.state, 1, { k: 'h', r: 0, c: 2 }).state;
  assert.equal(g.turn, 0); // player 2 was skipped
  assert.equal(g.lastEvent.type, 'skipped');
  assert.equal(usePower(g, 1, 'skip').ok, false); // used up (and not their turn)
  assert.equal(usePower(G(3, 3, 2, { powerups: true }), 0, 'skip').ok, false); // needs 3 players
  assert.equal(usePower(G(3, 3, 2), 0, 'double').ok, false); // power-ups off
});

test('teams alternate turns and share points', () => {
  const g0 = G(3, 3, 4, { teams: 2 }, { extra: (i) => ({ team: i < 2 ? 0 : 1 }) });
  assert.deepEqual(g0.order, [0, 2, 1, 3]);
  assert.equal(g0.players[0].color, g0.players[1].color);
  const g = playOut(g0);
  const t = teamScores(g);
  assert.equal(t[0].score + t[1].score, 9);
  const w = winners(g);
  assert.ok(w.teams.length >= 1);
  assert.ok(w.players.every((p) => w.teams.some((tt) => tt.index === p.team)));
});

test('skipTurn moves to the next player', () => {
  const g = G(2, 2, 3);
  assert.equal(skipTurn(g).turn, 1);
  assert.equal(edgeIndex(g, 'v', 1, 2), 5);
});

test('computer players always make legal moves and medium beats easy', () => {
  let mediumWins = 0;
  for (let round = 0; round < 20; round++) {
    let g = G(4, 4, 2, { powerups: true, bonus: true }, { seed: round + 1, firstTurn: round });
    const levels = ['easy', 'medium'];
    for (let guard = 0; guard < 500 && g.phase === 'playing'; guard++) {
      const a = chooseAction(g, levels[g.turn]);
      const res = a.power ? usePower(g, g.turn, a.power) : applyMove(g, g.turn, a.move);
      assert.ok(res.ok, res.error);
      g = res.state;
    }
    assert.equal(g.phase, 'over');
    if (g.players[1].score > g.players[0].score) mediumWins++;
  }
  assert.ok(mediumWins >= 12, `medium won ${mediumWins}/20`);
});

test('hard computer gives away little and finishes big boards quickly', () => {
  let g = G(10, 10, 3, { shape: 'holes', blocked: 1, presets: 2, powerups: true }, { seed: 3 });
  const t0 = Date.now();
  for (let guard = 0; guard < 2000 && g.phase === 'playing'; guard++) {
    const a = chooseAction(g, 'hard');
    const res = a.power ? usePower(g, g.turn, a.power) : applyMove(g, g.turn, a.move);
    assert.ok(res.ok, res.error);
    g = res.state;
  }
  assert.equal(g.phase, 'over');
  assert.ok(Date.now() - t0 < 8000, 'took ' + (Date.now() - t0) + 'ms');
});

test('recent keeps the last lines in order', () => {
  let g = G(4, 4, 3);
  for (const m of [{ k: 'h', r: 0, c: 0 }, { k: 'h', r: 0, c: 1 }, { k: 'h', r: 0, c: 2 }]) g = applyMove(g, g.turn, m).state;
  assert.deepEqual(g.recent.map((m) => [m.player, m.c]), [[0, 0], [1, 1], [2, 2]]);
});
