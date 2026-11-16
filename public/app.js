(() => {
'use strict';
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const store = {
  get(area, k) { try { const v = window[area].getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
  set(area, k, v) { try { if (v == null) window[area].removeItem(k); else window[area].setItem(k, JSON.stringify(v)); } catch (e) {} },
};
const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ================= données ================= */
const D = window.METRO_DATA;
const ST = D.st.map((s, i) => ({ i, name: s[0].replace(/ - /g, ' – '), x: s[1], y: s[2], lines: s[3], aliases: s[4] }));
const LINES = D.lines.map((l, i) => ({ i, id: l.id, c: l.c, t: l.t, v: l.v, st: [...new Set(l.v.flat())] }));
const N = ST.length;

/* ================= reconnaissance des noms ================= */
const fold = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\u0153/g, 'oe').replace(/\u00e6/g, 'ae').replace(/&/g, ' et ');
const tokens = s => fold(s).split(/[^a-z0-9]+/).filter(Boolean).map(t => t === 'st' ? 'saint' : t === 'ste' ? 'sainte' : t);
const keyOf = s => tokens(s).join('');
const KEYS = new Map();
ST.forEach(s => { s.key = keyOf(s.name); KEYS.set(s.key, s.i); });
ST.forEach(s => {
  const extra = s.aliases.slice(), t = tokens(s.name);
  if (t.length > 1 && ['le', 'la', 'les', 'l'].includes(t[0])) extra.push(t.slice(1).join(' '));
  for (const a of extra) { const k = keyOf(a); if (k && !KEYS.has(k)) KEYS.set(k, s.i); }
});
const ALLKEYS = [...KEYS.keys()];
// clés qui sont le début du nom d'une autre station (« Nation » / « Nationale ») : on attend avant de valider
const LONGER = new Map();
for (const a of ALLKEYS) for (const b of ALLKEYS) {
  if (b.length > a.length && b.startsWith(a) && KEYS.get(a) !== KEYS.get(b)) {
    if (!LONGER.has(a)) LONGER.set(a, new Set());
    LONGER.get(a).add(KEYS.get(b));
  }
}
function osa(a, b, max) {
  const n = a.length, m = b.length;
  if (Math.abs(n - m) > max) return max + 1;
  let p2 = null, p1 = [], cur;
  for (let j = 0; j <= m; j++) p1.push(j);
  for (let i = 1; i <= n; i++) {
    cur = [i]; let best = i;
    for (let j = 1; j <= m; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(p1[j] + 1, cur[j - 1] + 1, p1[j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, p2[j - 2] + 1);
      cur.push(v); if (v < best) best = v;
    }
    if (best > max) return max + 1;
    p2 = p1; p1 = cur;
  }
  return p1[m];
}
function fuzzy(k) {
  if (k.length < 5) return null;
  const max = k.length >= 10 ? 2 : 1;
  let best = max + 1, idx = null, tie = false;
  for (const key of ALLKEYS) {
    const d = osa(k, key, max), i = KEYS.get(key);
    if (d < best) { best = d; idx = i; tie = false; }
    else if (d === best && d <= max && i !== idx) tie = true;
  }
  return best <= max && !tie ? idx : null;
}

/* ================= état du jeu ================= */
const G = { on: false, kind: 'solo', rule: 'course', dur: 3600, t0: 0, pausedAt: 0, found: new Map(), ended: false, reveal: false };
const Opp = { id: null, name: '', here: false, found: new Map(), fstr: '', x: 0 };
const MP = {};                      // ma présence dans la partie à deux
const status = new Uint8Array(N);   // 0 à trouver · 1 à moi · 2 à l'adversaire (conquête)
const ring = new Uint8Array(N);     // trouvée par l'adversaire (course)
let myScore = 0, oppScore = 0, labelOrder = [], sel = -1, screen = 'home', peek = false;
const isDuel = () => G.kind === 'duel';
const isConq = () => isDuel() && G.rule === 'conq';
const elapsed = () => G.on ? (G.pausedAt || Date.now()) - G.t0 : 0;
const remainingMs = () => clamp(G.dur * 1000 - Math.max(0, elapsed()), 0, G.dur * 1000);
const playing = () => G.on && !G.ended && !G.pausedAt && Date.now() >= G.t0;

function ownerOf(i) {
  const a = G.found.get(i), b = Opp.found.get(i);
  if (a == null) return b == null ? 0 : 2;
  if (b == null) return 1;
  if (a !== b) return a < b ? 1 : 2;
  return String(MP.id) < String(Opp.id) ? 1 : 2;
}
function recompute() {
  myScore = 0; oppScore = 0;
  const conq = isConq(), duel = isDuel(), order = [];
  for (let i = 0; i < N; i++) {
    let s = 0, r = 0;
    if (conq) s = ownerOf(i);
    else { s = G.found.has(i) ? 1 : 0; r = duel && Opp.found.has(i) ? 1 : 0; }
    status[i] = s; ring[i] = r;
    if (s === 1) myScore++; else if (s === 2) oppScore++;
    if (s) order.push(i);
  }
  if (!conq) oppScore = duel ? Opp.found.size : 0;
  const tOf = i => status[i] === 1 ? G.found.get(i) : Opp.found.get(i);
  order.sort((a, b) => tOf(b) - tOf(a));
  if (G.reveal) for (let i = 0; i < N; i++) if (!status[i]) order.push(i);
  labelOrder = order;
}
const canTake = i => playing() && (isConq() ? status[i] === 0 : !G.found.has(i));

/* ================= carte ================= */
const cv = $('map'), ctx = cv.getContext('2d');
const C = { out: '#efece3', paris: '#fbfaf5', edge: '#cbc5b3', water: '#b3d2ea', ink: '#1a2238', dotEdge: '#6a7080', me: '#1c3d93', opp: '#d6362b', miss: '#b3261e', halo: 'rgba(251,250,245,.94)' };
const V = { k: 0.02, x: 0, y: 0, w: 0, h: 0, dpr: 1, fitK: 0.02, auto: true };
const BB = ST.reduce((b, s) => [Math.min(b[0], s.x), Math.min(b[1], s.y), Math.max(b[2], s.x), Math.max(b[3], s.y)], [1e9, 1e9, -1e9, -1e9]);
const pulses = new Map();
let raf = 0, anim = null, tipIdx = -1;
const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
let followOn = store.get('localStorage', 'md.follow');
if (followOn == null) followOn = coarse;

function spline(pts) {
  const n = pts.length, tan = [], segs = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], d = i === 0 || i === n - 1 ? 1 : 2;
    tan.push([(b[0] - a[0]) / d, (b[1] - a[1]) / d]);
  }
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[i], p1 = pts[i + 1], L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const h = t => { const tl = Math.hypot(t[0], t[1]) || 1, m = Math.min(tl / 3, L * 0.38); return [t[0] / tl * m, t[1] / tl * m]; };
    const a = h(tan[i]), b = h(tan[i + 1]);
    segs.push([p0, [p0[0] + a[0], p0[1] + a[1]], [p1[0] - b[0], p1[1] - b[1]], p1]);
  }
  return segs;
}
const addSeg = (p, sg) => { p.moveTo(sg[0][0], sg[0][1]); p.bezierCurveTo(sg[1][0], sg[1][1], sg[2][0], sg[2][1], sg[3][0], sg[3][1]); };
const edgeLines = new Map();
for (const l of LINES) {
  l.path = new Path2D(); l.segs = new Map();
  for (const v of l.v) {
    spline(v.map(i => [ST[i].x, ST[i].y])).forEach((sg, j) => {
      const a = v[j], b = v[j + 1], key = a < b ? a + '-' + b : b + '-' + a;
      if (l.segs.has(key)) return;
      l.segs.set(key, sg); addSeg(l.path, sg);
      if (!edgeLines.has(key)) edgeLines.set(key, []);
      edgeLines.get(key).push(l.i);
    });
  }
}
// tronçons parcourus par deux lignes : on les dessine rayés
const STRIPES = [];
for (const [key, ls] of edgeLines) if (ls.length > 1) ls.slice(0, -1).forEach((li, m) => { const p = new Path2D(); addSeg(p, LINES[li].segs.get(key)); STRIPES.push({ li, top: ls[ls.length - 1], n: ls.length, m, p }); });
const P_PARIS = new Path2D();
for (const r of D.paris) { r.forEach((p, i) => i ? P_PARIS.lineTo(p[0], p[1]) : P_PARIS.moveTo(p[0], p[1])); P_PARIS.closePath(); }
const P_WATER = new Path2D();
for (const w of D.water) { const segs = spline(w); if (!segs.length) continue; P_WATER.moveTo(w[0][0], w[0][1]); for (const sg of segs) P_WATER.bezierCurveTo(sg[1][0], sg[1][1], sg[2][0], sg[2][1], sg[3][0], sg[3][1]); }

function fitBox(b, pad) {
  const k = Math.min(V.w / (b[2] - b[0] + 2 * pad), V.h / (b[3] - b[1] + 2 * pad));
  return { k, x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 };
}
function resize() {
  const r = cv.parentElement.getBoundingClientRect(), w = Math.max(60, r.width), h = Math.max(60, r.height);
  V.dpr = Math.min(window.devicePixelRatio || 1, 2.5); V.w = w; V.h = h;
  cv.width = Math.round(w * V.dpr); cv.height = Math.round(h * V.dpr);
  const f = fitBox(BB, 1500); V.fitK = f.k;
  if (V.auto) { V.k = f.k; V.x = f.x; V.y = f.y; }
  invalidate();
}
function invalidate() { if (!raf) raf = requestAnimationFrame(frame); }
function frame(t) {
  raf = 0;
  if (anim) {
    const u = anim.ms ? clamp((t - anim.t0) / anim.ms, 0, 1) : 1, e = u < .5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    V.k = Math.exp(Math.log(anim.f.k) + (Math.log(anim.to.k) - Math.log(anim.f.k)) * e);
    V.x = anim.f.x + (anim.to.x - anim.f.x) * e; V.y = anim.f.y + (anim.to.y - anim.f.y) * e;
    if (u >= 1) anim = null;
  }
  draw(t);
  if (anim || pulses.size) invalidate();
}
function animateTo(to, ms) {
  V.auto = false;
  anim = { f: { k: V.k, x: V.x, y: V.y }, to: { k: clamp(to.k, V.fitK * 0.7, 0.55), x: to.x, y: to.y }, t0: performance.now(), ms: reduced ? 0 : ms };
  invalidate();
}
function zoomAt(px, py, f) {
  anim = null;
  const k2 = clamp(V.k * f, V.fitK * 0.7, 0.55), wx = V.x + (px - V.w / 2) / V.k, wy = V.y - (py - V.h / 2) / V.k;
  V.k = k2; V.x = wx - (px - V.w / 2) / k2; V.y = wy + (py - V.h / 2) / k2; V.auto = false; invalidate();
}
const sx = x => (x - V.x) * V.k + V.w / 2, sy = y => (V.y - y) * V.k + V.h / 2;
const badgeText = l => l.id.replace('bis', 'b');

function draw(t) {
  const w = V.w, h = V.h, k = V.k, dpr = V.dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1; ctx.setLineDash([]);
  ctx.fillStyle = C.out; ctx.fillRect(0, 0, w, h);
  ctx.setTransform(dpr * k, 0, 0, -dpr * k, dpr * (w / 2 - V.x * k), dpr * (h / 2 + V.y * k));
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.fillStyle = C.paris; ctx.fill(P_PARIS);
  ctx.strokeStyle = C.edge; ctx.lineWidth = 1 / k; ctx.stroke(P_PARIS);
  ctx.strokeStyle = C.water; ctx.lineWidth = Math.max(2.5 / k, 95); ctx.stroke(P_WATER);
  const lw = clamp(1.7 + 17 * k, 2, 5), r0 = clamp(1.6 + 24 * k, 2.2, 5.5);
  for (const l of LINES) {
    if (l.i === sel) continue;
    ctx.globalAlpha = sel < 0 ? 1 : 0.16; ctx.strokeStyle = l.c; ctx.lineWidth = lw / k; ctx.stroke(l.path);
  }
  if (sel < 0) {
    ctx.lineCap = 'butt';
    for (const s of STRIPES) {
      const d = 7 / k;
      ctx.setLineDash([d, d * (s.n - 1)]); ctx.lineDashOffset = -s.m * d;
      ctx.strokeStyle = LINES[s.li].c; ctx.lineWidth = lw / k; ctx.stroke(s.p);
    }
    ctx.setLineDash([]); ctx.lineCap = 'round';
  } else {
    ctx.globalAlpha = 1; ctx.strokeStyle = LINES[sel].c; ctx.lineWidth = (lw + 1.5) / k; ctx.stroke(LINES[sel].path);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;

  // stations : d'abord celles à trouver, puis les trouvées par-dessus
  const boxes = [], selSet = sel >= 0 ? LINES[sel].st : null;
  for (let pass = 0; pass < 2; pass++) {
    for (const s of ST) {
      const st = status[s.i];
      if ((st ? 1 : 0) !== pass) continue;
      const x = sx(s.x), y = sy(s.y);
      if (x < -12 || x > w + 12 || y < -12 || y > h + 12) continue;
      const r = s.lines.length > 1 ? r0 * 1.3 : r0;
      ctx.globalAlpha = selSet && !selSet.includes(s.i) ? 0.2 : 1;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832);
      if (st === 1) { ctx.fillStyle = C.me; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.3; ctx.stroke(); }
      else if (st === 2) { ctx.fillStyle = C.opp; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.3; ctx.stroke(); }
      else { ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = G.reveal ? C.miss : C.dotEdge; ctx.lineWidth = G.reveal ? 1.6 : Math.max(1, r * 0.3); ctx.stroke(); }
      if (ring[s.i]) { ctx.beginPath(); ctx.arc(x, y, r + 2.6, 0, 6.2832); ctx.strokeStyle = C.opp; ctx.lineWidth = 1.8; ctx.stroke(); }
      if (s.i === tipIdx) { ctx.beginPath(); ctx.arc(x, y, r + 6, 0, 6.2832); ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; ctx.stroke(); }
      boxes.push([x - r - 1, y - r - 1, x + r + 1, y + r + 1]);
    }
  }
  ctx.globalAlpha = 1;
  // halo des dernières trouvailles
  for (const [i, p] of pulses) {
    const u = (t - p.t) / 850;
    if (u >= 1 || reduced) { pulses.delete(i); continue; }
    const s = ST[i];
    ctx.beginPath(); ctx.arc(sx(s.x), sy(s.y), r0 + 4 + 24 * u, 0, 6.2832);
    ctx.strokeStyle = p.c; ctx.globalAlpha = 0.8 * (1 - u); ctx.lineWidth = 3; ctx.stroke(); ctx.globalAlpha = 1;
  }
  // noms : les plus récents d'abord, sans chevauchement
  ctx.font = '600 ' + (k > 0.2 ? 12.5 : 11.5) + 'px Barlow, system-ui, sans-serif';
  ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.lineWidth = 3.2; ctx.strokeStyle = C.halo;
  const th = 14, fk = k > 0.2 ? 1 : 0;
  for (const i of labelOrder) {
    const s = ST[i], x = sx(s.x), y = sy(s.y);
    if (x < -60 || x > w + 60 || y < -20 || y > h + 20) continue;
    if (selSet && !selSet.includes(i)) continue;
    if (!s.tw || s.twk !== fk) { s.tw = ctx.measureText(s.name).width; s.twk = fk; }
    const tw = s.tw, g = (s.lines.length > 1 ? r0 * 1.3 : r0) + 4;
    const cands = [[x + g, y - th / 2], [x - g - tw, y - th / 2], [x - tw / 2, y + g], [x - tw / 2, y - g - th]];
    for (const c of cands) {
      const b = [c[0] - 2, c[1], c[0] + tw + 2, c[1] + th];
      let hit = false;
      for (const p of boxes) if (b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]) { hit = true; break; }
      if (hit) continue;
      boxes.push(b);
      ctx.strokeText(s.name, c[0], c[1] + th / 2);
      ctx.fillStyle = status[i] === 1 ? C.ink : status[i] === 2 ? C.opp : C.miss;
      ctx.fillText(s.name, c[0], c[1] + th / 2);
      break;
    }
  }
}

