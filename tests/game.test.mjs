import test from 'node:test';
import assert from 'node:assert/strict';
import { newGame, applyMove, skipTurn, winners, edgeIndex, totalEdges, clampSize } from '../js/game.js';

const P = (n) => Array.from({ length: n }, (_, i) => ({ name: 'P' + i, color: '#000', avatar: 'x' }));

test('board has the right number of lines', () => {
  const g = newGame(3, 5, P(2));
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
  let g = newGame(3, 3, P(3));
  for (const [i, m] of [[0, { k: 'h', r: 0, c: 0 }], [1, { k: 'h', r: 0, c: 1 }], [2, { k: 'h', r: 0, c: 2 }]]) {
    const res = applyMove(g, i, m);
    assert.ok(res.ok, res.error);
    g = res.state;
  }
  assert.equal(g.turn, 0);
});

test('rejects wrong turn, taken line and off-board line', () => {
  let g = newGame(2, 2, P(2));
  assert.equal(applyMove(g, 1, { k: 'h', r: 0, c: 0 }).ok, false);
  g = applyMove(g, 0, { k: 'h', r: 0, c: 0 }).state;
  assert.equal(applyMove(g, 1, { k: 'h', r: 0, c: 0 }).ok, false);
  assert.equal(applyMove(g, 1, { k: 'h', r: 3, c: 0 }).ok, false);
  assert.equal(applyMove(g, 1, { k: 'v', r: 0, c: 3 }).ok, false);
  assert.equal(applyMove(g, 1, { k: 'x', r: 0, c: 0 }).ok, false);
  assert.equal(applyMove(g, 1, { k: 'h', r: 0.5, c: 0 }).ok, false);
});

test('completing a box scores and keeps the turn; double box scores 2', () => {
  // 1 x 2 board: boxes side by side, shared middle vertical line.
  let g = newGame(2, 2, P(2));
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
  const res = play({ k: 'v', r: 0, c: 1 }); // closes two boxes at once
  assert.equal(res.claimed.length, 2);
  assert.equal(g.players[before].score, 2);
  assert.equal(g.turn, before);
  assert.equal(g.lastMove.claimed, 2);
});

test('game ends when every box is taken, and does not mutate input', () => {
  let g = newGame(2, 2, P(4));
  const all = [];
  for (let r = 0; r <= 2; r++) for (let c = 0; c < 2; c++) all.push({ k: 'h', r, c });
  for (let r = 0; r < 2; r++) for (let c = 0; c <= 2; c++) all.push({ k: 'v', r, c });
  const first = g;
  for (const m of all) g = applyMove(g, g.turn, m).state;
  assert.equal(first.h.every((x) => x === -1), true);
  assert.equal(g.phase, 'over');
  assert.equal(g.players.reduce((s, p) => s + p.score, 0), 4);
  assert.ok(winners(g).length >= 1);
  assert.equal(applyMove(g, g.turn, all[0]).ok, false);
});

test('skipTurn moves to the next player', () => {
  const g = newGame(2, 2, P(3));
  assert.equal(skipTurn(g).turn, 1);
  assert.equal(edgeIndex(g, 'v', 1, 2), 5);
});
