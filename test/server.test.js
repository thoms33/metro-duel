'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const WebSocket = require('ws');
const { createApp } = require('../server');

async function start(options) {
  const app = createApp(Object.assign({ env: {} }, options));
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  return { app, port: app.server.address().port };
}
function get(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', d => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
  });
}
/** Client de test : file d'attente des messages reçus, avec attente par type. */
function connect(port, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws', { headers });
    const queue = [], waiters = [];
    ws.on('message', data => {
      const m = JSON.parse(data.toString());
      const i = waiters.findIndex(w => w.match(m));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else queue.push(m);
    });
    const c = {
      ws, id: null,
      send: m => ws.send(JSON.stringify(m)),
      next(match, ms = 1500) {
        const fn = typeof match === 'string' ? m => m.t === match : match;
        const i = queue.findIndex(fn);
        if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const w = { match: fn, resolve: res };
          waiters.push(w);
          setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); rej(new Error('message attendu non reçu')); } }, ms);
        });
      },
      close: () => new Promise(res => { ws.once('close', res); ws.close(); }),
    };
    ws.once('open', async () => { const hello = await c.next('hello'); c.id = hello.peer; await c.next(m => m.t === 'peers' && m.room === 'lobby'); resolve(c); });
    ws.once('unexpected-response', (req, res) => reject(Object.assign(new Error('refusé'), { status: res.statusCode })));
    ws.once('error', reject);
  });
}

test('sert le site et protège les fichiers hors de public/', async () => {
  const { app, port } = await start();
  try {
    const home = await get(port, '/');
    assert.strictEqual(home.status, 200);
    assert.match(home.headers['content-type'], /text\/html/);
    assert.ok(home.headers['content-security-policy']);
    assert.match(home.body, /Métro Duel/);
    assert.strictEqual((await get(port, '/healthz')).body, 'ok');
    assert.strictEqual((await get(port, '/app.js')).status, 200);
    assert.strictEqual((await get(port, '/inconnu.html')).status, 404);
    assert.notStrictEqual((await get(port, '/../server.js')).status, 200);
    assert.notStrictEqual((await get(port, '/%2e%2e/package.json')).status, 200);
    assert.strictEqual((await get(port, '/', 'POST')).status, 405);
    const cached = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/style.css', headers: { 'If-None-Match': '' } }, r1 => {
        r1.resume();
        http.get({ host: '127.0.0.1', port, path: '/style.css', headers: { 'If-None-Match': r1.headers.etag } }, r2 => { r2.resume(); resolve(r2.statusCode); }).on('error', reject);
      }).on('error', reject);
    });
    assert.strictEqual(cached, 304);
  } finally { await app.close(); }
});

test('relaie la présence entre les joueurs d\'un salon', async () => {
  const { app, port } = await start();
  try {
    const a = await connect(port), b = await connect(port);
    a.send({ t: 'join', room: 'duel-test' });
    assert.deepStrictEqual((await a.next(m => m.t === 'peers' && m.room === 'duel-test')).peers, []);
    a.send({ t: 'pres', room: 'duel-test', p: { id: 'a', n: 'Thomas', k: 1, nothing: null } });
    b.send({ t: 'join', room: 'duel-test' });
    const snap = await b.next(m => m.t === 'peers' && m.room === 'duel-test');
    assert.deepStrictEqual(snap.peers, [{ peer: a.id, p: { id: 'a', n: 'Thomas', k: 1 } }]);
    b.send({ t: 'pres', room: 'duel-test', p: { id: 'b', k: 3 } });
    const got = await a.next('pres');
    assert.deepStrictEqual(got, { t: 'pres', room: 'duel-test', peer: b.id, p: { id: 'b', k: 3 } });
    await b.close();
    assert.deepStrictEqual(await a.next('left'), { t: 'left', room: 'duel-test', peer: b.id });
    await a.close();
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(app.rooms.has('duel-test'), false);
    assert.strictEqual(app.clients.size, 0);
  } finally { await app.close(); }
});

test('l\'accueil annonce les parties ouvertes aux nouveaux arrivants', async () => {
  const { app, port } = await start();
  try {
    const host = await connect(port);
    host.send({ t: 'pres', room: 'lobby', p: { w: 'K7QF', wn: 'Thomas' } });
    host.send({ t: 'ping' }); await host.next('pong');
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    const lobby = await new Promise(resolve => ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.t === 'peers') resolve(m); }));
    assert.deepStrictEqual(lobby.peers, [{ peer: host.id, p: { w: 'K7QF', wn: 'Thomas' } }]);
    ws.close(); await host.close();
  } finally { await app.close(); }
});

test('applique les limites', async () => {
  const { app, port } = await start({ limits: { peersPerRoom: 2, roomsPerClient: 1 } });
  try {
    const a = await connect(port), b = await connect(port), c = await connect(port);
    a.send({ t: 'join', room: 'r1' }); b.send({ t: 'join', room: 'r1' });
    await a.next('peers'); await b.next('peers');
    c.send({ t: 'join', room: 'r1' });
    assert.strictEqual((await c.next('err')).code, 'room_full');
    a.send({ t: 'join', room: 'r2' });
    assert.strictEqual((await a.next('err')).code, 'too_many_rooms');
    a.send({ t: 'pres', room: 'r1', p: { nested: { x: 1 } } });
    assert.strictEqual((await a.next('err')).code, 'bad_presence');
    a.send({ t: 'pres', room: 'r1', p: { f: 'x'.repeat(5000) } });
    assert.strictEqual((await a.next('err')).code, 'bad_presence');
    // messages invalides : ignorés, la connexion reste utilisable
    a.ws.send('pas du json'); a.send({ t: 'join', room: 'NOM INVALIDE' }); a.send({ t: 'pres', room: 'ailleurs', p: { k: 1 } });
    a.send({ t: 'ping' });
    assert.strictEqual((await a.next('pong')).t, 'pong');
    await Promise.all([a.close(), b.close(), c.close()]);
  } finally { await app.close(); }
});

test('refuse les sites non autorisés', async () => {
  const one = await start();
  try {
    await assert.rejects(connect(one.port, { Origin: 'https://ailleurs.example' }), e => e.status === 403);
    const ok = await connect(one.port, { Origin: 'http://127.0.0.1:' + one.port });
    await ok.close();
  } finally { await one.app.close(); }
  const two = await start({ env: { ALLOWED_ORIGINS: 'https://thoms33.github.io, https://metro.example/' } });
  try {
    const ok = await connect(two.port, { Origin: 'https://thoms33.github.io' });
    await ok.close();
    await assert.rejects(connect(two.port, { Origin: 'https://ailleurs.example' }), e => e.status === 403);
    assert.strictEqual((await get(two.port, '/ws')).status, 404);
  } finally { await two.app.close(); }
});