/* --- gestes --- */
const ptrs = new Map();
let pinch = null, lastTap = { t: 0, x: 0, y: 0 };
const local = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
cv.addEventListener('pointerdown', e => {
  const [x, y] = local(e);
  try { cv.setPointerCapture(e.pointerId); } catch (err) {}
  ptrs.set(e.pointerId, { x, y, x0: x, y0: y, t: performance.now(), moved: false });
  anim = null;
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: V.k }; }
});
cv.addEventListener('pointermove', e => {
  const p = ptrs.get(e.pointerId); if (!p) return;
  const [x, y] = local(e), dx = x - p.x, dy = y - p.y;
  if (Math.hypot(x - p.x0, y - p.y0) > 7) p.moved = true;
  if (ptrs.size === 1) { if (p.moved) { V.x -= dx / V.k; V.y += dy / V.k; V.auto = false; invalidate(); } }
  p.x = x; p.y = y;
  if (ptrs.size === 2 && pinch) {
    const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    zoomAt(mx, my, (pinch.k * d / pinch.d) / V.k);
  }
});
const pointerEnd = e => {
  const p = ptrs.get(e.pointerId); if (!p) return;
  ptrs.delete(e.pointerId);
  if (ptrs.size < 2) pinch = null;
  if (e.type === 'pointerup' && !p.moved && ptrs.size === 0 && performance.now() - p.t < 450) {
    const now = performance.now();
    if (now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) { lastTap.t = 0; const wx = V.x + (p.x - V.w / 2) / V.k, wy = V.y - (p.y - V.h / 2) / V.k; animateTo({ k: V.k * 2, x: wx, y: wy }, 260); }
    else { lastTap = { t: now, x: p.x, y: p.y }; tapAt(p.x, p.y); }
  }
};
cv.addEventListener('pointerup', pointerEnd); cv.addEventListener('pointercancel', pointerEnd);
cv.addEventListener('wheel', e => { e.preventDefault(); const [x, y] = local(e); zoomAt(x, y, Math.exp(-e.deltaY * 0.0016)); }, { passive: false });
$('zin').onclick = () => animateTo({ k: V.k * 1.8, x: V.x, y: V.y }, 220);
$('zout').onclick = () => animateTo({ k: V.k / 1.8, x: V.x, y: V.y }, 220);
$('zfit').onclick = () => { animateTo(fitBox(BB, 1500), 320); };
const followBtn = $('follow');
const paintFollow = () => followBtn.setAttribute('aria-pressed', followOn ? 'true' : 'false');
followBtn.onclick = () => { followOn = !followOn; store.set('localStorage', 'md.follow', followOn); paintFollow(); };
paintFollow();

