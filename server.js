'use strict';
/**
 * Métro Duel : serveur.
 *
 * Facultatif : par défaut le site est statique et le duel passe par une liaison directe
 * entre joueurs (public/p2p.js). Ce serveur sert au mode transport: "ws" de public/config.js.
 *
 * Deux rôles dans un seul processus :
 *   1. servir le site statique (dossier public/) ;
 *   2. relayer en WebSocket (/ws) la « présence » des joueurs d'un même salon.
 *
 * Le serveur ne connaît pas les règles du jeu : chaque joueur publie son état
 * (pseudo, stations trouvées, heure de départ…) et le serveur le recopie aux
 * autres membres du salon. Rien n'est stocké : tout vit en mémoire.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PUBLIC_DIR = path.join(__dirname, 'public');
const LOBBY = 'lobby';
const ROOM_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com",
  // https://0.peerjs.com : mise en relation du duel en liaison directe (p2p.js)
  "font-src https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self' ws: wss: https://0.peerjs.com",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'",
].join('; ');

function createApp(options = {}) {
  const env = options.env || process.env;
  const LIMITS = Object.assign({
    message: 6 * 1024,     // octets par message reçu
    presence: 4 * 1024,    // octets de présence par joueur et par salon
    keys: 32,              // champs par présence
    text: 2048,            // caractères par champ texte
    roomsPerClient: 4,     // salons de partie par connexion (hors accueil)
    peersPerRoom: 8,       // connexions par salon de partie
    connections: Number(env.MAX_CONNECTIONS) || 2000,
    perIp: Number(env.MAX_PER_IP) || 30,
    rate: 40, burst: 80,   // messages par seconde et par connexion
  }, options.limits);
  const allowedOrigins = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
  const trustProxy = /^(1|true|yes)$/i.test(String(env.TRUST_PROXY || ''));

  const rooms = new Map();    // nom du salon → Map(id → client)
  const clients = new Set();
  const perIp = new Map();
  const fileCache = new Map();

  /* ---------------- site statique ---------------- */
  function sendFile(req, res, file, stat) {
    const key = file + ':' + stat.mtimeMs + ':' + stat.size;
    let entry = fileCache.get(file);
    if (!entry || entry.key !== key) {
      const body = fs.readFileSync(file);
      const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const text = /^(text\/|application\/(json|manifest\+json)|image\/svg)/.test(type);
      entry = { key, body, type, gz: text && body.length > 1024 ? zlib.gzipSync(body) : null, etag: '"' + stat.size.toString(36) + '-' + Math.round(stat.mtimeMs).toString(36) + '"' };
      fileCache.set(file, entry);
    }
    const headers = {
      'Content-Type': entry.type, 'ETag': entry.etag, 'Cache-Control': 'no-cache', 'Vary': 'Accept-Encoding',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    };
    if (entry.type.startsWith('text/html')) headers['Content-Security-Policy'] = CSP;
    if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); return res.end(); }
    let body = entry.body;
    if (entry.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) { body = entry.gz; headers['Content-Encoding'] = 'gzip'; }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }
  function plain(res, code, text) {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(text);
  }
  function handleHttp(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'Méthode non autorisée');
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { return plain(res, 400, 'Requête invalide'); }
    if (pathname === '/healthz') return plain(res, 200, 'ok');
    if (pathname.includes('\0')) return plain(res, 400, 'Requête invalide');
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.join(PUBLIC_DIR, path.normalize(pathname));
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return plain(res, 403, 'Interdit');
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) return plain(res, 404, 'Page introuvable');
      try { sendFile(req, res, file, stat); } catch (e) { plain(res, 500, 'Erreur serveur'); }
    });
  }

  /* ---------------- temps réel ---------------- */
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.message, perMessageDeflate: false });
  const server = http.createServer(handleHttp);

  function ipOf(req) {
    if (trustProxy) { const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (f) return f; }
    return req.socket.remoteAddress || '?';
  }
  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;                       // client non-navigateur (tests, scripts)
    if (allowedOrigins.length) return allowedOrigins.includes(origin.replace(/\/$/, ''));
    try { return new URL(origin).host === req.headers.host; } catch (e) { return false; }
  }
  function refuse(socket, code, text) {
    socket.write('HTTP/1.1 ' + code + ' ' + text + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
  }
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch (e) {}
    if (pathname !== '/ws') return refuse(socket, 404, 'Not Found');
    if (!originAllowed(req)) return refuse(socket, 403, 'Forbidden');
    const ip = ipOf(req);
    if (clients.size >= LIMITS.connections || (perIp.get(ip) || 0) >= LIMITS.perIp) return refuse(socket, 503, 'Service Unavailable');
    wss.handleUpgrade(req, socket, head, ws => onConnection(ws, ip));
  });

  function send(c, msg) {
    if (c.ws.readyState === 1 && c.ws.bufferedAmount < 1024 * 1024) c.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  function broadcast(room, msg, except) {
    const members = rooms.get(room);
    if (!members) return;
    const text = JSON.stringify(msg);
    for (const c of members.values()) if (c !== except) send(c, text);
  }
  function snapshot(c, room) {
    const peers = [];
    for (const o of rooms.get(room).values()) { const p = o.rooms.get(room); if (o !== c && p) peers.push({ peer: o.id, p }); }
    send(c, { t: 'peers', room, peers });
  }
  function enter(c, room) {
    if (!rooms.has(room)) rooms.set(room, new Map());
    rooms.get(room).set(c.id, c);
    c.rooms.set(room, null);
  }
  function exit(c, room) {
    const members = rooms.get(room);
    if (!members || !c.rooms.has(room)) return;
    const had = c.rooms.get(room);
    members.delete(c.id); c.rooms.delete(room);
    if (!members.size) rooms.delete(room);
    else if (had) broadcast(room, { t: 'left', room, peer: c.id });
  }
  /** Ne garde qu'un objet plat de champs simples : c'est tout ce dont le jeu a besoin. */
  function cleanPresence(p) {
    if (p === null) return null;
    if (typeof p !== 'object' || Array.isArray(p)) return undefined;
    const out = {};
    let n = 0;
    for (const k of Object.keys(p)) {
      const v = p[k];
      if (v === null || v === undefined) continue;
      if (!KEY_RE.test(k) || ++n > LIMITS.keys) return undefined;
      if (typeof v === 'string') { if (v.length > LIMITS.text) return undefined; out[k] = v; }
      else if (typeof v === 'number') { if (!Number.isFinite(v)) return undefined; out[k] = v; }
      else if (typeof v === 'boolean') out[k] = v;
      else return undefined;
    }
    if (Buffer.byteLength(JSON.stringify(out)) > LIMITS.presence) return undefined;
    return n ? out : null;
  }
  function allow(c) {
    const now = Date.now();
    c.tokens = Math.min(LIMITS.burst, c.tokens + (now - c.stamp) / 1000 * LIMITS.rate); c.stamp = now;
    if (c.tokens < 1) return false;
    c.tokens -= 1; return true;
  }
  function onMessage(c, data, isBinary) {
    if (isBinary) return;
    if (!allow(c)) { if (++c.dropped > 400) c.ws.close(1008, 'trop de messages'); return; }
    let m;
    try { m = JSON.parse(data.toString('utf8')); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'ping') return send(c, { t: 'pong', now: Date.now() });
    const room = m.room;
    if (typeof room !== 'string' || !ROOM_RE.test(room)) return;
    if (m.t === 'join') {
      if (room === LOBBY || c.rooms.has(room)) return snapshot(c, room);
      if (c.rooms.size - 1 >= LIMITS.roomsPerClient) return send(c, { t: 'err', room, code: 'too_many_rooms' });
      const members = rooms.get(room);
      if (members && members.size >= LIMITS.peersPerRoom) return send(c, { t: 'err', room, code: 'room_full' });
      enter(c, room); snapshot(c, room);
    } else if (m.t === 'leave') {
      if (room !== LOBBY) exit(c, room);
    } else if (m.t === 'pres') {
      if (!c.rooms.has(room)) return;
      const p = cleanPresence(m.p);
      if (p === undefined) return send(c, { t: 'err', room, code: 'bad_presence' });
      const had = c.rooms.get(room);
      c.rooms.set(room, p);
      if (p) broadcast(room, { t: 'pres', room, peer: c.id, p }, c);
      else if (had) broadcast(room, { t: 'left', room, peer: c.id }, c);
    }
  }
  function onConnection(ws, ip) {
    const c = { id: crypto.randomBytes(9).toString('base64url'), ws, ip, rooms: new Map(), alive: true, tokens: LIMITS.burst, stamp: Date.now(), dropped: 0 };
    clients.add(c); perIp.set(ip, (perIp.get(ip) || 0) + 1);
    enter(c, LOBBY);
    send(c, { t: 'hello', peer: c.id, now: Date.now() });
    snapshot(c, LOBBY);
    ws.on('message', (data, isBinary) => { try { onMessage(c, data, isBinary); } catch (e) { /* un message malformé ne doit jamais faire tomber le serveur */ } });
    ws.on('pong', () => { c.alive = true; });
    ws.on('error', () => {});
    ws.on('close', () => {
      for (const room of [...c.rooms.keys()]) exit(c, room);
      clients.delete(c);
      const n = (perIp.get(ip) || 1) - 1;
      if (n > 0) perIp.set(ip, n); else perIp.delete(ip);
    });
  }
  // coupe les connexions mortes (onglet fermé sans prévenir, réseau perdu)
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch (e) {}
    }
  }, Number(options.heartbeatMs) || 30000);
  heartbeat.unref();

  function close() {
    clearInterval(heartbeat);
    for (const c of clients) c.ws.terminate();
    return new Promise(resolve => server.close(() => resolve()));
  }
  return { server, rooms, clients, limits: LIMITS, close };
}

module.exports = { createApp };

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT) || 3000;
  app.server.listen(port, () => console.log('Métro Duel écoute sur le port ' + port));
  const stop = () => { app.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
