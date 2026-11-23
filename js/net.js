// Networking. Each device talks directly to the host's device over WebRTC
// (PeerJS). The free public PeerJS server is only used to introduce the
// devices to each other; no game data goes through it and no account is needed.
//
// For testing in one browser, add ?net=local to the URL. That swaps WebRTC
// for a BroadcastChannel between tabs of the same browser.

const PREFIX = 'sqgame-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, easy to read aloud

export function randomCode(len = 4) {
  let s = '';
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) s += CODE_CHARS[buf[i] % CODE_CHARS.length];
  return s;
}

export function normalizeCode(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 8);
}

const useLocal = new URLSearchParams(location.search).get('net') === 'local';

class Emitter {
  constructor() {
    this._h = {};
  }
  on(ev, fn) {
    (this._h[ev] ||= []).push(fn);
    return this;
  }
  emit(ev, ...args) {
    for (const fn of this._h[ev] || []) {
      try {
        fn(...args);
      } catch (e) {
        console.error(e);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Host: listens for players. Emits 'ready', 'connection' (Conn), 'error' (msg)
// ---------------------------------------------------------------------------
export function createHost(code) {
  return useLocal ? localHost(code) : peerHost(code);
}

// Guest: one connection to the host. Emits 'open', 'data', 'close', 'error'.
export function joinHost(code) {
  return useLocal ? localJoin(code) : peerJoin(code);
}

function peerHost(code) {
  const host = new Emitter();
  let peer;
  let attempts = 0;
  let destroyed = false;

  const start = () => {
    peer = new Peer(PREFIX + code, { debug: 1 });
    peer.on('open', () => {
      attempts = 0;
      host.emit('ready');
    });
    peer.on('connection', (dc) => {
      const conn = wrapDataConnection(dc);
      host.emit('connection', conn);
    });
    peer.on('disconnected', () => {
      // Lost the signalling server; existing games keep working, but try to
      // come back so new players can still join.
      if (!destroyed && !peer.destroyed) setTimeout(() => !destroyed && peer.reconnect(), 2000);
    });
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id' && attempts < 10 && !destroyed) {
        // Happens right after the host reloads the page: the old connection
        // takes a few seconds to time out on the server.
        attempts++;
        peer.destroy();
        host.emit('status', 'Getting the room back…');
        setTimeout(start, 3000);
        return;
      }
      if (err.type === 'peer-unavailable') return; // not relevant for host
      host.emit('error', describeError(err));
    });
  };
  start();
  host.close = () => {
    destroyed = true;
    peer && peer.destroy();
  };
  return host;
}

function peerJoin(code) {
  const g = new Emitter();
  const peer = new Peer({ debug: 1 });
  let conn = null;
  peer.on('open', () => {
    const dc = peer.connect(PREFIX + code, { reliable: true });
    conn = wrapDataConnection(dc);
    conn.on('open', () => g.emit('open'));
    conn.on('data', (d) => g.emit('data', d));
    conn.on('close', () => g.emit('close'));
  });
  peer.on('error', (err) => {
    if (err.type === 'peer-unavailable') g.emit('error', 'notfound');
    else g.emit('error', describeError(err));
  });
  g.send = (msg) => conn && conn.send(msg);
  g.close = () => peer.destroy();
  return g;
}

function wrapDataConnection(dc) {
  const c = new Emitter();
  let open = false;
  dc.on('open', () => {
    open = true;
    c.emit('open');
  });
  dc.on('data', (d) => c.emit('data', d));
  const closed = () => {
    if (open) {
      open = false;
      c.emit('close');
    }
  };
  dc.on('close', closed);
  dc.on('error', closed);
  // WebRTC does not always fire 'close' when a phone goes to sleep, so watch
  // the ICE state as well.
  const pc = dc.peerConnection;
  if (pc) {
    pc.addEventListener('iceconnectionstatechange', () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.iceConnectionState)) {
        setTimeout(() => {
          if (['failed', 'closed', 'disconnected'].includes(pc.iceConnectionState)) closed();
        }, 4000);
      }
    });
  }
  c.send = (msg) => {
    if (open) dc.send(msg);
  };
  c.close = () => dc.close();
  return c;
}

function describeError(err) {
  switch (err && err.type) {
    case 'browser-incompatible':
      return 'This browser cannot play online games. Try Chrome, Safari or Firefox.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return 'Could not reach the game server. Check the internet connection and try again.';
    default:
      return (err && err.message) || 'Something went wrong with the connection.';
  }
}

// ---------------------------------------------------------------------------
// Local (same-browser) transport, for testing.
// ---------------------------------------------------------------------------
function localHost(code) {
  const host = new Emitter();
  const bc = new BroadcastChannel(PREFIX + code);
  const conns = new Map();
  bc.onmessage = ({ data: m }) => {
    if (m.to !== 'host') return;
    if (m.type === 'connect') {
      const c = new Emitter();
      c.send = (msg) => bc.postMessage({ to: m.from, type: 'data', msg });
      c.close = () => bc.postMessage({ to: m.from, type: 'close' });
      conns.set(m.from, c);
      host.emit('connection', c);
      bc.postMessage({ to: m.from, type: 'accept' });
      setTimeout(() => c.emit('open'), 0);
    } else if (m.type === 'data') {
      conns.get(m.from)?.emit('data', m.msg);
    } else if (m.type === 'close') {
      conns.get(m.from)?.emit('close');
      conns.delete(m.from);
    }
  };
  setTimeout(() => host.emit('ready'), 0);
  host.close = () => {
    for (const id of conns.keys()) bc.postMessage({ to: id, type: 'close' });
    bc.close();
  };
  addEventListener('pagehide', () => host.close());
  return host;
}

function localJoin(code) {
  const g = new Emitter();
  const me = 'g' + Math.random().toString(36).slice(2);
  const bc = new BroadcastChannel(PREFIX + code);
  let accepted = false;
  bc.onmessage = ({ data: m }) => {
    if (m.to !== me) return;
    if (m.type === 'accept') {
      accepted = true;
      g.emit('open');
    } else if (m.type === 'data') g.emit('data', m.msg);
    else if (m.type === 'close') g.emit('close');
  };
  bc.postMessage({ to: 'host', from: me, type: 'connect' });
  setTimeout(() => !accepted && g.emit('error', 'notfound'), 3000);
  g.send = (msg) => bc.postMessage({ to: 'host', from: me, type: 'data', msg });
  g.close = () => {
    bc.postMessage({ to: 'host', from: me, type: 'close' });
    bc.close();
  };
  addEventListener('pagehide', () => g.close());
  return g;
}