function lineBadges(s) {
  const b = el('span', 'badges');
  for (const li of s.lines) { const d = el('span', 'lb', badgeText(LINES[li])); d.style.background = LINES[li].c; d.style.color = LINES[li].t; b.append(d); }
  return b;
}
function tapAt(px, py) {
  let best = -1, bd = 20;
  for (const s of ST) { const d = Math.hypot(sx(s.x) - px, sy(s.y) - py); if (d < bd) { bd = d; best = s.i; } }
  const tip = $('tip');
  tipIdx = best;
  if (best < 0) { tip.hidden = true; invalidate(); return; }
  const s = ST[best], known = status[best] || G.reveal;
  tip.replaceChildren(el('b', '', known ? s.name : 'Station à trouver'), lineBadges(s));
  tip.hidden = false; invalidate();
}
function focusStation(i) {
  if (!followOn) return;
  const s = ST[i], k = Math.max(V.k, 0.11), lift = coarse && document.activeElement === q ? V.h * 0.17 : 0;
  animateTo({ k, x: s.x, y: s.y - lift / k }, 420);
}

/* ================= interface ================= */
const q = $('q'), fb = $('fb'), led = $('led');
const cards = { home: $('cardHome'), duel: $('cardDuel'), lobby: $('cardLobby'), pause: $('cardPause'), end: $('cardEnd') };
function show(name) {
  screen = name; if (name !== 'end') peek = false;
  if (name === 'duel' || name === 'lobby') openLobby();   // voir les parties ouvertes, ou annoncer la sienne
  const over = name !== 'play' && !(name === 'end' && peek);
  $('overlay').hidden = !over;
  for (const k in cards) cards[k].hidden = k !== name;
  $('backToEnd').hidden = !(name === 'end' && peek);
  $('entry').hidden = name === 'home' || name === 'duel' || name === 'lobby';
  updateAll();
}
const fmt = ms => { const s = Math.ceil(ms / 1000); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
function renderLed() {
  const ms = G.on ? remainingMs() : G.dur * 1000, txt = fmt(ms);
  if (led.textContent !== txt) led.textContent = txt;
  led.classList.toggle('low', G.on && ms <= 60000);
}
function updateHeader() {
  renderLed();
  const duel = isDuel() && (G.on || screen === 'lobby');
  $('meName').textContent = duel ? (MP.n || 'Moi') : 'Trouvées';
  $('meScore').textContent = myScore;
  $('meTotal').textContent = isConq() ? '' : '/' + N;
  $('oppBox').hidden = !(duel && Opp.id);
  $('oppName').textContent = Opp.name || 'Adversaire';
  $('oppScore').textContent = oppScore;
  $('oppBox').classList.toggle('away', !!Opp.id && !Opp.here);
  $('btnPause').hidden = !(screen === 'play' && !isDuel() && G.on && !G.ended);
  $('btnStop').hidden = !(screen === 'play' && G.on && !G.ended);
  const can = playing() && screen === 'play';
  if (q.disabled === can) { q.disabled = !can; $('ok').disabled = !can; if (can) { try { q.focus({ preventScroll: true }); } catch (e) {} } }
}
function buildChips() {
  const nav = $('lines');
  for (const l of LINES) {
    const b = el('button', 'chip'); b.type = 'button'; b.setAttribute('aria-pressed', 'false');
    const d = el('span', 'lb', badgeText(l)); d.style.background = l.c; d.style.color = l.t;
    l.chipN = el('span', '', '0/' + l.st.length); l.chip = b;
    b.append(d, l.chipN); b.setAttribute('aria-label', 'Ligne ' + l.id);
    b.onclick = () => selectLine(sel === l.i ? -1 : l.i);
    nav.append(b);
  }
}
const lineCount = l => l.st.reduce((n, i) => n + (status[i] ? 1 : 0), 0);
function updateChips() {
  for (const l of LINES) {
    const n = lineCount(l), txt = n + '/' + l.st.length;
    if (l.chipN.textContent !== txt) l.chipN.textContent = txt;
    l.chip.classList.toggle('done', n === l.st.length);
  }
}
function selectLine(li) {
  sel = li;
  for (const l of LINES) l.chip.setAttribute('aria-pressed', l.i === li ? 'true' : 'false');
  renderSheet();
  if (li >= 0) {
    const pts = LINES[li].st.map(i => ST[i]);
    const b = pts.reduce((b, s) => [Math.min(b[0], s.x), Math.min(b[1], s.y), Math.max(b[2], s.x), Math.max(b[3], s.y)], [1e9, 1e9, -1e9, -1e9]);
    requestAnimationFrame(() => {
      const sh = $('sheet'), cover = getComputedStyle(sh).position === 'absolute' ? Math.min(sh.offsetHeight, V.h * 0.6) : 0;
      const k = Math.min(V.w / (b[2] - b[0] + 1800), (V.h - cover) / (b[3] - b[1] + 1800));
      animateTo({ k, x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 - cover / 2 / k }, 320);
    });
  }
  invalidate();
}
function renderSheet() {
  const sh = $('sheet');
  if (sel < 0) { sh.hidden = true; sh.replaceChildren(); return; }
  const l = LINES[sel], head = el('div', 'sheet-h'), close = el('button', '', 'Fermer');
  close.type = 'button'; close.onclick = () => selectLine(-1);
  const d = el('span', 'lb', badgeText(l)); d.style.background = l.c; d.style.color = l.t;
  head.append(d, el('h2', '', 'Ligne ' + l.id), el('span', '', lineCount(l) + '/' + l.st.length), close);
  const out = [head], seen = new Set();
  l.v.forEach((v, vi) => {
    const list = v.filter(i => !seen.has(i)); if (!list.length) return;
    list.forEach(i => seen.add(i));
    if (vi) out.push(el('p', 'branch', 'Autre branche'));
    const ol = el('ol');
    for (const i of list) {
      const st = status[i];
      ol.append(st ? el('li', st === 2 ? 'theirs' : '', ST[i].name) : G.reveal ? el('li', 'miss', ST[i].name) : el('li', 'todo', '•••'));
    }
    out.push(ol);
  });
  sh.replaceChildren(...out); sh.hidden = false;
}
function updateAll() {
  updateHeader(); updateChips();
  if (sel >= 0) renderSheet();
  if (screen === 'lobby') renderLobby();
  if (screen === 'end') renderEnd(false);
  invalidate();
}
function plaqueFor(i, theirs) {
  const p = el('div', 'plaque' + (theirs ? ' theirs' : ''));
  p.append(el('span', 'pl-name', ST[i].name), lineBadges(ST[i]));
  return p;
}
function say(kind, text) {
  fb.replaceChildren(el('span', 'msg ' + kind, text));
  if (kind !== 'hint') { q.classList.remove('shake'); void q.offsetWidth; q.classList.add('shake'); }
}

/* --- saisie --- */
let deferT = 0;
function take(i) {
  if (!canTake(i)) return;
  G.found.set(i, Math.max(0, Math.round((Date.now() - G.t0) / 100)));
  recompute();
  q.value = '';
  fb.replaceChildren(plaqueFor(i, false));
  pulses.set(i, { t: performance.now(), c: C.me });
  focusStation(i);
  if (isDuel()) pushFinds(); else saveSolo();
  updateAll();
  if (!isConq() && G.found.size >= N) finish();
}
q.addEventListener('input', () => {
  clearTimeout(deferT);
  const k = keyOf(q.value); if (!k) return;
  const i = KEYS.get(k);
  if (i == null || !canTake(i)) return;
  const longer = LONGER.get(k);
  if (longer && [...longer].some(canTake)) { deferT = setTimeout(() => { if (keyOf(q.value) === k) take(i); }, 900); return; }
  take(i);
});
$('guess').addEventListener('submit', e => {
  e.preventDefault(); clearTimeout(deferT);
  if (!playing()) return;
  const k = keyOf(q.value); if (!k) return;
  let i = KEYS.get(k);
  if (i == null) i = fuzzy(k);
  if (i == null) return say('miss', 'Aucune station à ce nom.');
  if (canTake(i)) return take(i);
  if (G.found.has(i) && status[i] !== 2) say('dup', ST[i].name + ' : déjà trouvée.');
  else say('taken', ST[i].name + ' : déjà prise par ' + (Opp.name || 'ton adversaire') + '.');
});

/* ================= déroulé d'une partie ================= */
let soloDur = 3600;
function seg(id, get, set) {
  const box = $(id), paint = () => box.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v) === String(get()) ? 'true' : 'false'));
  box.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; set(b.dataset.v); paint(); });
  paint(); return paint;
}
function resetBoard() {
  G.found = new Map(); G.ended = false; G.reveal = false; G.pausedAt = 0;
  Opp.found = new Map(); Opp.fstr = ''; Opp.x = 0;
  pulses.clear(); tipIdx = -1; $('tip').hidden = true;
  fb.replaceChildren(el('span', 'msg hint', 'Accents, tirets et majuscules ne comptent pas.'));
  if (sel >= 0) selectLine(-1);
}
function startSolo(saved) {
  resetBoard();
  G.kind = 'solo'; G.rule = 'course'; G.dur = saved ? saved.dur : soloDur;
  if (saved) for (const [i, t] of saved.finds) if (i >= 0 && i < N) G.found.set(i, t);
  G.t0 = Date.now() - (saved ? saved.elapsed : 0); G.on = true;
  Opp.id = null;
  recompute(); show('play'); saveSolo();
  try { q.focus({ preventScroll: true }); } catch (e) {}
}
const soloState = () => (G.on && !G.ended && !isDuel()) ? { dur: G.dur, elapsed: Math.max(0, elapsed()), finds: [...G.found] } : null;
function saveSolo() { if (!isDuel()) store.set('localStorage', 'md.solo', soloState()); }
function finish() {
  if (!G.on || G.ended) return;
  G.ended = true; G.reveal = true; clearTimeout(deferT);
  if (isDuel()) { MP.x = 1; push(); saveDuel(); }
  else {
    G.pausedAt = G.pausedAt || Date.now();
    store.set('localStorage', 'md.solo', null);
    const best = store.get('localStorage', 'md.best') || {};
    G.record = best[G.dur] || 0;
    if (G.found.size > G.record) { best[G.dur] = G.found.size; store.set('localStorage', 'md.best', best); }
  }
  $('count').hidden = true;
  recompute(); endSig = ''; show('end');
}
let lastSave = 0, stopArmed = 0;
function tick() {
  if (G.on && !G.ended) {
    const pre = G.t0 - Date.now(), c = $('count');
    if (pre > 0 && screen === 'play') { c.hidden = false; const n = String(Math.ceil(pre / 1000)); if (c.textContent !== n) c.textContent = n; }
    else if (!c.hidden) c.hidden = true;
    if (pre <= 0 && remainingMs() <= 0) finish();
    else if (isConq() && pre <= 0 && myScore + oppScore >= N) finish();
    else if (!isDuel() && Date.now() - lastSave > 5000) { lastSave = Date.now(); saveSolo(); }
  }
  updateHeader();
  if (screen === 'end' && isDuel()) renderEnd(false);
}
$('btnStop').onclick = () => {
  const b = $('btnStop');
  if (Date.now() - stopArmed < 3000) { stopArmed = 0; b.textContent = 'Terminer'; finish(); return; }
  stopArmed = Date.now(); b.textContent = 'Confirmer ?';
  setTimeout(() => { if (stopArmed && Date.now() - stopArmed >= 2900) { stopArmed = 0; b.textContent = 'Terminer'; } }, 3000);
};
$('btnPause').onclick = () => { if (!playing()) return; G.pausedAt = Date.now(); saveSolo(); show('pause'); };
$('btnResumePause').onclick = () => { if (G.pausedAt) { G.t0 += Date.now() - G.pausedAt; G.pausedAt = 0; } show('play'); };
$('backToEnd').onclick = () => { peek = false; show('end'); };

