/*
 * Métro Duel : liaison temps réel par le serveur WebSocket du dépôt (server.js).
 * Active seulement avec transport: "ws" dans config.js ; sinon c'est p2p.js qui relie les joueurs.
 *
 * Ouvre une WebSocket vers le serveur et expose des « salons » : chacun y publie son état
 * (presence) et reçoit celui des autres (peers / onPeers). La connexion se rétablit toute
 * seule ; au retour, les salons sont rejoints à nouveau et l'état republié.
 */
(() => {
'use strict';
const cfg = window.METRO_CONFIG || {};
if (cfg.transport !== 'ws') return;
const LOBBY = 'lobby';
const url = () => cfg.wsUrl || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');

const live = { ws: null, open: false, id: null, rooms: new Map(), tries: 0, pingTimer: 0, firstOpen: null, resolveFirst: null };

function send(msg) { if (live.open && live.ws && live.ws.readyState === 1) live.ws.send(JSON.stringify(msg)); }

function makeRoom(name) {
  const R = { name, mine: {}, myAt: Date.now(), others: new Map(), handlers: new Set(), connHandlers: new Set(), snap: Object.freeze([]), queued: false, pending: null, gone: false };
  const rebuild = () => {
    R.snap = Object.freeze([
      Object.freeze({ peer: live.id || 'moi', by: null, isMe: true, sameTab: true, kind: 'viewer', guest: false, presence: Object.freeze(Object.assign({}, R.mine)), updatedAt: R.myAt }),
      ...R.others.values(),
    ]);
  };
  // regroupe les changements d'un même tour de boucle en un seul appel
  R.fire = () => {
    rebuild();
    if (R.queued) return;
    R.queued = true;
    Promise.resolve().then(() => {
      R.queued = false;
      if (R.gone) return;
      const change = { peers: R.snap, joined: [], left: [], updated: [] };
      for (const h of [...R.handlers]) { try { h(change); } catch (e) { console.error(e); } }
    });
  };
  R.setPeer = (peer, p) => {
    R.others.set(peer, Object.freeze({ peer, by: null, isMe: false, sameTab: false, kind: 'viewer', guest: false, presence: Object.freeze(p || {}), updatedAt: Date.now() }));
  };
  R.api = {
    name,
    presence(patch) {
      for (const k of Object.keys(patch || {})) { if (patch[k] === null || patch[k] === undefined) delete R.mine[k]; else R.mine[k] = patch[k]; }
      R.myAt = Date.now();
      send({ t: 'pres', room: name, p: Object.keys(R.mine).length ? R.mine : null });
      R.fire();
      return Promise.resolve();
    },
    peers: () => R.snap,
    onPeers(handler) { R.handlers.add(handler); R.fire(); return () => { R.handlers.delete(handler); }; },
    connected: () => live.open,
    onConnection(handler) { R.connHandlers.add(handler); Promise.resolve().then(() => handler(live.open)); return () => { R.connHandlers.delete(handler); }; },
    leave() {
      if (name === LOBBY || R.gone) return Promise.resolve();
      R.gone = true; R.handlers.clear(); R.connHandlers.clear();
      live.rooms.delete(name);
      send({ t: 'leave', room: name });
      return Promise.resolve();
    },
  };
  rebuild();
  return R;
}

const lobby = makeRoom(LOBBY);
live.rooms.set(LOBBY, lobby);
lobby.api.join = name => new Promise((resolve, reject) => {
  const existing = live.rooms.get(name);
  if (existing) return resolve(existing.api);
  const R = makeRoom(name);
  live.rooms.set(name, R);
  const timer = setTimeout(() => { if (R.pending) { R.pending = null; R.gone = true; live.rooms.delete(name); reject(Object.assign(new Error('pas de réponse du serveur'), { code: 'upstream_error' })); } }, 10000);
  R.pending = {
    ok: () => { clearTimeout(timer); R.pending = null; resolve(R.api); },
    fail: code => { clearTimeout(timer); R.pending = null; R.gone = true; live.rooms.delete(name); reject(Object.assign(new Error(code), { code })); },
  };
  send({ t: 'join', room: name });
});

function notifyConnection() {
  for (const R of live.rooms.values()) for (const h of [...R.connHandlers]) { try { h(live.open); } catch (e) { console.error(e); } }
}
function onMessage(ev) {
  let m;
  try { m = JSON.parse(ev.data); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  live.lastSeen = Date.now();
  if (m.t === 'hello') {
    live.id = String(m.peer); live.open = true; live.tries = 0;
    // (re)connexion : on rejoint les salons et on republie notre état
    for (const R of live.rooms.values()) {
      if (R.name !== LOBBY) send({ t: 'join', room: R.name });
      if (Object.keys(R.mine).length) send({ t: 'pres', room: R.name, p: R.mine });
      R.fire();
    }
    notifyConnection();
    if (live.resolveFirst) { live.resolveFirst(lobby.api); live.resolveFirst = null; }
    return;
  }
  const R = typeof m.room === 'string' ? live.rooms.get(m.room) : null;
  if (!R) return;
  if (m.t === 'peers' && Array.isArray(m.peers)) {
    R.others.clear();
    for (const o of m.peers) if (o && typeof o.peer === 'string' && o.p && typeof o.p === 'object') R.setPeer(o.peer, o.p);
    if (R.pending) R.pending.ok();
    R.fire();
  } else if (m.t === 'pres' && typeof m.peer === 'string' && m.p && typeof m.p === 'object') {
    R.setPeer(m.peer, m.p); R.fire();
  } else if (m.t === 'left' && typeof m.peer === 'string') {
    if (R.others.delete(m.peer)) R.fire();
  } else if (m.t === 'err') {
    if (R.pending) R.pending.fail(String(m.code || 'upstream_error'));
  }
}
function open() {
  if (live.ws) return;
  let ws;
  try { ws = new WebSocket(url()); } catch (e) { return retry(); }
  live.ws = ws;
  ws.onmessage = onMessage;
  ws.onclose = () => {
    if (live.ws !== ws) return;
    const was = live.open;
    live.open = false; live.ws = null;
    if (was) notifyConnection();
    retry();
  };
  ws.onerror = () => {};
}
function retry() {
  const delay = Math.min(15000, 800 * Math.pow(1.7, live.tries++));
  setTimeout(open, delay);
}
// un message régulier garde la connexion (et un hébergement gratuit) éveillée
live.pingTimer = setInterval(() => {
  // plus de nouvelles du serveur depuis longtemps : la connexion est morte sans l'avoir dit
  if (live.open && Date.now() - (live.lastSeen || 0) > 70000) { try { live.ws.close(); } catch (e) {} return; }
  send({ t: 'ping' });
}, 25000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !live.ws) { live.tries = 0; open(); } });

window.MetroLive = {
  /** Résout avec le salon d'accueil dès que la première connexion est établie. */
  connect() {
    if (!live.firstOpen) {
      live.firstOpen = new Promise(resolve => { live.resolveFirst = resolve; });
      open();
    }
    return live.firstOpen;
  },
  isOpen: () => live.open,
};
})();
