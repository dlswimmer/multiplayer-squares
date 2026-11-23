// Draws the board as SVG and handles tapping, clicking, pinch-zoom and panning.

const S = 60; // distance between dots, in board units
const M = 26; // margin around the dots
const TAP_SLOP = 9; // pixels a finger can wiggle and still count as a tap
const NS = 'http://www.w3.org/2000/svg';

export function createBoard(container, opts) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'board-svg');
  const g = document.createElementNS(NS, 'g');
  svg.appendChild(g);
  container.appendChild(svg);

  let state = null;
  let myIndex = -1;
  let k = 1, tx = 0, ty = 0; // zoom and pan, in screen pixels
  let userZoomed = false;
  let pending = null; // edge chosen by first tap (tap-twice mode)
  let hover = null; // edge under the mouse
  let lastSig = '';

  const boardW = () => (state ? state.cols * S + 2 * M : 100);
  const boardH = () => (state ? state.rows * S + 2 * M : 100);
  const view = () => container.getBoundingClientRect();

  function fitScale() {
    const r = view();
    // Don't blow tiny boards up to giant size on big screens.
    return Math.min(r.width / boardW(), r.height / boardH(), 2.3);
  }
  function limits() {
    const f = fitScale();
    // Let people zoom until boxes are ~150px wide, or at least 4x the fit.
    return [f, Math.max(f * 4, 150 / S)];
  }
  function clampView() {
    const r = view();
    const [lo, hi] = limits();
    k = Math.min(hi, Math.max(lo, k));
    const bw = boardW() * k, bh = boardH() * k;
    tx = bw <= r.width ? (r.width - bw) / 2 : Math.min(0, Math.max(r.width - bw, tx));
    ty = bh <= r.height ? (r.height - bh) / 2 : Math.min(0, Math.max(r.height - bh, ty));
    g.setAttribute('transform', `translate(${tx},${ty}) scale(${k})`);
    opts.onZoom && opts.onZoom(k / lo);
  }
  function fit() {
    userZoomed = false;
    k = fitScale();
    clampView();
  }
  function zoomAt(factor, sx, sy) {
    const px = (sx - tx) / k, py = (sy - ty) / k;
    k *= factor;
    const [lo, hi] = limits();
    k = Math.min(hi, Math.max(lo, k));
    tx = sx - px * k;
    ty = sy - py * k;
    userZoomed = true;
    clampView();
  }
  function zoomBy(factor) {
    const r = view();
    zoomAt(factor, r.width / 2, r.height / 2);
  }

  new ResizeObserver(() => (userZoomed ? clampView() : fit())).observe(container);

  // ---- picking the nearest line to a point --------------------------------
  function toBoard(clientX, clientY) {
    const r = view();
    return [(clientX - r.left - tx) / k, (clientY - r.top - ty) / k];
  }
  function edgeAt(clientX, clientY) {
    if (!state) return null;
    const [x, y] = toBoard(clientX, clientY);
    const gx = (x - M) / S, gy = (y - M) / S;
    let best = null, bestD = 0.4; // must be within 40% of a box of the line
    const hr = Math.round(gy), hc = Math.floor(gx);
    if (hr >= 0 && hr <= state.rows && hc >= 0 && hc < state.cols) {
      const d = Math.abs(gy - hr);
      if (d < bestD && state.h[hr * state.cols + hc] !== -2) { best = { k: 'h', r: hr, c: hc }; bestD = d; }
    }
    const vc = Math.round(gx), vr = Math.floor(gy);
    if (vc >= 0 && vc <= state.cols && vr >= 0 && vr < state.rows) {
      const d = Math.abs(gx - vc);
      if (d < bestD && state.v[vr * (state.cols + 1) + vc] !== -2) { best = { k: 'v', r: vr, c: vc }; bestD = d; }
    }
    return best;
  }
  const val = (e) => state[e.k][e.k === 'h' ? e.r * state.cols + e.c : e.r * (state.cols + 1) + e.c];
  const free = (e) => e && val(e) === -1;
  const same = (a, b) => a && b && a.k === b.k && a.r === b.r && a.c === b.c;
  const canPlay = () => state && state.phase === 'playing' && opts.canPlay();

  function tap(clientX, clientY, isTouch) {
    if (!canPlay()) return;
    const e = edgeAt(clientX, clientY);
    if (!free(e)) {
      if (pending) { pending = null; draw(true); }
      return;
    }
    if (isTouch && opts.confirmTaps() && !same(e, pending)) {
      pending = e;
      draw(true);
      opts.onPending && opts.onPending(true);
      return;
    }
    pending = null;
    hover = null;
    opts.onPending && opts.onPending(false);
    opts.onPick(e);
  }

  // ---- pointer gestures ----------------------------------------------------
  const pts = new Map();
  let start = null; // single-finger pan start
  let pinch = null;
  let multi = false;

  svg.addEventListener('pointerdown', (ev) => {
    svg.setPointerCapture(ev.pointerId);
    pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pts.size === 1) {
      multi = false;
      start = { x: ev.clientX, y: ev.clientY, tx, ty, moved: false };
    } else if (pts.size === 2) {
      multi = true;
      const [a, b] = [...pts.values()];
      const r = view();
      pinch = {
        d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mx: (a.x + b.x) / 2 - r.left,
        my: (a.y + b.y) / 2 - r.top,
        k, tx, ty,
      };
    }
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!pts.has(ev.pointerId)) {
      if (ev.pointerType === 'mouse') {
        const e = canPlay() ? edgeAt(ev.clientX, ev.clientY) : null;
        const h = free(e) ? e : null;
        if (!same(h, hover)) { hover = h; draw(true); }
      }
      return;
    }
    pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pts.size >= 2 && pinch) {
      const [a, b] = [...pts.values()];
      const r = view();
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
      const px = (pinch.mx - pinch.tx) / pinch.k, py = (pinch.my - pinch.ty) / pinch.k;
      const [lo, hi] = limits();
      k = Math.min(hi, Math.max(lo, pinch.k * (d / pinch.d)));
      tx = mx - px * k;
      ty = my - py * k;
      userZoomed = true;
      clampView();
    } else if (pts.size === 1 && start && !multi) {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) > TAP_SLOP) start.moved = true;
      if (start.moved) {
        tx = start.tx + dx;
        ty = start.ty + dy;
        clampView();
      }
    }
  });
  const end = (ev) => {
    if (!pts.has(ev.pointerId)) return;
    pts.delete(ev.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 0) {
      if (ev.type === 'pointerup' && start && !start.moved && !multi) {
        tap(ev.clientX, ev.clientY, ev.pointerType !== 'mouse');
      }
      start = null;
    } else if (pts.size === 1) {
      // One finger lifted after a pinch: carry on panning with the other.
      const [p] = [...pts.values()];
      start = { x: p.x, y: p.y, tx, ty, moved: true };
    }
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('pointerleave', (ev) => {
    if (ev.pointerType === 'mouse' && hover) { hover = null; draw(true); }
  });
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const r = view();
    zoomAt(Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015)), ev.clientX - r.left, ev.clientY - r.top);
  }, { passive: false });
  svg.addEventListener('dblclick', (ev) => ev.preventDefault());

  // ---- drawing -------------------------------------------------------------
  function line(e, cls, color) {
    const x1 = M + e.c * S, y1 = M + e.r * S;
    const x2 = e.k === 'h' ? x1 + S : x1, y2 = e.k === 'v' ? y1 + S : y1;
    return `<line class="${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"${color ? ` stroke="${color}"` : ''}/>`;
  }

  function draw(overlayOnly) {
    if (!state) return;
    if (!overlayOnly || !g.querySelector('.overlay')) g.innerHTML = drawBoard();
    drawOverlay();
  }

  function drawBoard() {
    const { rows, cols, players } = state;
    const values = state.values || [];
    const stars = state.stars || [];
    let out = '';
    // Boxes: claimed ones get the owner's color and emoji, bonus ones a badge
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const o = state.boxes[i];
        if (o === -2) continue;
        const x = M + c * S, y = M + r * S, cx = x + S / 2, cy = y + S / 2;
        if (o === -4) {
          // Blocked square: a rock nobody can claim
          out += `<rect class="blocked" x="${x + 3}" y="${y + 3}" width="${S - 6}" height="${S - 6}" rx="8"/>` +
            `<text x="${cx}" y="${cy + 2}" font-size="${S * 0.42}">🪨</text>`;
          continue;
        }
        const badge = stars[i] ? '⭐' : values[i] > 1 ? '×' + values[i] : '';
        if (o === -1) {
          if (badge) {
            out += `<rect class="bonus-bg${stars[i] ? ' star' : ''}" x="${x + 4}" y="${y + 4}" width="${S - 8}" height="${S - 8}" rx="8"/>` +
              `<text class="bonus" x="${cx}" y="${cy + 1}" font-size="${stars[i] ? S * 0.42 : S * 0.36}">${badge}</text>`;
          }
          continue;
        }
        const p = players[o];
        const isNew = state.lastMove && state.lastMove.claimed && isAdjacent(state.lastMove, r, c);
        out += `<g class="box${isNew ? ' fresh' : ''}">` +
          `<rect x="${x + 3}" y="${y + 3}" width="${S - 6}" height="${S - 6}" rx="8" fill="${p.color}" fill-opacity="0.28"/>` +
          `<text x="${cx}" y="${cy + 2}" font-size="${S * 0.5}">${p.avatar || ''}</text>` +
          (badge ? `<text class="badge" x="${x + S - 14}" y="${y + 14}" font-size="${S * 0.2}">${badge}</text>` : '') +
          `</g>`;
      }
    }
    // Lines, and which dots are used
    const dots = new Uint8Array((rows + 1) * (cols + 1));
    for (const kind of ['h', 'v']) {
      const w = kind === 'h' ? cols : cols + 1;
      const n = kind === 'h' ? rows + 1 : rows;
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < w; c++) {
          const o = state[kind][r * w + c];
          if (o === -2) continue;
          dots[r * (cols + 1) + c] = 1;
          dots[(kind === 'h' ? r : r + 1) * (cols + 1) + (kind === 'h' ? c + 1 : c)] = 1;
          const e = { k: kind, r, c };
          out += o === -1 ? line(e, 'slot') : o === -3 ? line(e, 'edge preset') : line(e, 'edge', players[o].color);
        }
      }
    }
    const lm = state.lastMove;
    if (lm) out += line(lm, 'edge last', players[lm.player].color);
    for (let r = 0; r <= rows; r++)
      for (let c = 0; c <= cols; c++) if (dots[r * (cols + 1) + c]) out += `<circle class="dot" cx="${M + c * S}" cy="${M + r * S}" r="6"/>`;
    out += '<g class="overlay"></g>';
    return out;
  }

  // Hover / pending highlight, drawn on top without redrawing the board
  function drawOverlay() {
    const ov = g.querySelector('.overlay');
    let o = '';
    const color = opts.myColor();
    if (pending && free(pending) && canPlay()) o += line(pending, 'pending', color);
    else if (pending) pending = null;
    if (hover && free(hover) && canPlay() && !same(hover, pending)) o += line(hover, 'hover', color);
    ov.innerHTML = o;
  }

  function isAdjacent(m, r, c) {
    if (m.k === 'h') return c === m.c && (r === m.r || r === m.r - 1);
    return r === m.r && (c === m.c || c === m.c - 1);
  }

  return {
    render(s) {
      const sig = s.rows + 'x' + s.cols;
      const resized = sig !== lastSig;
      state = s;
      lastSig = sig;
      if (pending && !free(pending)) pending = null;
      if (!canPlay()) { pending = null; hover = null; }
      draw(false);
      if (resized) fit();
    },
    fit,
    zoomIn: () => zoomBy(1.4),
    zoomOut: () => zoomBy(1 / 1.4),
    clearPending() { pending = null; draw(true); },
  };
}