/* --- fin de partie --- */
let endSig = '';
function renderEnd(force) {
  const duel = isDuel(), final = !duel || remainingMs() <= 0 || !!Opp.x || !Opp.id || (isConq() && myScore + oppScore >= N);
  const sig = [myScore, oppScore, final, Opp.name, MP.h, Opp.here].join('|');
  if (!force && sig === endSig) return;
  endSig = sig;
  const card = cards.end, out = [];
  if (duel) {
    const v = myScore > oppScore ? ['Victoire', 'win'] : myScore < oppScore ? ['Défaite', 'lose'] : ['Égalité', ''];
    out.push(el('h2', 'verdict ' + (final ? v[1] : ''), final ? v[0] : 'Tu as terminé'));
    if (!final) out.push(el('p', 'note', (Opp.name || 'Ton adversaire') + ' joue encore : le résultat est provisoire jusqu\'à la fin du chrono.'));
    const tally = el('div', 'tally'), a = el('div'), b = el('div', 'opp');
    a.append(el('span', '', MP.n || 'Moi'), el('b', '', myScore)); b.append(el('span', '', Opp.name || 'Adversaire'), el('b', '', oppScore));
    tally.append(a, b); out.push(tally);
    out.push(el('p', 'fine', G.rule === 'conq' ? 'Conquête : chaque station appartient au premier qui la trouve.' : 'Course : chacun remplit sa carte, le plus grand nombre de stations gagne.'));
  } else {
    out.push(el('h2', 'verdict', G.found.size >= N ? 'Réseau complet' : 'Terminus'));
    const tally = el('div', 'tally'), a = el('div'), b = el('div');
    const big = el('b', '', myScore), tot = el('i', '', ' /' + N); a.append(el('span', '', 'Trouvées'), big, tot);
    b.append(el('span', '', 'Du réseau'), el('b', '', Math.round(myScore / N * 100) + ' %'));
    tally.append(a, b); out.push(tally);
    const mins = Math.round(G.dur / 60);
    out.push(el('p', 'fine', myScore > (G.record || 0) ? 'Nouveau record sur ' + mins + ' minutes.' : 'Ton record sur ' + mins + ' minutes : ' + G.record + ' stations.'));
  }
  const grid = el('div', 'linegrid');
  for (const l of LINES) {
    const n = lineCount(l), row = el('div', 'lr'), d = el('span', 'lb', badgeText(l)), tr = el('span', 'track'), f = el('span', 'fill');
    d.style.background = l.c; d.style.color = l.t; f.style.background = l.c; f.style.width = (n / l.st.length * 100) + '%';
    tr.append(f); row.append(d, tr, el('span', '', n + '/' + l.st.length)); grid.append(row);
  }
  out.push(grid);
  const acts = el('div', 'stack');
  const map = el('button', 'btn second', 'Voir la carte complète'); map.type = 'button';
  map.onclick = () => { peek = true; show('end'); };
  acts.append(map);
  if (duel) {
    if (MP.h) { const again = el('button', 'btn primary', 'Nouvelle manche'); again.type = 'button'; again.onclick = newRound; acts.prepend(again); }
    else acts.append(el('p', 'fine', 'La revanche se lance depuis l\'écran de ' + (Opp.name || 'l\'hôte') + '.'));
    const quit = el('button', 'btn quiet', 'Quitter la partie'); quit.type = 'button'; quit.onclick = quitDuel; acts.append(quit);
  } else {
    const again = el('button', 'btn primary', 'Rejouer'); again.type = 'button'; again.onclick = () => startSolo(null);
    const home = el('button', 'btn quiet', 'Retour à l\'accueil'); home.type = 'button'; home.onclick = goHome;
    acts.prepend(again); acts.append(home);
  }
  out.push(acts);
  card.replaceChildren(...out);
}
function goHome() {
  G.on = false; resetBoard(); G.kind = 'solo'; G.dur = soloDur; recompute();
  V.auto = true; resize();
  renderHome(); show('home');
}
function renderHome() {
  const saved = store.get('localStorage', 'md.solo'), r = $('btnResume');
  if (saved && saved.finds && saved.dur * 1000 - saved.elapsed > 5000) {
    r.hidden = false; r.textContent = 'Reprendre (' + saved.finds.length + ' stations, ' + fmt(saved.dur * 1000 - saved.elapsed) + ')';
  } else r.hidden = true;
  const best = store.get('localStorage', 'md.best') || {}, b = $('bestLine');
  if (best[soloDur]) { b.hidden = false; b.textContent = 'Ton record sur ' + Math.round(soloDur / 60) + ' minutes : ' + best[soloDur] + ' stations.'; } else b.hidden = true;
  $('signSub').textContent = N + ' stations · ' + LINES.length + ' lignes · ' + Math.round(soloDur / 60) + ' minutes';
  G.dur = soloDur;
}
$('btnSolo').onclick = () => startSolo(null);
$('btnResume').onclick = () => { const s = store.get('localStorage', 'md.solo'); if (s) startSolo(s); };
seg('soloDur', () => soloDur, v => { soloDur = +v; renderHome(); updateHeader(); });

