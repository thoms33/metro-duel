/*
 * Métro Duel : liaison directe entre joueurs (WebRTC, par la bibliothèque PeerJS).
 *
 * Même interface que live.js (salons, présence) mais sans serveur à faire tourner : la mise en relation
 * passe par le serveur public de PeerJS, puis l'état des joueurs circule d'un navigateur à l'autre.
 * Le premier arrivé dans un salon réserve son identifiant et en devient le relais : il recopie à chacun
 * l'état des autres, comme le ferait le serveur. Si le relais disparaît, un autre membre reprend l'identifiant.
 * PeerJS (vendor/peerjs.min.js) n'est chargé qu'à l'entrée dans un salon : le solo n'en a pas besoin.
 */
(() => {
'use strict';
const cfg = window.METRO_CONFIG || {};
if (cfg.transport === 'ws') return;               // c'est le serveur WebSocket (live.js) qui relie les joueurs

const PREFIX = 'metro-duel-', LOBBY = 'lobby';
const MAX_PEERS = 8;                              // connexions par salon, relais compris
const PING_MS = 3000, SILENCE_MS = 12000;         // signe de vie ; 12 s sans nouvelles et la liaison est perdue
const LINK_MS = 15000;                            // délai pour rejoindre le relais
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const rooms = new Map();                          // salons de partie (l'accueil est à part)

/* ---------------- PeerJS, chargé à la demande ---------------- */
let libP = null;
function lib() {
  if (window.Peer) return Promise.resolve(window.Peer);
  if (!libP) libP = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/peerjs.min.js';
    s.onload = () => (window.Peer ? resolve(window.Peer) : reject(new Error('PeerJS absent')));
    s.onerror = () => { libP = null; s.remove(); reject(new Error('PeerJS introuvable')); };
    document.head.append(s);
  });
  return libP;
}

/** Même filtre que le serveur : un objet plat de champs simples, de taille raisonnable. */
function clean(p) {
  if (p === null) return null;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return undefined;
  const out = {};
  let n = 0;
  for (const k of Object.keys(p)) {
    const v = p[k];
    if (v === null || v === undefined) continue;
    if (!KEY_RE.test(k) || ++n > 32) return undefined;
    if (typeof v === 'string') { if (v.length > 2048) return undefined; }
    else if (typeof v === 'number') { if (!Number.isFinite(v)) return undefined; }
    else if (typeof v !== 'boolean') return undefined;
    out[k] = v;
  }
  if (!n) return null;
  return JSON.stringify(out).length <= 4096 ? out : undefined;
}
function send(conn, msg) { if (conn && conn.open) { try { conn.send(msg); } catch (e) {} } }