/* ================= duel en direct ================= */
const Net = { ns: null, state: 'init', room: null, viaLobby: false, unsubs: [], others: new Map(), code: null };
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', CODE_RE = /^[A-HJ-NP-Z2-9]{4}$/;
const MATCH_KEYS = ['c', 'id', 'n', 'h', 'j', 'e', 'd', 'm', 'g', 't0', 'ts', 'f', 'f2', 'k', 'x'];
const findsOf = pr => (typeof pr.f === 'string' ? pr.f : '') + (typeof pr.f2 === 'string' ? pr.f2 : '');
function setFinds(str) { MP.f = str.slice(0, 1000); MP.f2 = str.slice(1000); }
const rnd = (n, abc) => Array.from({ length: n }, () => abc[Math.floor(Math.random() * abc.length)]).join('');
const cleanName = s => Array.from(typeof s === 'string' ? s : '').filter(ch => { const c = ch.codePointAt(0); return c > 31 && !(c >= 127 && c <= 159) && !(c >= 0x200b && c <= 0x200f) && !(c >= 0x2028 && c <= 0x202f) && c !== 0xfeff; }).join('').trim().slice(0, 16) || 'Joueur';
const clampDur = d => [300, 900, 1800, 3600].includes(+d) ? +d : 3600;
function encodeFinds(map) {
  let s = '';
  for (const [i, t] of map) { const u = clamp(t, 0, 262143); s += B64[i >> 6] + B64[i & 63] + B64[(u >> 12) & 63] + B64[(u >> 6) & 63] + B64[u & 63]; }
  return s;
}
function decodeFinds(s) {
  const m = new Map();
  if (typeof s !== 'string' || s.length % 5 || s.length > 5 * N) return m;
  for (let p = 0; p < s.length; p += 5) {
    const v = [0, 1, 2, 3, 4].map(o => B64.indexOf(s[p + o]));
    if (v.some(x => x < 0)) continue;
    const i = v[0] * 64 + v[1];
    if (i < N && !m.has(i)) m.set(i, v[2] * 4096 + v[3] * 64 + v[4]);
  }
  return m;
}
let duelDur = 3600, duelRule = 'course';
const RULE_HELP = { course: 'Course : chacun remplit sa propre carte. Tu vois les stations de l\'adversaire s\'allumer, sans leur nom.', conq: 'Conquête : une station appartient au premier qui la trouve, et son nom s\'affiche pour les deux.' };
seg('duelDur', () => duelDur, v => { duelDur = +v; });
seg('duelRule', () => duelRule, v => { duelRule = v; $('ruleHelp').textContent = RULE_HELP[v]; });
$('ruleHelp').textContent = RULE_HELP.course;
const nick = $('nick');
nick.value = store.get('localStorage', 'md.name') || 'Joueur ' + rnd(2, '23456789');
const myName = () => { const n = cleanName(nick.value); store.set('localStorage', 'md.name', n); return n; };

// Le direct passe par p2p.js (liaison directe entre joueurs) ou par live.js (serveur WebSocket), selon config.js.
const LIVE = window.MetroLive || null;
// en liaison directe, l'accueil (liste des parties ouvertes) ne se relie qu'à l'ouverture de l'écran du duel
let lobbyWanted = false;
function openLobby() { lobbyWanted = true; if (Net.ns && Net.ns.open) Net.ns.open(); }
async function initNet() {
  let ns = null;
  const slow = setTimeout(() => { Net.slow = true; renderDuelMenu(); }, 6000);
  try { if (LIVE) ns = await LIVE.connect(); } catch (e) { ns = null; }
  clearTimeout(slow);
  Net.ns = ns; Net.state = ns ? 'ok' : 'off';
  if (ns) {
    try {
      ns.onPeers(() => { if (screen === 'duel') renderOpenGames(); });
      if (ns.onConnection) ns.onConnection(() => { if (screen === 'duel') renderOpenGames(); });
    } catch (e) {}
    if (lobbyWanted) openLobby();
  }
  renderDuelMenu();
  if (pendingDuel) { const p = pendingDuel; pendingDuel = null; if (ns) resumeDuel(p); else store.set('sessionStorage', 'md.duel', null); }
}
function renderDuelMenu() {
  const m = $('netMsg'), form = $('duelForm');
  if (Net.state === 'init') { m.hidden = false; form.hidden = true; m.textContent = Net.slow ? 'Le serveur du direct se réveille, cela peut prendre une minute…' : 'Connexion au direct…'; }
  else if (Net.state === 'off') { m.hidden = false; form.hidden = true; m.textContent = 'Le direct est indisponible. Recharge la page dans un instant.'; }
  else { m.hidden = true; form.hidden = false; renderOpenGames(); }
}
function openGames() {
  const out = [], seen = new Set();
  if (!Net.ns) return out;
  for (const p of Net.ns.peers()) {
    const pr = p.presence || {};
    if (p.kind !== 'viewer' || (p.isMe && p.sameTab) || typeof pr.w !== 'string' || !CODE_RE.test(pr.w) || seen.has(pr.w)) continue;
    seen.add(pr.w); out.push({ code: pr.w, n: cleanName(pr.wn), d: clampDur(pr.wd), m: pr.wm === 'conq' ? 'conq' : 'course' });
  }
  return out;
}
function renderOpenGames() {
  const box = $('openGames');
  if (Net.ns && Net.ns.connected && !Net.ns.connected()) { box.replaceChildren(el('p', 'fine', 'Recherche des parties ouvertes…')); return; }
  const list = openGames();
  if (!list.length) { box.replaceChildren(el('p', 'fine', 'Aucune partie en attente pour l\'instant. Si quelqu\'un en crée une, elle apparaît ici.')); return; }
  box.replaceChildren(...list.slice(0, 6).map(g => {
    const row = el('div', 'game'), txt = el('div'), b = el('button', 'btn second small', 'Rejoindre');
    txt.append(el('b', '', 'Partie de ' + g.n), document.createTextNode(Math.round(g.d / 60) + ' min · ' + (g.m === 'conq' ? 'Conquête' : 'Course') + ' · ' + g.code));
    b.type = 'button'; b.onclick = () => joinGame(g.code);
    row.append(txt, b); return row;
  }));
}
function advertise() {
  if (!Net.ns) return;
  const open = Net.room && MP.h && !MP.t0 && !(Opp.id && Opp.here);
  const sig = open ? MP.c + MP.n + MP.d + MP.m : '';
  if (sig === Net.adSig) return;
  Net.adSig = sig;
  Net.ns.presence(open ? { w: MP.c, wn: MP.n, wd: MP.d, wm: MP.m } : { w: null, wn: null, wd: null, wm: null }).catch(() => {});
}
function push() {
  if (!Net.room) return;
  MP.ts = Date.now();
  Net.room.presence(Object.assign({}, MP)).catch(() => {});
}
function pushFinds() { setFinds(encodeFinds(G.found)); MP.k = G.found.size; push(); saveDuel(); }
const duelState = () => MP.c ? { mp: Object.assign({}, MP), ended: G.ended } : null;
function saveDuel() { store.set('sessionStorage', 'md.duel', duelState()); }