/* ---------------- salons ---------------- */
function makeRoom(name) {
  const R = {
    name, mine: {}, myAt: Date.now(), others: new Map(), handlers: new Set(), connHandlers: new Set(), snap: Object.freeze([]), queued: false, gone: false,
    gen: 0,          // numéro de la tentative en cours : les événements d'une tentative abandonnée sont ignorés
    peer: null, selfId: null, relay: false,
    links: new Map(), // relais : identifiant du membre → { conn, seen, p }
    up: null,         // membre : { conn, seen } vers le relais
    linked: false, tries: 0, timer: 0,
  };
  const rebuild = () => {
    R.snap = Object.freeze([
      Object.freeze({ peer: R.selfId || 'moi', by: null, isMe: true, sameTab: true, kind: 'viewer', guest: false, presence: Object.freeze(Object.assign({}, R.mine)), updatedAt: R.myAt }),
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
    R.others.set(peer, Object.freeze({ peer, by: null, isMe: false, sameTab: false, kind: 'viewer', guest: false, presence: Object.freeze(p), updatedAt: Date.now() }));
  };
  R.api = {
    name,
    presence(patch) {
      for (const k of Object.keys(patch || {})) { if (patch[k] === null || patch[k] === undefined) delete R.mine[k]; else R.mine[k] = patch[k]; }
      R.myAt = Date.now();
      publish(R);
      R.fire();
      return Promise.resolve();
    },
    peers: () => R.snap,
    onPeers(handler) { R.handlers.add(handler); R.fire(); return () => { R.handlers.delete(handler); }; },
    connected: () => R.linked,
    onConnection(handler) { R.connHandlers.add(handler); Promise.resolve().then(() => handler(R.linked)); return () => { R.connHandlers.delete(handler); }; },
    leave() {
      if (name === LOBBY || R.gone) return Promise.resolve();
      R.gone = true; R.handlers.clear(); R.connHandlers.clear();
      rooms.delete(name);
      teardown(R);
      return Promise.resolve();
    },
  };
  rebuild();
  return R;
}
function linkUp(R, on) {
  if (R.linked === on) return;
  R.linked = on;
  for (const h of [...R.connHandlers]) { try { h(on); } catch (e) { console.error(e); } }
}
/** Envoie mon état : à tous les membres si je suis le relais, au relais sinon. */
function publish(R) {
  const p = Object.keys(R.mine).length ? R.mine : null;
  if (R.relay) { for (const l of R.links.values()) send(l.conn, p ? { t: 'pres', peer: R.selfId, p } : { t: 'left', peer: R.selfId }); }
  else if (R.up) send(R.up.conn, { t: 'pres', p });
}
function relayAll(R, msg, except) { for (const [id, l] of R.links) if (id !== except) send(l.conn, msg); }

/** Ferme tout ce qu'a ouvert la tentative en cours. */
function teardown(R) {
  R.gen++;
  clearTimeout(R.timer); R.timer = 0;
  const peer = R.peer;
  R.peer = null; R.selfId = null; R.relay = false; R.up = null; R.links.clear();
  if (peer) { try { peer.destroy(); } catch (e) {} }   // ferme aussi ses liaisons
  if (R.others.size) R.others.clear();
  R.fire();
  linkUp(R, false);
}
/** Liaison perdue ou impossible : on recommence un peu plus tard. */
function fail(R, gen) {
  if (gen !== R.gen || R.gone) return;
  teardown(R);
  const delay = Math.min(10000, 1000 * Math.pow(1.6, R.tries++));
  R.timer = setTimeout(() => { R.timer = 0; attempt(R); }, delay);
}

async function attempt(R) {
  if (R.gone) return;
  const gen = ++R.gen;
  let Peer;
  try { Peer = await lib(); } catch (e) { return fail(R, gen); }
  if (gen !== R.gen || R.gone) return;
  // on essaie d'abord de réserver l'identifiant du salon : si on l'obtient, on en est le relais
  const peer = new Peer(PREFIX + R.name);
  R.peer = peer;
  const live = () => gen === R.gen && R.peer === peer;
  peer.on('open', () => {
    if (!live() || R.relay) return;                // un second « open » suit une reconnexion au serveur de mise en relation
    R.relay = true; R.selfId = PREFIX + R.name; R.tries = 0;
    R.fire(); linkUp(R, true);
  });
  peer.on('connection', conn => { if (live() && R.relay) accept(R, gen, conn); else { try { conn.close(); } catch (e) {} } });
  peer.on('disconnected', () => {
    // le serveur de mise en relation nous a lâchés : les liaisons ouvertes continuent, on s'y rebranche pour garder l'identifiant
    if (!live() || !R.relay) return;
    setTimeout(() => { if (live() && !peer.destroyed && peer.disconnected) { try { peer.reconnect(); } catch (e) {} } }, 2000);
  });
  peer.on('error', err => {
    if (!live()) return;
    const type = err && err.type;
    if (type === 'unavailable-id' && !R.relay) return follow(R, gen, Peer);   // quelqu'un tient déjà le salon : on le rejoint
    if (!R.relay || type === 'unavailable-id') fail(R, gen);                  // pas de mise en relation, ou identifiant perdu
  });
}

/** Relais : accueille un membre et lui envoie l'état de tout le salon. */
function accept(R, gen, conn) {
  const id = conn.peer;
  conn.on('open', () => {
    if (gen !== R.gen) { try { conn.close(); } catch (e) {} return; }
    if (!R.links.has(id) && R.links.size + 1 >= MAX_PEERS) { setTimeout(() => { try { conn.close(); } catch (e) {} }, 200); return; }
    const old = R.links.get(id);
    R.links.set(id, { conn, seen: Date.now(), p: null });
    if (old) { try { old.conn.close(); } catch (e) {} }
    const peers = [];
    if (Object.keys(R.mine).length) peers.push({ peer: R.selfId, p: R.mine });
    for (const [k, l] of R.links) if (k !== id && l.p) peers.push({ peer: k, p: l.p });
    send(conn, { t: 'peers', peers });
  });
  conn.on('data', d => {
    const l = R.links.get(id);
    if (gen !== R.gen || !l || l.conn !== conn) return;
    l.seen = Date.now();
    if (!d || d.t !== 'pres') return;
    const p = clean(d.p);
    if (p === undefined) return;
    const had = l.p;
    l.p = p;
    if (p) { R.setPeer(id, p); relayAll(R, { t: 'pres', peer: id, p }, id); R.fire(); }
    else if (had) { R.others.delete(id); relayAll(R, { t: 'left', peer: id }, id); R.fire(); }
  });
  conn.on('close', () => drop(R, gen, id, conn));
  conn.on('error', () => {});
}
function drop(R, gen, id, conn) {
  const l = R.links.get(id);
  if (gen !== R.gen || !l || l.conn !== conn) return;
  R.links.delete(id);
  try { conn.close(); } catch (e) {}
  if (l.p) { R.others.delete(id); relayAll(R, { t: 'left', peer: id }); R.fire(); }
}

/** Membre : se relie au relais du salon. */
function follow(R, gen, Peer) {
  const peer = new Peer();
  R.peer = peer;
  const give = setTimeout(() => { if (gen === R.gen && !R.linked) fail(R, gen); }, LINK_MS);
  peer.on('open', () => {
    if (gen !== R.gen) return;
    const conn = peer.connect(PREFIX + R.name, { reliable: true, serialization: 'json' });
    conn.on('open', () => {
      if (gen !== R.gen) return;
      R.up = { conn, seen: Date.now() };
      publish(R);                                  // le relais répond par l'état de tout le salon
    });
    conn.on('data', d => {
      if (gen !== R.gen || !R.up || R.up.conn !== conn) return;
      R.up.seen = Date.now();
      fromRelay(R, d, give);
    });
    conn.on('close', () => fail(R, gen));
    conn.on('error', () => {});
  });
  // salon introuvable, réseau… : on réessaie. Une fois relié au relais, le serveur de mise en relation ne sert plus.
  peer.on('error', () => { if (R.peer === peer && !R.up) fail(R, gen); });
}
function fromRelay(R, d, give) {
  if (!d || typeof d !== 'object') return;
  if (d.t === 'peers' && Array.isArray(d.peers)) {
    clearTimeout(give);
    R.others.clear();
    for (const o of d.peers) { const p = o && typeof o.peer === 'string' ? clean(o.p) : null; if (p) R.setPeer(o.peer, p); }
    R.tries = 0;
    R.fire(); linkUp(R, true);
  } else if (d.t === 'pres' && typeof d.peer === 'string') {
    const p = clean(d.p);
    if (p) { R.setPeer(d.peer, p); R.fire(); }
  } else if (d.t === 'left' && typeof d.peer === 'string') {
    if (R.others.delete(d.peer)) R.fire();
  }
}

// signes de vie : une liaison muette depuis trop longtemps est morte sans l'avoir dit (onglet fermé, réseau perdu)
setInterval(() => {
  const now = Date.now();
  for (const R of rooms.values()) {
    if (R.relay) { for (const [id, l] of R.links) { if (now - l.seen > SILENCE_MS) drop(R, R.gen, id, l.conn); else send(l.conn, { t: 'ping' }); } }
    else if (R.up) { if (now - R.up.seen > SILENCE_MS) fail(R, R.gen); else send(R.up.conn, { t: 'ping' }); }
  }
}, PING_MS);
// retour sur la page (téléphone réveillé) : on n'attend pas la fin du délai pour se relier
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  for (const R of rooms.values()) if (R.timer) { clearTimeout(R.timer); R.timer = 0; R.tries = 0; attempt(R); }
});

/* ---------------- accueil ---------------- */
// sans serveur, pas d'annuaire des parties : l'accueil est local, on se retrouve par le code ou le lien
const lobby = makeRoom(LOBBY);
lobby.linked = true;
lobby.api.join = name => {
  let R = rooms.get(name);
  if (!R) { R = makeRoom(name); rooms.set(name, R); attempt(R); }
  return Promise.resolve(R.api);
};

window.MetroLive = {
  connect: () => Promise.resolve(lobby.api),
  isOpen: () => true,
  listsGames: false,
};
})();