async function enterRoom(code) {
  await leaveRoom();
  Net.code = code; Net.others = new Map();
  await connectRoom();
}
async function connectRoom() {
  // les liaisons se rétablissent seules (live.js, p2p.js) ; si le salon est refusé, la partie passe par l'accueil
  let r = null;
  try { r = await Net.ns.join('duel-' + Net.code.toLowerCase()); } catch (e) { r = null; }
  Net.viaLobby = !r; Net.room = r || Net.ns;
  Net.unsubs.push(Net.room.onPeers(onPeers));
  if (Net.room.onConnection) Net.unsubs.push(Net.room.onConnection(() => { if (screen === 'lobby') renderLobby(); }));
}
async function leaveRoom() {
  Net.unsubs.forEach(u => { try { u(); } catch (e) {} }); Net.unsubs = [];
  const r = Net.room; Net.room = null; Net.code = null;
  if (r) {
    try {
      if (Net.viaLobby) { const clr = {}; MATCH_KEYS.forEach(k => { clr[k] = null; }); await Net.ns.presence(clr); }
      else await r.leave();
    } catch (e) {}
  }
  for (const k of MATCH_KEYS) delete MP[k];
  advertise();
}
function refreshPeers() { if (Net.room) { try { onPeers({ peers: Net.room.peers() }); } catch (e) {} } }
function onPeers(ch) {
  const here = new Set();
  for (const p of ch.peers) {
    const pr = p.presence;
    if (!pr || p.kind !== 'viewer' || pr.c !== Net.code || typeof pr.id !== 'string' || !pr.id) continue;
    if ((p.isMe && p.sameTab) || pr.id === MP.id) continue;
    let o = Net.others.get(pr.id);
    if (!o) { o = { off: Infinity, at: 0 }; Net.others.set(pr.id, o); }
    if (here.has(pr.id) && o.at > p.updatedAt) continue;
    here.add(pr.id);
    o.pr = pr; o.at = p.updatedAt; o.here = true;
    // écart d'horloge avec ce joueur : le plus petit (réception − émission) observé
    if (typeof pr.ts === 'number' && isFinite(p.updatedAt)) o.off = Math.min(o.off, p.updatedAt - pr.ts);
  }
  for (const [id, o] of Net.others) if (!here.has(id)) o.here = false;
  syncDuel();
}
function syncDuel() {
  if (!Net.room || !MP.c) return;
  const list = [...Net.others.values()].filter(o => o.pr);
  let opp = null, dirty = false;
  if (MP.h) {
    const cur = MP.g ? Net.others.get(MP.g) : null;
    opp = cur && cur.here ? cur : (list.filter(o => o.here && !o.pr.h).sort((a, b) => (a.pr.j || 0) - (b.pr.j || 0))[0] || cur || null);
    const gid = opp ? opp.pr.id : null;
    if (gid !== MP.g) { MP.g = gid; dirty = true; }
  } else {
    opp = list.filter(o => o.pr.h).sort((a, b) => (b.here - a.here) || (b.at - a.at))[0] || null;
    if (opp && opp.here) {
      const hp = opp.pr;
      clearTimeout(joinTimer);
      if (hp.g && hp.g !== MP.id) {
        if (!G.on) { quitDuel().then(() => { show('duel'); joinError('Cette partie est déjà complète.'); }); return; }
      } else {
        const e = +hp.e || 1;
        if (e !== MP.e) { MP.e = e; MP.t0 = 0; MP.f = ''; MP.f2 = ''; MP.k = 0; MP.x = 0; G.on = false; resetBoard(); dirty = true; if (screen !== 'lobby') show('lobby'); }
        const d = clampDur(hp.d), m = hp.m === 'conq' ? 'conq' : 'course';
        if (!MP.t0 && (d !== MP.d || m !== MP.m)) { MP.d = d; MP.m = m; G.dur = d; G.rule = m; dirty = true; }
        if (!MP.t0 && hp.t0 > 0 && hp.g === MP.id && isFinite(opp.off)) { MP.t0 = Math.round(hp.t0 + opp.off); dirty = true; setOpp(opp); beginDuel(); }
      }
    }
  }
  setOpp(opp);
  if (dirty) { push(); saveDuel(); }
  advertise(); updateAll();
}
function setOpp(o) {
  if (!o) { Opp.here = false; if (!G.on) { Opp.id = null; Opp.name = ''; Opp.found = new Map(); Opp.fstr = ''; Opp.x = 0; } recompute(); return; }
  const same = (+o.pr.e || 0) === MP.e, f = same ? findsOf(o.pr) : '';
  Opp.id = o.pr.id; Opp.name = cleanName(o.pr.n); Opp.here = !!o.here; Opp.x = same && o.pr.x ? 1 : 0;
  if (f !== Opp.fstr) {
    const old = Opp.found; Opp.fstr = f; Opp.found = decodeFinds(f);
    if (G.on) {
      let last = -1;
      for (const i of Opp.found.keys()) if (!old.has(i)) { pulses.set(i, { t: performance.now(), c: C.opp }); last = i; }
      if (last >= 0) {
        const box = $('oppBox'); box.classList.remove('bump'); void box.offsetWidth; box.classList.add('bump');
        if (isConq() && !G.ended && !q.value) { recompute(); if (status[last] === 2) fb.replaceChildren(plaqueFor(last, true)); }
      }
    }
  }
  recompute();
}
function beginDuel() {
  G.kind = 'duel'; G.rule = MP.m; G.dur = MP.d; G.t0 = MP.t0; G.pausedAt = 0; G.on = true; G.ended = false; G.reveal = false;
  recompute(); show('play');
}
let joinTimer = 0, pendingDuel = null;
function joinError(t) { const e = $('joinErr'); e.hidden = !t; e.textContent = t || ''; }
async function hostGame() {
  if (!Net.ns) return;
  const code = rnd(4, CODE_ABC);
  await enterRoom(code);
  Object.assign(MP, { c: code, id: rnd(10, B64), n: myName(), h: 1, j: Date.now(), e: 1, d: duelDur, m: duelRule, g: null, t0: 0, f: '', f2: '', k: 0, x: 0 });
  G.on = false; resetBoard(); G.kind = 'duel'; G.rule = MP.m; G.dur = MP.d; Opp.id = null;
  push(); saveDuel(); advertise(); setHash(code); show('lobby'); refreshPeers();
}
async function joinGame(code) {
  if (!Net.ns) return;
  code = String(code || '').toUpperCase().trim();
  if (!CODE_RE.test(code)) return joinError('Le code fait 4 caractères, par exemple K7QF.');
  joinError('');
  await enterRoom(code);
  Object.assign(MP, { c: code, id: rnd(10, B64), n: myName(), h: 0, j: Date.now(), e: 0, d: 3600, m: 'course', g: null, t0: 0, f: '', f2: '', k: 0, x: 0 });
  G.on = false; resetBoard(); G.kind = 'duel'; Opp.id = null;
  push(); saveDuel(); show('lobby'); refreshPeers();
  clearTimeout(joinTimer);
  Net.noHost = false;
  joinTimer = setTimeout(() => { if (screen === 'lobby' && !MP.h && !Opp.id) { Net.noHost = true; renderLobby(); } }, 6000);
}
async function resumeDuel(saved) {
  const mp = saved.mp || {};
  if (!CODE_RE.test(mp.c || '') || !mp.id || (mp.t0 && Date.now() > mp.t0 + clampDur(mp.d) * 1000 + 30 * 60000)) { store.set('sessionStorage', 'md.duel', null); return; }
  await enterRoom(mp.c);
  Object.assign(MP, mp); MP.d = clampDur(MP.d); MP.m = MP.m === 'conq' ? 'conq' : 'course';
  resetBoard(); G.kind = 'duel'; G.rule = MP.m; G.dur = MP.d; G.found = decodeFinds(findsOf(MP)); Opp.id = null;
  push();
  if (MP.t0) { beginDuel(); if (saved.ended || MP.x) { G.ended = true; G.reveal = true; recompute(); endSig = ''; show('end'); } }
  else { G.on = false; show('lobby'); }
  refreshPeers();
}
function launch() {
  if (!MP.h || MP.t0 || !Opp.id || !Opp.here) return;
  MP.t0 = Date.now() + 4000; MP.f = ''; MP.f2 = ''; MP.k = 0; MP.x = 0;
  resetBoardKeepOpp();
  push(); saveDuel(); advertise(); beginDuel();
}
function resetBoardKeepOpp() { const id = Opp.id, n = Opp.name, h = Opp.here; resetBoard(); Opp.id = id; Opp.name = n; Opp.here = h; }
function newRound() {
  if (!MP.h) return;
  MP.e = (MP.e || 1) + 1; MP.t0 = 0; MP.f = ''; MP.f2 = ''; MP.k = 0; MP.x = 0;
  G.on = false; resetBoardKeepOpp(); recompute();
  push(); saveDuel(); show('lobby');
}
async function quitDuel() {
  clearTimeout(joinTimer);
  await leaveRoom();
  store.set('sessionStorage', 'md.duel', null); setHash('');
  Opp.id = null; Opp.name = '';
  goHome();
}
function setHash(code) { try { location.hash = code ? 'duel-' + code.toLowerCase() : ''; } catch (e) {} }
function renderLobby() {
  $('lobbyCode').textContent = MP.c || '----';
  $('lobbyRule').textContent = Math.round((MP.d || 3600) / 60) + ' minutes · ' + (RULE_HELP[MP.m] || RULE_HELP.course);
  const me = el('div', 'pl', MP.n || 'Moi'), box = $('lobbyPlayers'), msg = $('lobbyMsg'), go = $('btnLaunch');
  me.append(el('span', '', MP.h ? 'Hôte · toi' : 'Toi'));
  let other;
  if (Opp.id) { other = el('div', 'pl opp', Opp.name); other.append(el('span', '', Opp.here ? (MP.h ? 'Adversaire' : 'Hôte') : 'Hors ligne')); }
  else other = el('div', 'pl empty', MP.h ? 'En attente d\'un adversaire…' : 'Recherche de la partie…');
  box.replaceChildren(me, other);
  go.hidden = !MP.h; go.disabled = !(Opp.id && Opp.here);
  const linked = !Net.room || !Net.room.connected || Net.room.connected();
  if (!linked && !(Opp.id && Opp.here)) msg.textContent = 'Connexion au direct…';
  else if (MP.h) msg.textContent = Opp.id && Opp.here ? 'Vous êtes deux. Lance la partie quand vous êtes prêts : un décompte de 4 secondes démarre pour les deux.'
    : 'Envoie le lien à ton adversaire avec « Partager le lien ». Il peut aussi ouvrir le site, toucher « Duel 1 contre 1 » et taper le code ci-dessus.';
  else msg.textContent = Opp.id ? (Opp.here ? 'En attente du lancement par ' + Opp.name + '.' : Opp.name + ' est hors ligne pour l\'instant. La partie reprend dès son retour sur la page.')
    : Net.noHost ? 'Personne n\'est connecté sur la partie ' + MP.c + ' pour le moment. Vérifie le code, ou attends que ton adversaire revienne sur la page.' : 'Connexion à la partie…';
}
$('btnDuel').onclick = () => { renderDuelMenu(); show('duel'); };
$('duelBack').onclick = () => show('home');
$('btnHost').onclick = hostGame;
$('joinForm').addEventListener('submit', e => { e.preventDefault(); joinGame($('code').value); });
$('btnLaunch').onclick = launch;
$('lobbyQuit').onclick = quitDuel;
$('copyCode').onclick = () => {
  const b = $('copyCode');
  try { navigator.clipboard.writeText(MP.c || '').then(() => { b.textContent = 'Code copié'; setTimeout(() => { b.textContent = 'Copier le code'; }, 1600); }, () => {}); } catch (e) {}
};

const shareBtn = $('shareLink');
if (shareBtn) {
  shareBtn.hidden = !(navigator.share || navigator.clipboard);
  shareBtn.onclick = () => {
    const link = location.href.split('#')[0] + '#duel-' + String(MP.c || '').toLowerCase();
    const done = () => { shareBtn.textContent = 'Lien copié'; setTimeout(() => { shareBtn.textContent = 'Partager le lien'; }, 1600); };
    if (navigator.share) navigator.share({ title: 'Métro Duel', text: 'Rejoins ma partie de Métro Duel', url: link }).catch(() => {});
    else if (navigator.clipboard) navigator.clipboard.writeText(link).then(done, () => {});
  };
}
// lien d'invitation ouvert dans un onglet déjà chargé
window.addEventListener('hashchange', () => {
  const m = /^#duel-([a-z0-9]{4})$/.exec(location.hash || '');
  if (m && !G.on && screen !== 'lobby') { $('code').value = m[1].toUpperCase(); renderDuelMenu(); show('duel'); }
});

/* ================= démarrage ================= */
function boot() {
  buildChips(); recompute();
  new ResizeObserver(resize).observe(cv.parentElement); resize();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { ST.forEach(s => { s.tw = 0; }); invalidate(); });
  renderHome();
  const m = /^#duel-([a-z0-9]{4})$/.exec(location.hash || '');
  if (m) $('code').value = m[1].toUpperCase();
  const duel = store.get('sessionStorage', 'md.duel');
  if (duel && duel.mp) pendingDuel = duel;
  show(m && !pendingDuel ? 'duel' : 'home');
  setInterval(tick, 200);
  window.addEventListener('pagehide', () => { saveSolo(); if (MP.c) saveDuel(); });
  initNet();
}
boot();
})();
