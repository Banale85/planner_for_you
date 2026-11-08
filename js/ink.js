// Motore di scrittura a mano: penna con pressione, evidenziatore, gomma,
// lazo (seleziona / sposta / ridimensiona), caselle di testo da tastiera e immagini.
// Le coordinate sono normalizzate (0..1) così il disegno si adatta a zoom e schermi diversi.

import { h, toast, popMenu, isIPadOS, scribbleTipOnce } from './ui.js';
import { icon } from './icons.js';
import { uid } from './util.js';

export const PEN_COLORS = ['#1f1f1f', '#1a5fd0', '#d13438', '#107c41', '#7a3fd1', '#e8730c'];
export const HL_COLORS = ['#ffe14d', '#8ef08e', '#8fd9ff', '#ffa3d7', '#ffbe73'];
const LS = 'pfy-tools';

// ---------- Spessori a tappe fisse ----------
// Internamente lo spessore è in millesimi della larghezza della pagina; una pagina A4 è larga 210 mm.
const MM = 1000 / 210, PT = 0.3528 * MM;
const num = x => String(x).replace('.', ',');
const steps = (list, k) => list.map(x => ({ w: Math.round(x * k * 1000) / 1000, label: num(x) }));
export const SIZES = {
  pen: steps([0.2, 0.3, 0.5, 0.7, 1, 1.5, 2], MM),
  highlighter: steps([2, 3, 4, 6, 8], MM),
  text: steps([8, 10, 12, 14, 18, 24], PT),
  eraser: [{ w: 2 * MM, label: 'S', name: 'Piccola' }, { w: 5 * MM, label: 'M', name: 'Media' }, { w: 10 * MM, label: 'L', name: 'Grande' }],
};
const UNIT = { pen: 'mm', highlighter: 'mm', text: 'pt' };
const nearest = (list, w) => list.reduce((b, s, i) => (Math.abs(s.w - w) < Math.abs(list[b].w - w) ? i : b), 0);
// Spessore libero con la barra scorrevole (in mm, a passi di 0,1 mm)
export const RANGE = { pen: [0.1, 10], highlighter: [1, 20] };
const toMM = w => Math.round(w / MM * 10) / 10;
const fromMM = mm => Math.round(mm * MM * 1000) / 1000;
const clampW = (k, w) => fromMM(Math.min(RANGE[k][1], Math.max(RANGE[k][0], toMM(w))));
const mmLabel = w => num(toMM(w)) + ' mm';
const isPreset = (k, w) => SIZES[k].some(s => Math.abs(s.w - w) < 1e-3);
// Barra scorrevole "Dimensione della penna" con l'anteprima del tratto
function sizeSlider(k, w, onInput, title = 'Dimensione della penna') {
  const [lo, hi] = RANGE[k];
  const val = h('span', { class: 'sz-val' }, mmLabel(w));
  const dot = h('i', { class: 'sz-dot' + (k === 'highlighter' ? ' hl' : '') });
  const setDot = mm => { const px = Math.max(2, Math.min(30, mm * 2.4)); dot.style.width = (k === 'highlighter' ? px * 0.55 : px) + 'px'; dot.style.height = px + 'px'; };
  const inp = h('input', { type: 'range', class: 'sz-range', min: lo, max: hi, step: 0.1, value: toMM(w), 'aria-label': title });
  setDot(toMM(w));
  inp.addEventListener('input', () => { const mm = +inp.value; val.textContent = num(mm) + ' mm'; setDot(mm); onInput(fromMM(mm), false); });
  inp.addEventListener('change', () => onInput(fromMM(+inp.value), true));
  return h('div', { class: 'sz-slider' },
    h('div', { class: 'sz-head' }, h('span', {}, title), val),
    h('div', { class: 'sz-row' }, inp, h('span', { class: 'sz-prev' }, dot)));
}

// ---------- Tipi di penna ----------
export const PEN_STYLES = [
  ['fountain', 'Stilografica'],
  ['ball', 'A sfera'],
  ['fine', 'Sottile (fineliner)'],
  ['pencil', 'Matita'],
  ['brush', 'Pennello'],
];

export const emptyInk = () => ({ strokes: [], texts: [], images: [] });
const sid = () => uid().replace(/-/g, '').slice(0, 10);

// Stato condiviso degli strumenti (uguale in tutta l'app, come in Noteful)
export const tools = {
  tool: 'pen',
  penStyle: 'ball',
  eraserMode: 'stroke',          // 'stroke' = cancella il tratto intero, 'partial' = solo la parte toccata
  colors: { pen: '#1f1f1f', highlighter: '#ffe14d' },
  widths: { pen: SIZES.pen[2].w, highlighter: SIZES.highlighter[1].w, eraser: SIZES.eraser[1].w, text: SIZES.text[2].w },
  penOnly: false,
  penSeen: false,
  shapes: false,                 // modalità Forme: ogni tratto diventa una forma perfetta
  _l: new Set(),
  load() {
    try {
      const s = JSON.parse(localStorage.getItem(LS) || '{}');
      for (const k of ['tool', 'penStyle', 'eraserMode', 'penOnly', 'penSeen', 'shapes']) if (k in s) this[k] = s[k];
      if (s.colors) Object.assign(this.colors, s.colors);
      if (s.widths) Object.assign(this.widths, s.widths);
    } catch { /* nessun salvataggio */ }
    // penna ed evidenziatore: spessore libero (barra scorrevole) entro i limiti; gli altri a tappe fisse
    for (const k in SIZES) {
      const w = this.widths[k];
      if (RANGE[k] && Number.isFinite(w)) this.widths[k] = clampW(k, w);
      else this.widths[k] = SIZES[k][nearest(SIZES[k], w || 0)].w;
    }
    document.documentElement.classList.toggle('pen-only', !!this.penOnly);
  },
  set(p) {
    Object.assign(this, p);
    try {
      localStorage.setItem(LS, JSON.stringify({
        tool: this.tool, penStyle: this.penStyle, eraserMode: this.eraserMode, colors: this.colors, widths: this.widths, penOnly: this.penOnly, penSeen: this.penSeen, shapes: this.shapes,
      }));
    } catch { /* ignore */ }
    document.documentElement.classList.toggle('pen-only', !!this.penOnly);
    this._l.forEach(f => f());
  },
  on(f) { this._l.add(f); return () => this._l.delete(f); },
};
tools.load();

// ---------- Tema chiaro / scuro ----------
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
export function isDarkTheme() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : darkMQ.matches;
}
const themeL = new Set();
export const onTheme = f => { themeL.add(f); return () => themeL.delete(f); };
const fireTheme = () => themeL.forEach(f => { try { f(); } catch (e) { console.warn(e); } });
if (darkMQ.addEventListener) darkMQ.addEventListener('change', fireTheme); else if (darkMQ.addListener) darkMQ.addListener(fireTheme);
addEventListener('pfy-theme', fireTheme);

// Come in OneNote: il colore salvato è sempre quello "chiaro"; nel tema scuro viene mostrato
// con la luminosità invertita (il nero diventa bianco) e i colori diventano più accesi.
// La trasformazione è reversibile, così un colore scelto nel tema scuro si salva correttamente.
const GAMMA = 1.45, SAT = 1.12;
function hexToHsl(hex) {
  let x = String(hex).replace('#', '');
  if (x.length === 3) x = x.split('').map(c => c + c).join('');
  const n = parseInt(x.slice(0, 6), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hh *= 60; if (hh < 0) hh += 360;
  return [hh, s, l];
}
function hslToHex(hh, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((hh / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  const to = v => Math.round(Math.min(1, Math.max(0, v + m)) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}
// Nuova luminosità nel tema scuro. I grigi si invertono (nero ↔ bianco); i colori vivaci
// restano su una luminosità media, così diventano più accesi invece che pallidi.
function darkL(l, s) {
  const w = (1 - s) * (1 - s);
  return w * (1 - Math.pow(l, GAMMA)) + (1 - w) * (0.7 - 0.16 * l);
}
const darkCache = new Map();
export function inkColor(c, dark) {
  if (!dark || typeof c !== 'string' || c[0] !== '#') return c;
  let v = darkCache.get(c);
  if (!v) {
    const [hh, s, l] = hexToHsl(c);
    v = hslToHex(hh, Math.min(1, s * SAT), darkL(l, s));
    darkCache.set(c, v);
  }
  return v;
}
// Colore scelto mentre si vede il tema scuro → colore da salvare (inverso di inkColor)
export function inkColorFromDark(c) {
  const [hh, s2, l2] = hexToHsl(c);
  const s = Math.min(1, s2 / SAT);
  let lo = 0, hi = 1;   // darkL scende al crescere di l: ricerca per bisezione
  for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (darkL(m, s) > l2) lo = m; else hi = m; }
  return hslToHex(hh, s, (lo + hi) / 2);
}

const R5 = v => Math.round(v * 1e5) / 1e5;

// ---------- Disegno dei tratti ----------
// Spessore di ogni pezzetto del tratto in base al tipo di penna
const NIB = -Math.PI / 4;   // pennino della stilografica inclinato a 45°
function widthFn(kind, base, n) {
  if (kind === 'fine') return () => Math.max(0.5, base);
  if (kind === 'ball' || kind === 'pencil') return (i, pr) => Math.max(0.5, base * (0.8 + 0.4 * pr));
  if (kind === 'brush') {
    return (i, pr) => {
      const tap = Math.min(1, (i + 1) / 5, (n - i) / 5);
      return Math.max(0.5, base * (0.25 + 1.9 * pr) * (0.3 + 0.7 * tap));
    };
  }
  if (kind === 'fountain') {
    let f = -1;
    return (i, pr, ang) => {
      const t = 0.28 + 0.72 * Math.abs(Math.sin(ang - NIB));
      f = f < 0 ? t : f * 0.55 + t * 0.45;
      return Math.max(0.5, base * 1.5 * f * (0.75 + 0.5 * pr));
    };
  }
  return (i, pr) => Math.max(0.6, base * (0.35 + pr * 1.1));   // tratti creati prima dei tipi di penna
}
function traceStroke(ctx, p, W, H, widthAt) {
  const n = p.length / 3;
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(p[0] * W, p[1] * H, widthAt(0, p[2], 0) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  let px = p[0] * W, py = p[1] * H, mx = px, my = py;
  for (let i = 3; i < p.length; i += 3) {
    const x = p[i] * W, y = p[i + 1] * H;
    const nx = (px + x) / 2, ny = (py + y) / 2;
    ctx.beginPath();
    ctx.moveTo(mx, my);
    ctx.quadraticCurveTo(px, py, nx, ny);
    ctx.lineWidth = widthAt(i / 3, p[i + 2], Math.atan2(y - py, x - px));
    ctx.stroke();
    mx = nx; my = ny; px = x; py = y;
  }
  ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(px, py); ctx.stroke();
}

// Grana della matita: puntini trasparenti sempre uguali, ancorati alla pagina
let grain = null;
function grainCanvas() {
  if (grain) return grain;
  const S = 96, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d'), img = g.createImageData(S, S);
  let seed = 7919;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = rnd() < 0.42 ? Math.round(70 + 185 * rnd()) : 0;
  g.putImageData(img, 0, 0);
  return (grain = c);
}
function drawPencil(ctx, s, W, H, base, color) {
  const p = s.p;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i] * W, y = p[i + 1] * H;
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  const pad = base * 1.3 + 2;
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const sc = ctx.getTransform ? ctx.getTransform().a || 1 : 1;
  const cw = Math.max(1, Math.ceil((x1 - x0) * sc)), ch = Math.max(1, Math.ceil((y1 - y0) * sc));
  const widthAt = widthFn('pencil', base, p.length / 3);
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = ctx.fillStyle = color;
  if (cw * ch > 16e6) { ctx.globalAlpha = 0.75; traceStroke(ctx, p, W, H, widthAt); ctx.restore(); return; }
  const off = document.createElement('canvas');
  off.width = cw; off.height = ch;
  const o = off.getContext('2d');
  o.setTransform(sc, 0, 0, sc, -x0 * sc, -y0 * sc);
  o.lineCap = 'round'; o.lineJoin = 'round'; o.strokeStyle = o.fillStyle = color;
  traceStroke(o, p, W, H, widthAt);
  o.setTransform(1, 0, 0, 1, 0, 0);
  o.globalCompositeOperation = 'destination-out';
  const pat = o.createPattern(grainCanvas(), 'repeat');
  if (pat.setTransform && typeof DOMMatrix !== 'undefined') pat.setTransform(new DOMMatrix([1, 0, 0, 1, -x0 * sc, -y0 * sc]));
  o.fillStyle = pat;
  o.fillRect(0, 0, cw, ch);
  ctx.globalAlpha = 0.9;
  ctx.drawImage(off, x0, y0, cw / sc, ch / sc);
  ctx.restore();
}

// Disegna un tratto. p = [x, y, pressione, x, y, pressione, ...] normalizzati.
// dark = la superficie è mostrata nel tema scuro (i colori vengono adattati).
export function drawStroke(ctx, s, W, H, dark = false) {
  const p = s.p, n = p.length / 3;
  if (!n && !s.g) return;
  const base = s.w * W / 1000;
  // forme: disegnate dalla geometria (spessore uniforme, tratteggio, frecce)
  if (s.g) {
    ctx.save();
    if (s.t === 'hl') { ctx.globalAlpha = dark ? 0.32 : 0.38; ctx.globalCompositeOperation = dark ? 'source-over' : 'multiply'; }
    drawShape(ctx, s, W, H, s.t === 'hl' ? s.c : inkColor(s.c, dark), base);
    ctx.restore();
    return;
  }
  if (s.t === 'hl') {
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = s.c;
    ctx.globalAlpha = dark ? 0.32 : 0.38;
    ctx.globalCompositeOperation = dark ? 'source-over' : 'multiply';
    ctx.lineWidth = base;
    ctx.beginPath();
    ctx.moveTo(p[0] * W, p[1] * H);
    if (n === 1) ctx.lineTo(p[0] * W + 0.1, p[1] * H);
    for (let i = 3; i < p.length; i += 3) ctx.lineTo(p[i] * W, p[i + 1] * H);
    ctx.stroke();
    ctx.restore();
    return;
  }
  const color = inkColor(s.c, dark);
  if (s.k === 'pencil') { drawPencil(ctx, s, W, H, base, color); return; }
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = ctx.fillStyle = color;
  traceStroke(ctx, p, W, H, widthFn(s.k, base, n));
  ctx.restore();
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const bbCache = new WeakMap();
function strokeBB(s) {
  let b = bbCache.get(s);
  if (!b) {
    b = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < s.p.length; i += 3) {
      const x = s.p[i], y = s.p[i + 1];
      if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
    }
    bbCache.set(s, b);
  }
  return b;
}

// ---------- Forme ----------
// Una forma è un tratto con in più la sua geometria s.g, così resta modificabile:
//   s.g = { type: 'poly' | 'ellipse' | 'arc', pts: [x0, y0, x1, y1, ...] (normalizzati come s.p),
//           closed, arrow (1 = punta alla fine, 2 = all'inizio, 3 = entrambe), dash: 'solid' | 'dash' | 'dot', name }
//   poly: i vertici · ellipse: [centro, estremo del 1° raggio, estremo del 2° raggio] · arc: [inizio, controllo, fine]
// s.p contiene comunque i punti del contorno: gomma, lazo, miniature e sincronizzazione funzionano come per gli altri tratti.
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToSeg(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
// toglie i vertici dove il contorno quasi non gira (poligono chiuso)
function dropFlat(poly) {
  let changed = true;
  while (changed && poly.length > 3) {
    changed = false;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[(i - 1 + poly.length) % poly.length], b = poly[i], c = poly[(i + 1) % poly.length];
      const t = Math.abs(Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]));
      if (Math.min(t, 2 * Math.PI - t) < 0.45) { poly.splice(i, 1); changed = true; break; }
    }
  }
  return poly;
}
// Le linee si bloccano ogni 45° (0°, 45°, 90°…) quando ci si avvicina
const SNAP45 = 0.1;
function snapLine(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
  const step = Math.PI / 4, near = Math.round(ang / step) * step;
  if (Math.abs(ang - near) < SNAP45) return [a[0] + Math.cos(near) * len, a[1] + Math.sin(near) * len];
  return b;
}
// Toglie i punti troppo vicini: la Apple Pencil ferma "trema" e allungherebbe il tratto
function resample(pts, d = 3) {
  const o = [pts[0]];
  for (const p of pts) if (dist(p, o[o.length - 1]) >= d) o.push(p);
  const last = pts[pts.length - 1];
  if (o.length > 1 && dist(o[o.length - 1], last) < d) o[o.length - 1] = last; else if (o[o.length - 1] !== last) o.push(last);
  return o;
}
const maxDev = (pts, a, b) => pts.reduce((m, p) => Math.max(m, distToSeg(p[0], p[1], a[0], a[1], b[0], b[1])), 0);
const pathLen = pts => { let L = 0; for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]); return L; };
const quad = (p0, q, p1, t) => [(1 - t) * (1 - t) * p0[0] + 2 * (1 - t) * t * q[0] + t * t * p1[0], (1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * q[1] + t * t * p1[1]];
function devFromPolyline(pts, line) {
  let m = 0;
  for (const p of pts) {
    let best = Infinity;
    for (let i = 1; i < line.length; i++) best = Math.min(best, distToSeg(p[0], p[1], line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]));
    m = Math.max(m, best);
  }
  return m;
}
// punto a metà del percorso
function midByLength(pts) {
  const half = pathLen(pts) / 2;
  let L = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = dist(pts[i - 1], pts[i]);
    if (L + l >= half) { const t = (half - L) / (l || 1); return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]; }
    L += l;
  }
  return pts[pts.length - 1];
}
// linea dritta o arco (curva) per un tratto aperto
function fitOpen(pts) {
  const a = pts[0], b = pts[pts.length - 1], d = dist(a, b);
  if (d > 12 && maxDev(pts, a, b) <= Math.max(5, d * 0.06)) return { name: 'line', type: 'poly', pts: [a, snapLine(a, b)], closed: false };
  if (d < 12) return null;
  const m = midByLength(pts), sag = distToSeg(m[0], m[1], a[0], a[1], b[0], b[1]);
  if (sag < Math.max(5, d * 0.06)) return null;
  const q = [2 * m[0] - (a[0] + b[0]) / 2, 2 * m[1] - (a[1] + b[1]) / 2];
  const curve = Array.from({ length: 41 }, (_, i) => quad(a, q, b, i / 40));
  if (devFromPolyline(pts, curve) <= Math.max(5, 0.08 * Math.max(d, sag * 2))) return { name: 'arc', type: 'arc', pts: [a, q, b], closed: false };
  return null;
}
// freccia disegnata in un solo tratto: asta (dritta o curva) e punta alla fine
function fitArrow(pts, diag) {
  const v = rdp(pts, Math.max(4, diag * 0.05));
  if (v.length < 3) return null;
  for (let k = 1; k < v.length - 1; k++) {
    const tip = v[k], ti = pts.indexOf(tip);
    const shaft = pts.slice(0, ti + 1), sl = pathLen(shaft);
    const head = v.slice(k + 1), hs = Math.max(...head.map(p => dist(p, tip)));
    if (hs < Math.max(9, sl * 0.04) || hs > sl * 0.5) continue;
    // la punta torna indietro rispetto all'asta
    const back = shaft[Math.max(0, shaft.length - 4)];
    const a1 = Math.atan2(tip[1] - back[1], tip[0] - back[0]), a2 = Math.atan2(v[k + 1][1] - tip[1], v[k + 1][0] - tip[0]);
    let turn = Math.abs(a1 - a2); turn = Math.min(turn, 2 * Math.PI - turn);
    if (turn < 1.9) continue;
    const s = fitOpen(shaft);
    if (s) return { ...s, name: s.type === 'arc' ? 'arrowArc' : 'arrow', arrow: 1 };
  }
  return null;
}
// Riconosce la forma di un tratto (punti in pixel). Restituisce { name, type, pts (pixel), closed, arrow } o null.
export function recognizeShape(raw) {
  if (raw.length < 2) return null;
  const pts = resample(raw, 3);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  const w = x1 - x0, hgt = y1 - y0, diag = Math.hypot(w, hgt);
  if (diag < 12 || pts.length < 2) return null;
  const a = pts[0], b = pts[pts.length - 1], d = dist(a, b);
  if (d > 12 && maxDev(pts, a, b) <= Math.max(5, d * 0.06)) return { name: 'line', type: 'poly', pts: [a, snapLine(a, b)], closed: false };
  const closed = d < Math.max(18, 0.22 * diag) && pathLen(pts) > 2.5 * Math.max(d, 1);
  if (!closed) {
    const arrow = fitArrow(pts, diag);
    if (arrow) return arrow;
    const open = fitOpen(pts);
    if (open) return open;
    // spezzata (es. un angolo o uno zig-zag): pochi tratti dritti
    const v = rdp(pts, Math.max(4, diag * 0.04));
    if (v.length >= 3 && v.length <= 5) return { name: 'polyline', type: 'poly', pts: v, closed: false };
    return null;
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.max(w / 2, 1), ry = Math.max(hgt / 2, 1);
  let err = 0;
  for (const [x, y] of pts) err += Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1);
  err /= pts.length;
  const ellipse = () => {
    let erx = rx, ery = ry;
    if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.2) erx = ery = (rx + ry) / 2;   // quasi tondo → cerchio
    return { name: erx === ery ? 'circle' : 'ellipse', type: 'ellipse', pts: [[cx, cy], [cx + erx, cy], [cx, cy + ery]], closed: true };
  };
  if (err < 0.1) return ellipse();
  let poly = rdp(pts, Math.max(5, diag * 0.08));
  if (poly.length > 2 && dist(poly[0], poly[poly.length - 1]) < Math.max(18, 0.25 * diag)) poly.pop();
  poly = dropFlat(poly);
  if (poly.length === 3) return { name: 'triangle', type: 'poly', pts: poly, closed: true };
  if (poly.length === 4) {
    // lati quasi orizzontali/verticali → rettangolo perfetto
    const axis = poly.every((p, i) => {
      const q = poly[(i + 1) % 4], ang = Math.abs(Math.atan2(q[1] - p[1], q[0] - p[0])) % (Math.PI / 2);
      return Math.min(ang, Math.PI / 2 - ang) < 0.26;
    });
    return { name: 'rect', type: 'poly', pts: axis ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] : poly, closed: true };
  }
  if (poly.length >= 5 && poly.length <= 8 && err > 0.14) return { name: 'polygon', type: 'poly', pts: poly, closed: true };
  if (err < 0.2) return ellipse();
  return null;
}
export const SHAPE_NAMES = { line: 'Linea', arrow: 'Freccia', arc: 'Arco', arrowArc: 'Freccia curva', polyline: 'Spezzata', circle: 'Cerchio', ellipse: 'Ellisse', triangle: 'Triangolo', rect: 'Rettangolo', polygon: 'Poligono' };

// geometria ↔ pixel
const gPts = (g, W, H) => { const o = []; for (let i = 0; i < g.pts.length; i += 2) o.push([g.pts[i] * W, g.pts[i + 1] * H]); return o; };
const gSet = (g, pts, W, H) => { g.pts = []; for (const [x, y] of pts) g.pts.push(R5(x / W), R5(y / H)); };
export function makeGeom(sh, W, H) {
  const g = { type: sh.type, pts: [], closed: !!sh.closed, arrow: sh.arrow || 0, dash: 'solid', name: sh.name };
  gSet(g, sh.pts, W, H);
  return g;
}
// contorno della forma in pixel
function outline(g, W, H) {
  const v = gPts(g, W, H);
  if (g.type === 'ellipse') {
    const [c, a, b] = v, ux = a[0] - c[0], uy = a[1] - c[1], vx = b[0] - c[0], vy = b[1] - c[1];
    const n = Math.max(48, Math.round((Math.hypot(ux, uy) + Math.hypot(vx, vy)) * Math.PI / 4));
    const o = [];
    for (let i = 0; i <= n; i++) { const t = i / n * 2 * Math.PI; o.push([c[0] + ux * Math.cos(t) + vx * Math.sin(t), c[1] + uy * Math.cos(t) + vy * Math.sin(t)]); }
    return o;
  }
  if (g.type === 'arc') {
    const [p0, q, p1] = v, n = Math.max(16, Math.round((dist(p0, q) + dist(q, p1)) / 4));
    return Array.from({ length: n + 1 }, (_, i) => quad(p0, q, p1, i / n));
  }
  return g.closed && v.length > 2 ? [...v, v[0]] : v;
}
function densify(pts, step = 3) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) out.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n]);
  }
  return out;
}
// rigenera i punti del tratto dalla geometria
export function shapeSync(s, W, H) {
  s.p = [];
  for (const [x, y] of densify(outline(s.g, W, H))) s.p.push(R5(x / W), R5(y / H), 0.5);
  bbCache.delete(s);
}
// punto lungo il contorno a distanza L dall'estremità (per orientare la punta della freccia)
function backPoint(o, fromEnd, L) {
  const seq = fromEnd ? o.slice().reverse() : o;
  let acc = 0;
  for (let i = 1; i < seq.length; i++) { acc += dist(seq[i - 1], seq[i]); if (acc >= L) return seq[i]; }
  return seq[seq.length - 1];
}
// spessore medio di ogni tipo di penna (per tratteggi e punte delle frecce)
const STYLE_W = { fountain: 1.05, ball: 1, fine: 0.9, pencil: 1, brush: 1.25 };
function drawShape(ctx, s, W, H, color, base) {
  const g = s.g, o = outline(g, W, H);
  if (o.length < 2) return;
  const lw = Math.max(0.6, base * (s.t === 'hl' ? 1 : STYLE_W[s.k] || 1));
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = lw; ctx.strokeStyle = ctx.fillStyle = color;
  const solid = !g.dash || g.dash === 'solid';
  if (solid && s.t !== 'hl' && s.p.length >= 6) {
    // linea continua: disegnata come la penna usata (stilografica, matita, pennello…)
    if (s.k === 'pencil') { ctx.save(); drawPencil(ctx, s, W, H, base, color); ctx.restore(); }
    // pennello su forme chiuse: senza assottigliare inizio e fine, altrimenti resterebbe un buco
    else if (g.closed && s.k === 'brush') traceStroke(ctx, s.p, W, H, (i, pr) => Math.max(0.5, base * (0.25 + 1.9 * pr)));
    else traceStroke(ctx, s.p, W, H, widthFn(s.k, base, s.p.length / 3));
    ctx.lineWidth = lw;
  } else {
    if (g.dash === 'dash') ctx.setLineDash([lw * 2.5 + 4, lw * 1.8 + 4]);
    else if (g.dash === 'dot') ctx.setLineDash([0.01, lw * 1.8 + 3]);
    ctx.beginPath(); ctx.moveTo(o[0][0], o[0][1]);
    for (let i = 1; i < o.length; i++) ctx.lineTo(o[i][0], o[i][1]);
    if (g.closed) ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (!g.closed && g.arrow) {
    const L = Math.max(10, lw * 4);
    const headAt = (tip, from) => {
      const ang = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
      ctx.beginPath();
      ctx.moveTo(tip[0] - L * Math.cos(ang - 0.45), tip[1] - L * Math.sin(ang - 0.45));
      ctx.lineTo(tip[0], tip[1]);
      ctx.lineTo(tip[0] - L * Math.cos(ang + 0.45), tip[1] - L * Math.sin(ang + 0.45));
      ctx.stroke();
    };
    if (g.arrow & 1) headAt(o[o.length - 1], backPoint(o, true, L));
    if (g.arrow & 2) headAt(o[0], backPoint(o, false, L));
  }
}

// Appunti interni per Taglia / Copia / Incolla (valgono tra pagine, quaderni e calendario)
let clip = null;
export const hasClip = () => !!clip;

export class InkSurface {
  static active = null;

  constructor(el, opts = {}) {
    this.el = el;
    this.data = opts.data || emptyInk();
    for (const k of ['strokes', 'texts', 'images']) if (!Array.isArray(this.data[k])) this.data[k] = [];
    this.onChange = opts.onChange || (() => {});
    this.drawBackground = opts.drawBackground || null;
    this.loadFile = opts.loadFile || null;
    this.enabled = opts.enabled || (() => true);
    // themed: la superficie segue il tema (carta scura e colori adattati). No per i PDF, che restano chiari.
    this.themed = opts.themed !== false;
    // adaptText: anche le caselle di testo cambiano colore col tema (no se hanno uno sfondo sempre chiaro)
    this.adaptText = opts.adaptText !== false;
    this.visible = true;
    this.rendered = false;
    this.undoStack = [];
    this.redoStack = [];
    this.sel = null;
    this.gesture = null;
    this._bgTok = 0;
    this._d = 1;

    el.classList.add('ink-surface');
    if (this.drawBackground) { this.bg = h('canvas', { class: 'ink-bg' }); el.append(this.bg); }
    this.imgLayer = h('div', { class: 'ink-layer ink-imgs' });
    this.cv = h('canvas', { class: 'ink-main' + (opts.blend ? ' blend' : '') });
    this.txtLayer = h('div', { class: 'ink-layer ink-txt' });
    this.live = h('canvas', { class: 'ink-live' });
    el.append(this.imgLayer, this.cv, this.txtLayer, this.live);

    for (const n of ['_down', '_move', '_up', '_cancel']) this[n] = this[n].bind(this);
    this.live.addEventListener('pointerdown', this._down);
    this.live.addEventListener('pointermove', this._move);
    this.live.addEventListener('pointerup', this._up);
    this.live.addEventListener('pointercancel', this._cancel);
    // iPad: impedisce che la Apple Pencil faccia scorrere la pagina
    // (non con lo strumento Mano, che serve proprio a scorrere anche con la penna)
    const stylusGuard = e => {
      if (!this.enabled() || tools.tool === 'hand') return;
      for (const t of e.changedTouches) if (t.touchType === 'stylus') { e.preventDefault(); return; }
    };
    this.live.addEventListener('touchstart', stylusGuard, { passive: false });
    this.live.addEventListener('touchmove', stylusGuard, { passive: false });
    // Tocco con 2 dita = Annulla, con 3 dita = Ripeti (come in Noteful/GoodNotes)
    this._mt = null;
    const fingers = e => [...e.touches].filter(t => t.touchType !== 'stylus');
    this._mtStart = e => {
      if (!this.enabled()) return;
      const f = fingers(e);
      if (!f.length) return;
      if (!this._mt) this._mt = { t: Date.now(), max: 0, pos: new Map(), bad: false };
      const m = this._mt;
      for (const t of f) if (!m.pos.has(t.identifier)) m.pos.set(t.identifier, [t.clientX, t.clientY]);
      m.max = Math.max(m.max, f.length);
    };
    this._mtMove = e => {
      const m = this._mt;
      if (!m) return;
      for (const t of e.touches) { const p = m.pos.get(t.identifier); if (p && Math.hypot(t.clientX - p[0], t.clientY - p[1]) > 14) m.bad = true; }
    };
    this._mtEnd = e => {
      const m = this._mt;
      if (!m || fingers(e).length) return;   // aspetta che si alzino tutte le dita
      this._mt = null;
      if (m.bad || Date.now() - m.t > 450 || m.max < 2 || m.max > 3) return;
      const s = InkSurface.active && InkSurface.active.el.isConnected ? InkSurface.active : this;
      if (m.max === 2) toast(s.undo() ? 'Annullato' : 'Niente da annullare', { ms: 900 });
      else toast(s.redo() ? 'Ripristinato' : 'Niente da ripristinare', { ms: 900 });
    };
    el.addEventListener('touchstart', this._mtStart, { passive: true });
    el.addEventListener('touchmove', this._mtMove, { passive: true });
    el.addEventListener('touchend', this._mtEnd, { passive: true });
    el.addEventListener('touchcancel', this._mtEnd, { passive: true });
    this.txtLayer.addEventListener('click', e => this._textClick(e));
    // maniglia per trascinare la casella di testo in modifica
    this.textHandle = h('div', { class: 'ink-text-handle', title: 'Trascina per spostare il testo', 'aria-label': 'Sposta il testo', hidden: true }, icon('move'));
    this.textHandle.addEventListener('pointerdown', e => this._dragText(e));
    el.append(this.textHandle);

    this.rebuildObjects();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.unsub = tools.on(() => this.updateMode());
    this.unTheme = onTheme(() => this.applyTheme());
    el.classList.toggle('dark', this.dark);
    this.updateMode();
  }

  get dark() { return this.themed && isDarkTheme(); }
  applyTheme() {
    this.el.classList.toggle('dark', this.dark);
    this.layoutObjects();
    if (this.visible && this.rendered) this.renderAll();
  }

  // ---------- dimensioni e disegno ----------
  resize() {
    const W = this.el.clientWidth, H = this.el.clientHeight;
    if (!W || !H) return;
    const changed = W !== this.W || H !== this.H;
    this.W = W; this.H = H;
    this.layoutObjects();
    if (!this.visible || (!changed && this.rendered)) return;
    clearTimeout(this._rt);
    if (!this.rendered) this.renderAll();
    else this._rt = setTimeout(() => this.renderAll(), 120);
  }
  dpr() {
    const d = Math.min(window.devicePixelRatio || 1, 3);
    return Math.min(d, Math.sqrt(14e6 / (this.W * this.H)));
  }
  sizeCanvas(c) {
    const d = this._d;
    const w = Math.max(1, Math.round(this.W * d)), hh = Math.max(1, Math.round(this.H * d));
    if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; }
    const ctx = c.getContext('2d');
    ctx.setTransform(d, 0, 0, d, 0, 0);
    return ctx;
  }
  renderAll() {
    if (!this.W || !this.visible) return;
    this._d = this.dpr();
    this.rendered = true;
    this.renderBg();
    this.renderStrokes();
    this.clearLive();
    if (this.sel) this.drawSel();
    if (this.shapeSel) { this.drawShapeSel(); this.showShapeMenu(); }
  }
  renderBg() {
    if (!this.drawBackground) return;
    const tok = ++this._bgTok, W = this.W, H = this.H;
    const paint = src => {
      if (tok !== this._bgTok || !this.visible || !src) return;
      const ctx = this.sizeCanvas(this.bg);
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(src, 0, 0, W, H);
    };
    let r;
    try { r = this.drawBackground(W, H, this._d, this.dark); } catch (e) { console.warn(e); return; }
    if (r && typeof r.then === 'function') r.then(paint, e => console.warn(e));
    else paint(r);
  }
  refreshBackground() { if (this.visible && this.rendered) this.renderBg(); }
  renderStrokes() {
    if (!this.rendered) return;
    const ctx = this.sizeCanvas(this.cv);
    ctx.clearRect(0, 0, this.W, this.H);
    const dark = this.dark;
    for (const s of this.data.strokes) drawStroke(ctx, s, this.W, this.H, dark);
  }
  clearLive() {
    if (!this.rendered) return;
    const ctx = this.sizeCanvas(this.live);
    ctx.clearRect(0, 0, this.W, this.H);
  }
  setVisible(v) {
    if (v === this.visible) return;
    this.visible = v;
    this.rendered = false;
    if (v) this.renderAll();
    else {
      // libera memoria per le pagine fuori schermo
      ++this._bgTok;
      for (const c of [this.bg, this.cv, this.live]) if (c) { c.width = 1; c.height = 1; }
    }
  }

  updateMode() {
    const on = this.enabled();
    this.el.classList.toggle('ink-off', !on);
    this.el.dataset.tool = tools.tool;
    const editable = on && tools.tool === 'text';
    for (const el of this.txtLayer.children) el.contentEditable = editable ? 'true' : 'false';
    if (!editable && this._editing) this._editing.blur();
    if (this.sel && (!on || tools.tool !== 'lasso')) this.clearSel();
    if (this.shapeSel && (!on || !['pen', 'highlighter', 'lasso'].includes(tools.tool))) this.clearShapeSel();
    // colore o spessore scelti nella barra mentre una forma è selezionata: si applicano alla forma
    const key = [tools.colors.pen, tools.colors.highlighter, tools.widths.pen, tools.widths.highlighter].join('|');
    if (this._toolKey && key !== this._toolKey && this.shapeSel) {
      const s = this.shapeSel, k = s.t === 'hl' ? 'highlighter' : 'pen';
      if (s.c !== tools.colors[k] || s.w !== tools.widths[k]) this.editShape(() => { s.c = tools.colors[k]; s.w = tools.widths[k]; });
    }
    this._toolKey = key;
  }

  // ---------- input ----------
  norm(e) {
    const r = this._rect;
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  }
  addPt(x, y, e) {
    const p = this.cur.p, n = p.length;
    if (n && Math.hypot((p[n - 3] - x) * this.W, (p[n - 2] - y) * this.H) < 0.5) return;
    const pr = e.pointerType === 'pen' ? (e.pressure > 0 ? e.pressure : 0.5) : 0.5;
    p.push(R5(x), R5(y), Math.round(pr * 100) / 100);
  }
  _down(e) {
    if (this.gesture) {
      // secondo dito durante un tratto col dito: è un gesto (zoom/scroll), annulla il tratto
      if (e.pointerType === 'touch') this.cancelGesture();
      return;
    }
    if (!this.enabled()) return;
    this.hidePasteMenu();
    this._t0 = Date.now();
    if (e.pointerType === 'pen' && !tools.penSeen) {
      tools.set({ penSeen: true, penOnly: true });
      if (!isIPadOS()) toast('Penna rilevata: ora la penna scrive e il dito scorre la pagina.');
    }
    // su iPad, al primo uso della penna: consiglio su Scribble (una volta sola)
    if (e.pointerType === 'pen' && isIPadOS() && scribbleTipOnce()) return;
    // Mano: dito e penna scorrono la pagina (lo fa il browser); col mouse si trascina
    if (tools.tool === 'hand') { if (e.pointerType === 'mouse' && e.button === 0) this.startPan(e); return; }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // forma selezionata: maniglie e contorno si possono trascinare con penna, mouse o dito
    if (this.shapeSel) {
      if (!this.data.strokes.includes(this.shapeSel)) this.clearShapeSel();
      else {
        this._rect = this.live.getBoundingClientRect();
        const [sx, sy] = this.norm(e);
        const hit = this.shapeHit(sx * this.W, sy * this.H, e.pointerType === 'touch' ? 20 : 14);
        if (hit) {
          e.preventDefault();
          try { this.live.setPointerCapture(e.pointerId); } catch { /* ignore */ }
          this.pid = e.pointerId;
          InkSurface.active = this;
          this.startShapeDrag(hit, sx * this.W, sy * this.H);
          return;
        }
        if (e.pointerType === 'touch' && tools.penOnly) return;   // il dito scorre senza togliere la selezione
        this.clearShapeSel();
      }
    }
    if (e.pointerType === 'touch' && tools.penOnly) return;
    if (!this.rendered) { this.visible = true; this.renderAll(); }
    InkSurface.active = this;
    this._rect = this.live.getBoundingClientRect();
    const [x, y] = this.norm(e);
    const tool = tools.tool;
    e.preventDefault();
    try { this.live.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.pid = e.pointerId;

    if (tool === 'pen' || tool === 'highlighter') {
      this.cur = { id: sid(), t: tool === 'pen' ? 'pen' : 'hl', c: tools.colors[tool], w: tools.widths[tool], p: [] };
      if (tool === 'pen') this.cur.k = tools.penStyle;
      this.addPt(x, y, e);
      this.gesture = 'draw';
      this._shape = null;
      this._holdAt = [e.clientX, e.clientY];
      this.armHold();
      this.paintLive();
    } else if (tool === 'eraser') {
      this.gesture = 'erase';
      this._before = this.snap();
      this._erased = false;
      this.eraseAt(x, y);
    } else if (tool === 'lasso') {
      const px = x * this.W, py = y * this.H;
      if (this.sel) {
        const b = this.selBoxPx();
        if (Math.hypot(px - b.x2, py - b.y2) < 20) {
          this.gesture = 'scale'; this._before = this.snap(); this.hideSelMenu(); this.startScale(px, py); return;
        }
        if (px >= b.x1 && px <= b.x2 && py >= b.y1 && py <= b.y2) {
          this.gesture = 'move'; this._before = this.snap(); this._last = [x, y]; this.hideSelMenu(); return;
        }
        this.clearSel();
      }
      this.gesture = 'lasso';
      this.lasso = [px, py];
    }
  }
  _move(e) {
    if (!this.gesture || e.pointerId !== this.pid) return;
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    const evs = list && list.length ? list : [e];
    const g = this.gesture;
    if (g === 'draw') {
      // forma già riconosciuta e penna ancora giù: muovendo la penna la si allunga e ruota
      if (this._shape) { const [x, y] = this.norm(e); this.adjustHeldShape(x * this.W, y * this.H); return; }
      for (const ev of evs) { const [x, y] = this.norm(ev); this.addPt(x, y, ev); }
      // ci si è mossi: ricomincia ad aspettare la pausa che trasforma il tratto in forma
      if (Math.hypot(e.clientX - this._holdAt[0], e.clientY - this._holdAt[1]) > 5) { this._holdAt = [e.clientX, e.clientY]; this.armHold(); }
      this.paintLive();
    }
    else if (g === 'erase') { for (const ev of evs) { const [x, y] = this.norm(ev); this.eraseAt(x, y); } }
    else if (g === 'lasso') { for (const ev of evs) { const [x, y] = this.norm(ev); this.lasso.push(x * this.W, y * this.H); } this.paintLasso(); }
    else if (g === 'move') { const [x, y] = this.norm(e); this.translateSel(x - this._last[0], y - this._last[1]); this._last = [x, y]; }
    else if (g === 'scale') { const [x, y] = this.norm(e); this.doScale(x * this.W, y * this.H); }
    else if (g === 'shape') { const [x, y] = this.norm(e); this.shapeDrag(x * this.W, y * this.H); }
  }
  _up(e) {
    if (e.pointerId !== this.pid || !this.gesture) return;
    const g = this.gesture;
    this.gesture = null;
    if (g === 'draw') {
      clearTimeout(this._ht);
      // modalità Forme: ogni tratto riconosciuto diventa una forma perfetta
      if (!this._shape && tools.shapes && this.cur) { const sh = recognizeShape(this.strokePx()); if (sh) this.setShape(sh); }
      this._shape = null;
      const s = this.cur;
      this.cur = null;
      cancelAnimationFrame(this._lr); this._lr = 0;
      this.clearLive();
      // tocco veloce con la penna sul contorno di una forma: la seleziona invece di fare un puntino
      if (s && !s.g && Date.now() - this._t0 < 350) {
        const b = strokeBB(s);
        if ((b[2] - b[0]) * this.W < 6 && (b[3] - b[1]) * this.H < 6) {
          const shape = this.shapeAt(s.p[0] * this.W, s.p[1] * this.H);
          if (shape) { this.selectShape(shape); return; }
        }
      }
      if (s && s.p.length) {
        this.pushUndo(this.snap());
        this.data.strokes.push(s);
        drawStroke(this.sizeCanvas(this.cv), s, this.W, this.H, this.dark);
        this.emit();
        // la forma appena creata resta selezionata, pronta da modificare
        if (s.g) this.selectShape(s);
      }
    } else if (g === 'erase') {
      this.clearLive();
      if (this._erased) this.emit();
    } else if (g === 'lasso') {
      this.finishLasso();
    } else if (g === 'move' || g === 'scale') {
      if (this._before !== this.snap()) { this.pushUndo(this._before); this.emit(); }
      this.drawSel();
      this.showSelMenu();
    } else if (g === 'shape') this.endShapeDrag();
  }
  _cancel(e) { if (e.pointerId === this.pid) this.cancelGesture(); }
  cancelGesture() {
    const g = this.gesture;
    this.gesture = null;
    clearTimeout(this._ht); this._shape = null;
    if (g === 'draw') { this.cur = null; cancelAnimationFrame(this._lr); this._lr = 0; this.clearLive(); }
    else if (g === 'lasso') { this.lasso = null; this.clearLive(); }
    else if (g === 'erase') { this.clearLive(); if (this._erased) this.emit(); }
    else if (g === 'move' || g === 'scale') { if (this._before !== this.snap()) { this.pushUndo(this._before); this.emit(); } this.drawSel(); this.showSelMenu(); }
    else if (g === 'shape') this.endShapeDrag();
  }
  // Tieni ferma la penna alla fine del tratto → diventa linea dritta o forma
  armHold() {
    clearTimeout(this._ht);
    this._ht = setTimeout(() => {
      if (this.gesture !== 'draw' || !this.cur || this._shape) return;
      const sh = recognizeShape(this.strokePx());
      if (!sh) return;
      const last = this.cur.p.length - 3;
      // da qui in poi muovere la penna allunga/ruota la forma attorno al suo punto di partenza
      this._shape = { sh, orig: sh.pts.map(p => p.slice()), anchor: sh.pts[0].slice(), from: [this.cur.p[last] * this.W, this.cur.p[last + 1] * this.H] };
      this.setShape(sh);
      try { navigator.vibrate && navigator.vibrate(10); } catch { /* ignore */ }
    }, 450);
  }
  strokePx() {
    const p = this.cur.p, out = [];
    for (let i = 0; i < p.length; i += 3) out.push([p[i] * this.W, p[i + 1] * this.H]);
    return out;
  }
  setShape(sh) {
    this.cur.g = makeGeom(sh, this.W, this.H);
    shapeSync(this.cur, this.W, this.H);
    this.paintLive();
  }
  adjustHeldShape(px, py) {
    const S = this._shape, { anchor: A, from: F, orig } = S;
    if (S.sh.name === 'line') {
      S.sh.pts = [A, snapLine(A, [px, py])];
    } else {
      const v0 = [F[0] - A[0], F[1] - A[1]], v1 = [px - A[0], py - A[1]], l0 = Math.hypot(...v0);
      if (l0 < 8) return;
      const k = Math.hypot(...v1) / l0, rot = Math.atan2(v1[1], v1[0]) - Math.atan2(v0[1], v0[0]);
      const c = Math.cos(rot) * k, sn = Math.sin(rot) * k;
      S.sh.pts = orig.map(([x, y]) => [A[0] + (x - A[0]) * c - (y - A[1]) * sn, A[1] + (x - A[0]) * sn + (y - A[1]) * c]);
    }
    this.setShape(S.sh);
  }

  // ---------- Forma selezionata: maniglie, menu e stile ----------
  selectShape(s) {
    this.clearSel();
    this.shapeSel = s;
    this._vSel = -1;
    this.drawShapeSel();
    this.showShapeMenu();
  }
  clearShapeSel() {
    if (!this.shapeSel) return;
    this.shapeSel = null;
    this.hideShapeMenu();
    this.clearLive();
  }
  // maniglie in pixel: v = vertice, add = "+" per aggiungere un punto, e = lato dell'ellisse, mid = curvatura dell'arco, rot = rotazione
  shapeHandles() {
    const s = this.shapeSel, g = s.g, v = gPts(g, this.W, this.H), out = [];
    if (g.type === 'poly') {
      v.forEach((p, i) => out.push({ kind: 'v', i, x: p[0], y: p[1] }));
      const n = g.closed ? v.length : v.length - 1;
      for (let i = 0; i < n; i++) {
        const a = v[i], b = v[(i + 1) % v.length];
        if (dist(a, b) > 36) out.push({ kind: 'add', i, x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 });
      }
    } else if (g.type === 'ellipse') {
      const [c, a, b] = v;
      [[a, 0, 1], [b, 1, 1], [a, 0, -1], [b, 1, -1]].forEach(([p, ax, sg], i) => out.push({ kind: 'e', i, ax, sg, x: c[0] + sg * (p[0] - c[0]), y: c[1] + sg * (p[1] - c[1]) }));
    } else if (g.type === 'arc') {
      const [p0, q, p1] = v, m = quad(p0, q, p1, 0.5);
      out.push({ kind: 'v', i: 0, x: p0[0], y: p0[1] }, { kind: 'v', i: 2, x: p1[0], y: p1[1] }, { kind: 'mid', x: m[0], y: m[1] });
    }
    const b = strokeBB(s);
    out.push({ kind: 'rot', x: (b[0] + b[2]) / 2 * this.W, y: Math.max(14, b[1] * this.H - 30) });
    return out;
  }
  shapeHit(px, py, r) {
    let best = null, bd = r;
    for (const hd of this.shapeHandles()) { const d = Math.hypot(hd.x - px, hd.y - py); if (d < bd || (d === bd && hd.kind !== 'add')) { bd = d; best = hd; } }
    if (best) return best;
    const s = this.shapeSel;
    if (this.hitStroke(s, px, py, r + s.w * this.W / 2000)) return { kind: 'move' };
    return null;
  }
  drawShapeSel() {
    if (!this.shapeSel || !this.rendered) return;
    const ctx = this.sizeCanvas(this.live), blue = '#2f7bf5';
    ctx.clearRect(0, 0, this.W, this.H);
    const hs = this.shapeHandles();
    const rot = hs.find(q => q.kind === 'rot'), b = strokeBB(this.shapeSel);
    ctx.strokeStyle = blue; ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(rot.x, rot.y + 9); ctx.lineTo(rot.x, b[1] * this.H - 4); ctx.stroke();
    ctx.setLineDash([]);
    for (const q of hs) {
      ctx.lineWidth = 1.5;
      if (q.kind === 'add') {
        ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fill(); ctx.strokeStyle = blue; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(q.x - 3, q.y); ctx.lineTo(q.x + 3, q.y); ctx.moveTo(q.x, q.y - 3); ctx.lineTo(q.x, q.y + 3); ctx.stroke();
      } else if (q.kind === 'rot') {
        ctx.beginPath(); ctx.arc(q.x, q.y, 9, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = blue; ctx.stroke();
        ctx.beginPath(); ctx.arc(q.x, q.y, 4.5, -0.3, Math.PI * 1.4); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(q.x + 4.3, q.y - 4); ctx.lineTo(q.x + 4.4, q.y - 1.2); ctx.lineTo(q.x + 1.8, q.y - 1.6); ctx.stroke();
      } else if (q.kind === 'mid') {
        ctx.beginPath(); ctx.arc(q.x, q.y, 6.5, 0, Math.PI * 2); ctx.fillStyle = blue; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.stroke();
      } else {
        const sel = q.kind === 'v' && q.i === this._vSel, r = sel ? 7 : 5.5;
        ctx.fillStyle = sel ? '#ff8a00' : blue; ctx.strokeStyle = '#fff';
        ctx.fillRect(q.x - r, q.y - r, r * 2, r * 2); ctx.strokeRect(q.x - r, q.y - r, r * 2, r * 2);
      }
    }
  }
  startShapeDrag(hit, px, py) {
    const s = this.shapeSel;
    this.hideShapeMenu();
    this._sg = { hit, start: [px, py], before: this.snap(), moved: false };
    // "+": aggiunge subito un nuovo punto, che si può trascinare
    if (hit.kind === 'add') {
      const v = gPts(s.g, this.W, this.H);
      v.splice(hit.i + 1, 0, [hit.x, hit.y]);
      gSet(s.g, v, this.W, this.H);
      if (s.g.name === 'line' || s.g.name === 'arrow') s.g.name = 'polyline';
      if (s.g.name === 'rect' || s.g.name === 'triangle') s.g.name = 'polygon';
      shapeSync(s, this.W, this.H);
      this._sg.hit = { kind: 'v', i: hit.i + 1 };
      this._sg.moved = true;
      this._vSel = hit.i + 1;
      this.renderStrokes();
    }
    this._sg.orig = gPts(s.g, this.W, this.H);
    this.gesture = 'shape';
    this.drawShapeSel();
  }
  shapeDrag(px, py) {
    const S = this._sg, s = this.shapeSel;
    if (!S || !s) return;
    const dx = px - S.start[0], dy = py - S.start[1];
    if (!S.moved && Math.hypot(dx, dy) < 3) return;
    S.moved = true;
    const o = S.orig, g = s.g, hit = S.hit;
    let pts = o.map(p => p.slice());
    if (hit.kind === 'move') pts = o.map(([x, y]) => [x + dx, y + dy]);
    else if (hit.kind === 'v') {
      let np = [o[hit.i][0] + dx, o[hit.i][1] + dy];
      // linee e spezzate: il lato si blocca ogni 45° rispetto al punto vicino
      if (g.type === 'poly' && !g.closed) { const nb = o[hit.i - 1] || o[hit.i + 1]; if (nb) np = snapLine(nb, np); }
      else if (g.type === 'arc') { const nb = o[hit.i === 0 ? 2 : 0]; np = snapLine(nb, np); }
      pts[hit.i] = np;
    } else if (hit.kind === 'mid') {
      const [p0, , p1] = o, m = [quad(...o, 0.5)[0] + dx, quad(...o, 0.5)[1] + dy];
      pts[1] = [2 * m[0] - (p0[0] + p1[0]) / 2, 2 * m[1] - (p0[1] + p1[1]) / 2];
    } else if (hit.kind === 'e') {
      // allunga solo quel lato dell'ellisse: il lato opposto resta fermo
      const [c, a, b] = o, axis = hit.ax === 0 ? [a[0] - c[0], a[1] - c[1]] : [b[0] - c[0], b[1] - c[1]];
      const other = hit.ax === 0 ? [b[0] - c[0], b[1] - c[1]] : [a[0] - c[0], a[1] - c[1]];
      const len = Math.hypot(...axis) || 1, dir = [axis[0] / len * hit.sg, axis[1] / len * hit.sg];
      const O = [c[0] - dir[0] * len, c[1] - dir[1] * len];
      const P = [c[0] + dir[0] * len + dx, c[1] + dir[1] * len + dy];
      const L = Math.max(8, (P[0] - O[0]) * dir[0] + (P[1] - O[1]) * dir[1]);
      const nc = [O[0] + dir[0] * L / 2, O[1] + dir[1] * L / 2], na = [dir[0] * L / 2, dir[1] * L / 2];
      const A = [nc[0] + na[0] * hit.sg, nc[1] + na[1] * hit.sg], B = [nc[0] + other[0], nc[1] + other[1]];
      pts = hit.ax === 0 ? [nc, A, B] : [nc, B, A];
      if (g.name === 'circle') g.name = 'ellipse';
    } else if (hit.kind === 'rot') {
      // rotazione attorno al centro, con blocco ogni 45°
      const b = this._sgBox || (this._sgBox = (() => { const bb = strokeBB(s); return [(bb[0] + bb[2]) / 2 * this.W, (bb[1] + bb[3]) / 2 * this.H]; })());
      let ang = Math.atan2(py - b[1], px - b[0]) - Math.atan2(S.start[1] - b[1], S.start[0] - b[0]);
      const near = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
      if (Math.abs(ang - near) < 0.06) ang = near;
      const c = Math.cos(ang), sn = Math.sin(ang);
      pts = o.map(([x, y]) => [b[0] + (x - b[0]) * c - (y - b[1]) * sn, b[1] + (x - b[0]) * sn + (y - b[1]) * c]);
    }
    gSet(g, pts, this.W, this.H);
    shapeSync(s, this.W, this.H);
    this.renderStrokes();
    this.drawShapeSel();
  }
  endShapeDrag() {
    const S = this._sg;
    this._sg = null; this._sgBox = null;
    if (!S || !this.shapeSel) return;
    if (S.moved) { this.pushUndo(S.before); this.emit(); }
    else if (S.hit.kind === 'v') this._vSel = this._vSel === S.hit.i ? -1 : S.hit.i;   // tocco su un punto: lo seleziona
    this.drawShapeSel();
    this.showShapeMenu();
  }
  // applica una modifica alla forma selezionata, con Annulla
  editShape(fn) {
    const s = this.shapeSel;
    if (!s) return;
    this.pushUndo(this.snap());
    fn(s);
    shapeSync(s, this.W, this.H);
    this.renderStrokes(); this.drawShapeSel(); this.emit();
  }
  canRemoveVertex() {
    const g = this.shapeSel && this.shapeSel.g;
    return !!g && g.type === 'poly' && this._vSel >= 0 && g.pts.length / 2 > (g.closed ? 3 : 2);
  }
  showShapeMenu() {
    this.hideShapeMenu();
    const s = this.shapeSel;
    if (!s) return;
    const b = strokeBB(s), x1 = b[0] * this.W, x2 = b[2] * this.W, y1 = b[1] * this.H - 44, y2 = b[3] * this.H + 14;
    const above = y1 > 52;
    const btn = (label, fn, cls = '') => h('button', { class: 'sm-btn' + cls, type: 'button', onclick: e => { e.stopPropagation(); fn(e); } }, label);
    const menu = h('div', {
      class: 'ink-selmenu shape-menu',
      style: { left: Math.min(Math.max((x1 + x2) / 2, 120), this.W - 120) + 'px', top: (above ? y1 - 6 : y2) + 'px', transform: above ? 'translate(-50%,-100%)' : 'translate(-50%,0)' },
    },
      btn('Stile', e => this.openShapeStyle(e.currentTarget)),
      btn('Taglia', () => this.copyCurrent(true)),
      btn('Copia', () => this.copyCurrent(false)),
      btn('Duplica', () => this.duplicateShape()),
      this.canRemoveVertex() ? btn('Togli punto', () => {
        const i = this._vSel;
        this.editShape(sh => { const v = gPts(sh.g, this.W, this.H); v.splice(i, 1); gSet(sh.g, v, this.W, this.H); });
        this._vSel = -1; this.drawShapeSel(); this.showShapeMenu();
      }) : null,
      btn('Elimina', () => this.deleteShape(), ' danger'),
      btn('Fine', () => this.clearShapeSel(), ' done'));
    menu.addEventListener('pointerdown', e => e.stopPropagation());
    this.el.append(menu);
    this._smenu = menu;
  }
  hideShapeMenu() {
    if (this._smenu) { this._smenu.remove(); this._smenu = null; }
    if (this._spop) { this._spop.remove(); document.removeEventListener('pointerdown', this._spopOff, true); this._spop = null; }
  }
  duplicateShape() {
    const s = this.shapeSel;
    if (!s) return;
    this.pushUndo(this.snap());
    const d = 18, c = JSON.parse(JSON.stringify(s));
    c.id = sid();
    gSet(c.g, gPts(c.g, this.W, this.H).map(([x, y]) => [x + d, y + d]), this.W, this.H);
    shapeSync(c, this.W, this.H);
    this.data.strokes.push(c);
    this.renderStrokes(); this.emit();
    this.selectShape(c);
  }
  deleteShape() {
    const s = this.shapeSel;
    if (!s) return;
    this.pushUndo(this.snap());
    this.data.strokes = this.data.strokes.filter(q => q !== s);
    this.clearShapeSel(); this.renderStrokes(); this.emit();
  }
  // Pannello "Stile del tratto": colore, tipo di linea, spessore, frecce
  openShapeStyle(anchor) {
    if (this._spop) { this.hideShapeMenu(); this.showShapeMenu(); return; }
    const s = this.shapeSel, hl = s.t === 'hl', key = hl ? 'highlighter' : 'pen';
    const pop = h('div', { class: 'shape-style' });
    const render = () => {
      const g = s.g, dark = this.dark;
      const colors = hl ? HL_COLORS : PEN_COLORS;
      const sw = c => h('button', {
        class: 'swatch' + (s.c === c ? ' active' : ''), style: { background: hl || !dark ? c : inkColor(c, true) }, 'aria-label': 'Colore',
        onclick: () => { this.editShape(q => { q.c = c; }); render(); },
      });
      const custom = h('input', { type: 'color', class: 'color-input', value: hl || !dark ? s.c : inkColor(s.c, true), 'aria-label': 'Colore personalizzato' });
      custom.addEventListener('change', () => { const v = custom.value; this.editShape(q => { q.c = hl || !dark ? v : inkColorFromDark(v); }); render(); });
      const line = d => h('span', { class: 'ss-line', html: `<svg viewBox="0 0 40 12" width="40" height="12"><line x1="4" y1="6" x2="36" y2="6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" ${d === 'dash' ? 'stroke-dasharray="7 5"' : d === 'dot' ? 'stroke-dasharray="0.1 5"' : ''}/></svg>` });
      const opt = (active, content, fn, title) => h('button', { class: 'ss-opt' + (active ? ' active' : ''), type: 'button', title, 'aria-label': title, onclick: () => { fn(); render(); } }, content);
      // la barra scorrevole aggiorna la forma dal vivo; l'annulla si registra una volta sola
      let before = null;
      const slider = sizeSlider(key, s.w, (w, done) => {
        if (!before) before = this.snap();
        s.w = w; this.renderStrokes(); this.drawShapeSel();
        if (done) { this.pushUndo(before); before = null; this.emit(); }
      }, hl ? "Dimensione dell'evidenziatore" : 'Dimensione della penna');
      const kids = [
        h('div', { class: 'ss-title' }, 'Stile del tratto'),
        h('div', { class: 'ss-label' }, 'Colore'),
        h('div', { class: 'ss-row' }, colors.map(sw), custom),
        h('div', { class: 'ss-label' }, 'Linea'),
        h('div', { class: 'ss-row' }, [['solid', 'Continua'], ['dash', 'Tratteggiata'], ['dot', 'Puntinata']].map(([d, t]) => opt((g.dash || 'solid') === d, line(d), () => this.editShape(q => { q.g.dash = d; }), t))),
        hl ? null : h('div', { class: 'ss-label' }, 'Tipo di penna'),
        hl ? null : h('div', { class: 'ss-row' }, PEN_STYLES.map(([id, label]) => opt((s.k || 'ball') === id, icon('pen_' + id), () => this.editShape(q => { q.k = id; }), label))),
        slider,
      ].filter(Boolean);
      if (!g.closed) {
        kids.push(h('div', { class: 'ss-label' }, 'Frecce'),
          h('div', { class: 'ss-row' }, [[0, '—', 'Nessuna'], [1, '→', 'Alla fine'], [2, '←', "All'inizio"], [3, '↔', 'Entrambe']].map(([a, l, t]) => opt((g.arrow || 0) === a, h('span', { class: 'ss-arrow' }, l), () => this.editShape(q => { q.g.arrow = a; }), t))));
      }
      pop.replaceChildren(...kids);
    };
    render();
    pop.addEventListener('pointerdown', e => e.stopPropagation());
    document.body.append(pop);
    // posizione sullo schermo: sotto la forma (e il menu), altrimenti sopra, altrimenti di lato; la forma resta visibile
    const er = this.el.getBoundingClientRect(), sx = er.width / this.W || 1, sy = er.height / this.H || 1;
    const bb = strokeBB(s), pw = pop.offsetWidth, ph = pop.offsetHeight, vw = innerWidth, vh = innerHeight;
    const L = er.left + bb[0] * this.W * sx, R = er.left + bb[2] * this.W * sx, T = er.top + bb[1] * this.H * sy, B = er.top + bb[3] * this.H * sy;
    const mr = this._smenu ? this._smenu.getBoundingClientRect() : null;
    const below = Math.max(B, mr && mr.top >= B - 2 ? mr.bottom : B) + 10, above = Math.min(T, mr && mr.bottom <= T + 2 ? mr.top : T) - 10 - ph;
    let x = (L + R) / 2 - pw / 2, y;
    if (below + ph <= vh - 8) y = below;
    else if (above >= 8) y = above;
    else {
      y = Math.min(Math.max(8, (T + B) / 2 - ph / 2), vh - ph - 8);
      x = R + 12 + pw <= vw - 8 ? R + 12 : L - 12 - pw;
    }
    pop.style.left = Math.min(Math.max(8, x), vw - pw - 8) + 'px';
    pop.style.top = Math.max(8, y) + 'px';
    this._spop = pop;
    this._spopOff = e => { if (!pop.contains(e.target) && !(this._smenu && this._smenu.contains(e.target))) { pop.remove(); document.removeEventListener('pointerdown', this._spopOff, true); this._spop = null; } };
    setTimeout(() => document.addEventListener('pointerdown', this._spopOff, true));
  }
  paintLive() {
    if (this._lr) return;
    this._lr = requestAnimationFrame(() => {
      this._lr = 0;
      if (!this.cur) return;
      const ctx = this.sizeCanvas(this.live);
      ctx.clearRect(0, 0, this.W, this.H);
      drawStroke(ctx, this.cur, this.W, this.H, this.dark);
    });
  }

  // ---------- gomma ----------
  eraseAt(x, y) {
    const W = this.W, H = this.H, px = x * W, py = y * H;
    const r = tools.widths.eraser * W / 1000 / 2 + 1;
    const partial = tools.eraserMode === 'partial';
    const keep = [];
    let changed = false;
    for (const s of this.data.strokes) {
      const b = strokeBB(s), m = (r + s.w * W / 1000) / W, mY = (r + s.w * W / 1000) / H;
      if (x < b[0] - m || x > b[2] + m || y < b[1] - mY || y > b[3] + mY) { keep.push(s); continue; }
      if (partial) {
        const pieces = this.cutStroke(s, px, py, r + s.w * W / 4000);
        if (pieces) { keep.push(...pieces); changed = true; } else keep.push(s);
      } else if (this.hitStroke(s, px, py, r + s.w * W / 2000)) changed = true;
      else keep.push(s);
    }
    if (changed) {
      if (!this._erased) { this.pushUndo(this._before); this._erased = true; }
      this.data.strokes = keep;
      this.renderStrokes();
    }
    const ctx = this.sizeCanvas(this.live);
    ctx.clearRect(0, 0, W, H);
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.fill();
    ctx.strokeStyle = 'rgba(100,100,100,.9)'; ctx.lineWidth = 1; ctx.stroke();
  }
  hitStroke(s, px, py, r) {
    const p = s.p, W = this.W, H = this.H;
    let ax = p[0] * W, ay = p[1] * H;
    if (p.length === 3) return Math.hypot(ax - px, ay - py) <= r;
    for (let i = 3; i < p.length; i += 3) {
      const bx = p[i] * W, by = p[i + 1] * H;
      if (distToSeg(px, py, ax, ay, bx, by) <= r) return true;
      ax = bx; ay = by;
    }
    return false;
  }
  // Gomma parziale: toglie solo la parte del tratto sotto la gomma e divide il resto in pezzi.
  // Restituisce null se il tratto non viene toccato.
  cutStroke(s, px, py, rr) {
    const p = s.p, W = this.W, H = this.H, step = Math.max(0.75, rr / 2);
    // vicino alla gomma aggiunge punti intermedi, così il taglio è preciso
    const q = [p[0], p[1], p[2]];
    for (let i = 3; i < p.length; i += 3) {
      const ax = p[i - 3] * W, ay = p[i - 2] * H, bx = p[i] * W, by = p[i + 1] * H;
      if (distToSeg(px, py, ax, ay, bx, by) <= rr + step) {
        const k = Math.ceil(Math.hypot(bx - ax, by - ay) / step);
        for (let j = 1; j < k; j++) {
          const t = j / k;
          q.push(R5(p[i - 3] + (p[i] - p[i - 3]) * t), R5(p[i - 2] + (p[i + 1] - p[i - 2]) * t), Math.round((p[i - 1] + (p[i + 2] - p[i - 1]) * t) * 100) / 100);
        }
      }
      q.push(p[i], p[i + 1], p[i + 2]);
    }
    const runs = [];
    let run = [], removed = false;
    for (let i = 0; i < q.length; i += 3) {
      if (Math.hypot(q[i] * W - px, q[i + 1] * H - py) <= rr) {
        removed = true;
        if (run.length) runs.push(run);
        run = [];
      } else run.push(q[i], q[i + 1], q[i + 2]);
    }
    if (run.length) runs.push(run);
    if (!removed) return null;
    // i pezzetti di un solo punto lascerebbero dei puntini: si scartano
    // i pezzi di una forma tornano tratti normali
    return runs.filter(r => r.length > 3).map(r => { const q = { ...s, id: sid(), p: r }; delete q.g; return q; });
  }

  // ---------- lazo ----------
  paintLasso() {
    const ctx = this.sizeCanvas(this.live), L = this.lasso;
    ctx.clearRect(0, 0, this.W, this.H);
    ctx.beginPath(); ctx.moveTo(L[0], L[1]);
    for (let i = 2; i < L.length; i += 2) ctx.lineTo(L[i], L[i + 1]);
    ctx.closePath();
    ctx.fillStyle = 'rgba(91,95,199,.07)'; ctx.fill();
    ctx.setLineDash([5, 4]); ctx.strokeStyle = '#5b5fc7'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
  }
  // Trascinamento col mouse in modalità Mano: scorre il contenitore della pagina
  startPan(e) {
    let sc = this.el.parentElement;
    const scrollable = n => {
      const s = getComputedStyle(n);
      return (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 1) || (/(auto|scroll)/.test(s.overflowX) && n.scrollWidth > n.clientWidth + 1);
    };
    while (sc && sc !== document.body && !scrollable(sc)) sc = sc.parentElement;
    if (!sc || sc === document.body) return;
    e.preventDefault();
    let lx = e.clientX, ly = e.clientY;
    this.el.classList.add('panning');
    const mv = ev => { sc.scrollLeft -= ev.clientX - lx; sc.scrollTop -= ev.clientY - ly; lx = ev.clientX; ly = ev.clientY; };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); this.el.classList.remove('panning'); };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
  }
  // Riquadro delle parole scritte (normalizzato). La casella di testo può essere molto più
  // larga delle parole: per selezionarla col lazo conta il testo visibile, non la casella.
  textBounds(t) {
    const el = this.textEl(t);
    const hh = (el ? el.offsetHeight : 20) / this.H;
    const box = { x1: t.x, y1: t.y, x2: t.x + t.w, y2: t.y + hh };
    if (!el || !el.firstChild) return box;
    const r = document.createRange();
    r.selectNodeContents(el);
    const b = r.getBoundingClientRect(), s = this.el.getBoundingClientRect();
    if (!b.width || !s.width) return box;
    return { ...box, x2: Math.min(box.x2, (b.right - s.left) / s.width + 0.004) };
  }
  finishLasso() {
    const L = this.lasso; this.lasso = null; this.clearLive();
    if (!L) return;
    const W = this.W, H = this.H;
    // un tocco (senza disegnare il lazo) su una forma, un testo o un'immagine li seleziona.
    // Con la penna un tocco ha sempre qualche piccolo movimento: conta quanto è grande il giro, non quanti punti ha.
    let lx1 = Infinity, ly1 = Infinity, lx2 = -Infinity, ly2 = -Infinity;
    for (let i = 0; i < L.length; i += 2) { lx1 = Math.min(lx1, L[i]); lx2 = Math.max(lx2, L[i]); ly1 = Math.min(ly1, L[i + 1]); ly2 = Math.max(ly2, L[i + 1]); }
    if (L.length < 8 || (lx2 - lx1 < 14 && ly2 - ly1 < 14)) {
      const tx = L[0], ty = L[1];
      // tocco su una forma: si apre la modifica con le maniglie
      const shape = this.shapeAt(tx, ty);
      if (shape) { this.selectShape(shape); return; }
      const x = tx / W, y = ty / H, pad = 6 / W;
      const t = [...this.data.texts].reverse().find(q => { const b = this.textBounds(q); return x >= b.x1 - pad && x <= b.x2 + pad && y >= b.y1 && y <= b.y2; });
      const im = !t && [...this.data.images].reverse().find(q => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h);
      // tocco su un punto vuoto con qualcosa di copiato: propone "Incolla"
      if (!t && !im) { if (clip) this.showPasteMenu(tx, ty); return; }
      this.sel = { strokes: [], texts: t ? [t] : [], images: im ? [im] : [] };
      this.drawSel(); this.showSelMenu();
      return;
    }
    const strokes = this.data.strokes.filter(s => {
      const p = s.p, step = Math.max(1, Math.floor(p.length / 3 / 30));
      let n = 0, inn = 0;
      for (let i = 0; i < p.length; i += 3 * step) { n++; if (pointInPoly(p[i] * W, p[i + 1] * H, L)) inn++; }
      return n && inn / n >= 0.5;
    });
    const texts = this.data.texts.filter(t => {
      const b = this.textBounds(t);
      return pointInPoly((b.x1 + b.x2) / 2 * W, (b.y1 + b.y2) / 2 * H, L);
    });
    const images = this.data.images.filter(im => pointInPoly((im.x + im.w / 2) * W, (im.y + im.h / 2) * H, L));
    if (!strokes.length && !texts.length && !images.length) return;
    // lazo attorno a una sola forma: si apre direttamente la modifica della forma
    if (strokes.length === 1 && strokes[0].g && !texts.length && !images.length) { this.selectShape(strokes[0]); return; }
    this.sel = { strokes, texts, images };
    this.drawSel();
    this.showSelMenu();
  }
  // forma il cui contorno passa vicino al punto (pixel)
  shapeAt(px, py) {
    return [...this.data.strokes].reverse().find(s => s.g && this.hitStroke(s, px, py, 14 + s.w * this.W / 2000)) || null;
  }

  // ---------- Taglia / Copia / Incolla ----------
  // Copia la forma selezionata o la selezione del lazo
  copyCurrent(cut = false) {
    const items = this.shapeSel ? { strokes: [this.shapeSel], texts: [], images: [] } : this.sel;
    if (!items) return false;
    clip = JSON.parse(JSON.stringify({ strokes: items.strokes, texts: items.texts, images: items.images }));
    if (cut) { if (this.shapeSel) this.deleteShape(); else this.deleteSel(); }
    toast(cut ? 'Tagliato: tocca un punto vuoto col lazo per incollare' : 'Copiato: tocca un punto vuoto col lazo per incollare', { ms: 2600 });
    return true;
  }
  // Incolla; con un punto (pixel) il contenuto viene centrato lì
  paste(px, py) {
    if (!clip) return false;
    const c = JSON.parse(JSON.stringify(clip)), W = this.W, H = this.H;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    const grow = (a, b, c2, d) => { x1 = Math.min(x1, a); y1 = Math.min(y1, b); x2 = Math.max(x2, c2); y2 = Math.max(y2, d); };
    for (const s of c.strokes) { const b = strokeBB(s); grow(b[0], b[1], b[2], b[3]); }
    for (const t of c.texts) grow(t.x, t.y, t.x + t.w, t.y + 0.02);
    for (const im of c.images) grow(im.x, im.y, im.x + im.w, im.y + im.h);
    if (!Number.isFinite(x1)) return false;
    let dx = 0.025, dy = 0.025 * W / H;
    if (px != null) { dx = px / W - (x1 + x2) / 2; dy = py / H - (y1 + y2) / 2; }
    for (const s of c.strokes) {
      s.id = sid();
      s.p = s.p.map((v, i) => i % 3 === 0 ? R5(v + dx) : i % 3 === 1 ? R5(v + dy) : v);
      if (s.g) s.g.pts = s.g.pts.map((v, i) => R5(v + (i % 2 ? dy : dx)));
    }
    for (const t of c.texts) { t.id = uid(); t.x = R5(t.x + dx); t.y = R5(t.y + dy); }
    for (const im of c.images) { im.id = uid(); im.x = R5(im.x + dx); im.y = R5(im.y + dy); }
    this.pushUndo(this.snap());
    this.data.strokes.push(...c.strokes); this.data.texts.push(...c.texts); this.data.images.push(...c.images);
    this.rebuildObjects(); this.renderStrokes(); this.emit();
    InkSurface.active = this;
    if (c.strokes.length === 1 && c.strokes[0].g && !c.texts.length && !c.images.length) this.selectShape(c.strokes[0]);
    else { this.clearShapeSel(); this.sel = c; this.drawSel(); this.showSelMenu(); }
    return true;
  }
  showPasteMenu(px, py) {
    this.hidePasteMenu();
    const m = h('div', { class: 'ink-selmenu shape-menu', style: { left: Math.min(Math.max(px, 50), this.W - 50) + 'px', top: Math.max(8, py - 10) + 'px', transform: 'translate(-50%,-100%)' } },
      h('button', { class: 'sm-btn', type: 'button', onclick: e => { e.stopPropagation(); this.hidePasteMenu(); this.paste(px, py); } }, 'Incolla'));
    m.addEventListener('pointerdown', e => e.stopPropagation());
    this.el.append(m);
    this._pmenu = m;
  }
  hidePasteMenu() { if (this._pmenu) { this._pmenu.remove(); this._pmenu = null; } }
  selBox() {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const s of this.sel.strokes) {
      const b = strokeBB(s), m = s.w / 2000;
      x1 = Math.min(x1, b[0] - m); y1 = Math.min(y1, b[1] - m * this.W / this.H);
      x2 = Math.max(x2, b[2] + m); y2 = Math.max(y2, b[3] + m * this.W / this.H);
    }
    for (const t of this.sel.texts) {
      const b = this.textBounds(t);
      x1 = Math.min(x1, b.x1); y1 = Math.min(y1, b.y1); x2 = Math.max(x2, b.x2); y2 = Math.max(y2, b.y2);
    }
    for (const im of this.sel.images) {
      x1 = Math.min(x1, im.x); y1 = Math.min(y1, im.y); x2 = Math.max(x2, im.x + im.w); y2 = Math.max(y2, im.y + im.h);
    }
    return { x1, y1, x2, y2 };
  }
  selBoxPx() {
    const b = this.selBox(), m = 8;
    return { x1: b.x1 * this.W - m, y1: b.y1 * this.H - m, x2: b.x2 * this.W + m, y2: b.y2 * this.H + m };
  }
  drawSel() {
    if (!this.sel || !this.rendered) return;
    const ctx = this.sizeCanvas(this.live), b = this.selBoxPx();
    ctx.clearRect(0, 0, this.W, this.H);
    ctx.setLineDash([6, 4]); ctx.strokeStyle = '#5b5fc7'; ctx.lineWidth = 1.5;
    ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(b.x2, b.y2, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();
  }
  showSelMenu() {
    this.hideSelMenu();
    if (!this.sel) return;
    const b = this.selBoxPx();
    const above = b.y1 > 52;
    const btn = (label, fn, cls = '', title = label) => h('button', { class: 'sm-btn' + cls, type: 'button', title, onclick: e => { e.stopPropagation(); fn(); } }, label);
    const menu = h('div', {
      class: 'ink-selmenu shape-menu',
      style: { left: Math.min(Math.max((b.x1 + b.x2) / 2, 150), this.W - 150) + 'px', top: (above ? b.y1 - 8 : b.y2 + 8) + 'px', transform: above ? 'translate(-50%,-100%)' : 'translate(-50%,0)' },
    },
      btn('Taglia', () => this.copyCurrent(true)),
      btn('Copia', () => this.copyCurrent(false)),
      btn('Duplica', () => this.duplicateSel()),
      btn('Colore', () => this.recolorSel(), '', 'Applica il colore attuale'),
      btn('Elimina', () => this.deleteSel(), ' danger'));
    menu.addEventListener('pointerdown', e => e.stopPropagation());
    this.el.append(menu);
    this._menu = menu;
  }
  hideSelMenu() { if (this._menu) { this._menu.remove(); this._menu = null; } }
  clearSel() { this.sel = null; this.hideSelMenu(); this.clearLive(); }
  translateSel(dx, dy) {
    for (const s of this.sel.strokes) {
      for (let i = 0; i < s.p.length; i += 3) { s.p[i] = R5(s.p[i] + dx); s.p[i + 1] = R5(s.p[i + 1] + dy); }
      if (s.g) s.g.pts = s.g.pts.map((v, i) => R5(v + (i % 2 ? dy : dx)));
      bbCache.delete(s);
    }
    for (const t of this.sel.texts) { t.x = R5(t.x + dx); t.y = R5(t.y + dy); }
    for (const im of this.sel.images) { im.x = R5(im.x + dx); im.y = R5(im.y + dy); }
    this.renderStrokes(); this.layoutObjects(); this.drawSel();
  }
  startScale(px, py) {
    const b = this.selBox();
    this._anchor = [b.x1, b.y1];
    this._d0 = Math.max(10, Math.hypot(px - b.x1 * this.W, py - b.y1 * this.H));
    this._orig = {
      s: this.sel.strokes.map(s => ({ p: s.p.slice(), w: s.w, g: s.g ? s.g.pts.slice() : null })),
      t: this.sel.texts.map(t => ({ x: t.x, y: t.y, w: t.w, s: t.s })),
      i: this.sel.images.map(im => ({ x: im.x, y: im.y, w: im.w, h: im.h })),
    };
  }
  doScale(px, py) {
    const [ax, ay] = this._anchor, o = this._orig;
    const f = Math.max(0.1, Math.hypot(px - ax * this.W, py - ay * this.H) / this._d0);
    this.sel.strokes.forEach((s, k) => {
      const op = o.s[k].p;
      for (let i = 0; i < op.length; i += 3) { s.p[i] = R5(ax + (op[i] - ax) * f); s.p[i + 1] = R5(ay + (op[i + 1] - ay) * f); }
      s.w = o.s[k].w * f;
      if (s.g && o.s[k].g) s.g.pts = o.s[k].g.map((v, i) => R5(i % 2 ? ay + (v - ay) * f : ax + (v - ax) * f));
      bbCache.delete(s);
    });
    this.sel.texts.forEach((t, k) => { const q = o.t[k]; t.x = R5(ax + (q.x - ax) * f); t.y = R5(ay + (q.y - ay) * f); t.w = R5(q.w * f); t.s = q.s * f; });
    this.sel.images.forEach((im, k) => { const q = o.i[k]; im.x = R5(ax + (q.x - ax) * f); im.y = R5(ay + (q.y - ay) * f); im.w = R5(q.w * f); im.h = R5(q.h * f); });
    this.renderStrokes(); this.layoutObjects(); this.drawSel();
  }
  deleteSel() {
    if (!this.sel) return;
    this.pushUndo(this.snap());
    const { strokes, texts, images } = this.sel;
    this.data.strokes = this.data.strokes.filter(s => !strokes.includes(s));
    this.data.texts = this.data.texts.filter(t => !texts.includes(t));
    this.data.images = this.data.images.filter(i => !images.includes(i));
    this.clearSel(); this.rebuildObjects(); this.renderStrokes(); this.emit();
  }
  duplicateSel() {
    if (!this.sel) return;
    this.pushUndo(this.snap());
    const d = 0.025, dy = d * this.W / this.H;
    const strokes = this.sel.strokes.map(s => {
      const c = { ...s, id: sid(), p: s.p.map((v, i) => i % 3 === 0 ? R5(v + d) : i % 3 === 1 ? R5(v + dy) : v) };
      if (s.g) c.g = { ...s.g, pts: s.g.pts.map((v, i) => R5(v + (i % 2 ? dy : d))) };
      return c;
    });
    const texts = this.sel.texts.map(t => ({ ...t, id: uid(), x: t.x + d, y: t.y + dy }));
    const images = this.sel.images.map(im => ({ ...im, id: uid(), x: im.x + d, y: im.y + dy }));
    this.data.strokes.push(...strokes); this.data.texts.push(...texts); this.data.images.push(...images);
    this.rebuildObjects(); this.renderStrokes();
    this.sel = { strokes, texts, images };
    this.drawSel(); this.showSelMenu(); this.emit();
  }
  recolorSel() {
    if (!this.sel) return;
    this.pushUndo(this.snap());
    for (const s of this.sel.strokes) s.c = s.t === 'hl' ? tools.colors.highlighter : tools.colors.pen;
    for (const t of this.sel.texts) t.c = tools.colors.pen;
    this.renderStrokes(); this.layoutObjects(); this.emit();
  }

  // ---------- testo e immagini ----------
  _textClick(e) {
    if (!this.enabled() || tools.tool !== 'text' || e.target !== this.txtLayer) return;
    const r = this.txtLayer.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    const before = this.snap();
    const size = tools.widths.text;
    const lh = size * 1.3 / 1000 * this.W / this.H;
    const t = { id: uid(), x: R5(x), y: R5(Math.max(0, y - lh / 2)), w: R5(Math.max(0.12, Math.min(0.45, 0.98 - x))), s: size, c: tools.colors.pen, v: '' };
    this.data.texts.push(t);
    const el = this.makeTextEl(t);
    this.layoutObjects();
    el._before = before;
    el.focus();
  }
  makeTextEl(t) {
    const el = h('div', { class: 'ink-text', spellcheck: 'true' });
    el.innerText = t.v || '';
    el.contentEditable = this.enabled() && tools.tool === 'text' ? 'true' : 'false';
    el._t = t;
    el.addEventListener('focus', () => { InkSurface.active = this; if (el._before == null) el._before = this.snap(); this._editing = el; this.placeHandle(); });
    el.addEventListener('input', () => { t.v = el.innerText.replace(/\n$/, ''); this.emit(); });
    el.addEventListener('blur', () => {
      if (this._movingText) return;   // la maniglia sta spostando questo testo
      if (this._editing === el) { this._editing = null; this.placeHandle(); }
      if (!el.innerText.trim()) {
        const i = this.data.texts.indexOf(t);
        if (i >= 0) this.data.texts.splice(i, 1);
        el.remove();
      }
      const b = el._before; el._before = null;
      if (b != null && b !== this.snap()) this.pushUndo(b);
      this.emit();
    });
    el.addEventListener('paste', e => {
      e.preventDefault();
      const s = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
      document.execCommand('insertText', false, s);
    });
    el.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') el.blur(); });
    this.txtLayer.append(el);
    return el;
  }
  textEl(t) { for (const el of this.txtLayer.children) if (el._t === t) return el; return null; }
  // Maniglia sopra la casella di testo in modifica
  placeHandle() {
    const el = this._editing, hd = this.textHandle;
    if (!el || !el.isConnected || !this.W) { hd.hidden = true; return; }
    const t = el._t;
    hd.hidden = false;
    hd.style.left = Math.max(0, t.x * this.W - 2) + 'px';
    hd.style.top = Math.max(0, t.y * this.H - 26) + 'px';
  }
  _dragText(e) {
    const el = this._editing;
    if (!el) return;
    e.preventDefault(); e.stopPropagation();
    const t = el._t, r = this.el.getBoundingClientRect();
    let lx = e.clientX, ly = e.clientY;
    this._movingText = true;
    try { this.textHandle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const mv = ev => {
      t.x = R5(Math.min(0.98, Math.max(-t.w + 0.02, t.x + (ev.clientX - lx) / r.width)));
      t.y = R5(Math.min(0.98, Math.max(0, t.y + (ev.clientY - ly) / r.height)));
      lx = ev.clientX; ly = ev.clientY;
      this.layoutObjects(); this.placeHandle();
    };
    const up = () => {
      this.textHandle.removeEventListener('pointermove', mv);
      this.textHandle.removeEventListener('pointerup', up);
      this.textHandle.removeEventListener('pointercancel', up);
      this._movingText = false;
      if (document.activeElement !== el) el.focus();
      this.emit();
    };
    this.textHandle.addEventListener('pointermove', mv);
    this.textHandle.addEventListener('pointerup', up);
    this.textHandle.addEventListener('pointercancel', up);
  }
  makeImgEl(im) {
    const el = h('img', { class: 'ink-img', draggable: 'false', alt: '' });
    el._i = im;
    this.imgLayer.append(el);
    if (this.loadFile) Promise.resolve(this.loadFile(im.fileId)).then(u => { if (u) el.src = u; });
    return el;
  }
  rebuildObjects() {
    this.txtLayer.replaceChildren();
    this.imgLayer.replaceChildren();
    for (const t of this.data.texts) this.makeTextEl(t);
    for (const im of this.data.images) this.makeImgEl(im);
    this.layoutObjects();
  }
  layoutObjects() {
    const W = this.W, H = this.H;
    if (!W) return;
    for (const el of this.txtLayer.children) {
      const t = el._t; if (!t) continue;
      el.style.left = t.x * W + 'px'; el.style.top = t.y * H + 'px'; el.style.width = t.w * W + 'px';
      el.style.fontSize = (t.s * W / 1000) + 'px'; el.style.color = inkColor(t.c, this.adaptText && this.dark);
    }
    for (const el of this.imgLayer.children) {
      const im = el._i; if (!im) continue;
      el.style.left = im.x * W + 'px'; el.style.top = im.y * H + 'px'; el.style.width = im.w * W + 'px'; el.style.height = im.h * H + 'px';
    }
    this.placeHandle();
  }
  addImage(fileId, aspect) {
    if (!this.W) return;
    this.pushUndo(this.snap());
    const w = 0.5, hN = w * this.W * aspect / this.H;
    const im = { id: uid(), fileId, x: 0.25, y: R5(Math.max(0.03, Math.min(0.5 - hN / 2, 1 - hN))), w, h: R5(hN) };
    this.data.images.push(im);
    this.makeImgEl(im);
    this.layoutObjects();
    this.emit();
    tools.set({ tool: 'lasso' });
    this.sel = { strokes: [], texts: [], images: [im] };
    this.drawSel(); this.showSelMenu();
  }

  // ---------- annulla / ripeti ----------
  snap() { return JSON.stringify({ strokes: this.data.strokes, texts: this.data.texts, images: this.data.images }); }
  pushUndo(s) { this.undoStack.push(s); if (this.undoStack.length > 60) this.undoStack.shift(); this.redoStack.length = 0; }
  restore(s) {
    const d = JSON.parse(s);
    this.data.strokes = d.strokes; this.data.texts = d.texts; this.data.images = d.images;
    this.clearSel(); this.clearShapeSel(); this.rebuildObjects(); this.renderStrokes(); this.emit();
  }
  undo() { if (!this.undoStack.length) return false; this.redoStack.push(this.snap()); this.restore(this.undoStack.pop()); return true; }
  redo() { if (!this.redoStack.length) return false; this.undoStack.push(this.snap()); this.restore(this.redoStack.pop()); return true; }

  emit() { this.onChange(this.data); }

  // Sostituisce il contenuto con una versione arrivata da un altro dispositivo
  isBusy() { const a = document.activeElement; return !!this.gesture || !!(a && this.el.contains(a)); }
  replaceData(d) {
    this.data.strokes = (d && d.strokes) || [];
    this.data.texts = (d && d.texts) || [];
    this.data.images = (d && d.images) || [];
    this.undoStack.length = 0; this.redoStack.length = 0;
    this.clearShapeSel();
    this.clearSel(); this.rebuildObjects(); this.renderStrokes();
  }
  destroy() {
    this.ro.disconnect();
    this.unsub();
    this.unTheme();
    clearTimeout(this._rt);
    if (InkSurface.active === this) InkSurface.active = null;
    clearTimeout(this._ht);
    this.clearShapeSel();
    this.hidePasteMenu();
  }
}

// Barra degli strumenti di scrittura (condivisa tra quaderni e calendario)
// hand: strumento Mano (scorri con dito o penna). penOnly: pulsante "Solo penna".
export function inkToolbar({ compact = false, lasso = true, text = true, hand = true, penOnly = true, extra = [] } = {}) {
  const bar = h('div', { class: 'ink-toolbar' + (compact ? ' compact' : '') });
  const defs = [
    ['pen', 'pen', 'Penna (P)'],
    ['highlighter', 'highlighter', 'Evidenziatore (H)'],
    ['eraser', 'eraser', 'Gomma (E)'],
    lasso && ['lasso', 'lasso', 'Lazo: seleziona, sposta, ridimensiona. Tocca un testo per selezionarlo (L)'],
    text && ['text', 'text', 'Testo da tastiera (T)'],
    hand && ['hand', 'hand', 'Mano: scorri la pagina con il dito o con la penna (M)'],
  ].filter(Boolean);
  const toolBtns = defs.map(([id, ic, label]) => h('button', { class: 'tool-btn', title: label, 'aria-label': label, onclick: () => tools.set({ tool: id }) }, icon(ic)));
  // opzioni che cambiano in base allo strumento (tipo di penna, colori, spessori, modalità gomma)
  const opts = h('div', { class: 'tb-opts' });
  const act = () => InkSurface.active;
  const undo = h('button', { class: 'tool-btn', title: 'Annulla (Ctrl+Z)', 'aria-label': 'Annulla', onclick: () => act() && act().undo() }, icon('undo'));
  const redo = h('button', { class: 'tool-btn', title: 'Ripeti (Ctrl+Y)', 'aria-label': 'Ripeti', onclick: () => act() && act().redo() }, icon('redo'));
  const penOnlyBtn = penOnly ? h('button', { class: 'tool-btn', title: 'Solo penna: la penna scrive, il dito scorre la pagina', 'aria-label': 'Solo penna', onclick: () => tools.set({ penOnly: !tools.penOnly }) }, icon('penOnly')) : null;
  bar.append(h('div', { class: 'tb-group' }, toolBtns), opts, h('div', { class: 'tb-group' }, undo, redo, penOnlyBtn), ...extra);

  function styleGroup() {
    const cur = PEN_STYLES.find(s => s[0] === tools.penStyle) || PEN_STYLES[1];
    const b = h('button', {
      class: 'tb-group tb-style', type: 'button', title: 'Tipo di penna: ' + cur[1], 'aria-label': 'Tipo di penna: ' + cur[1],
      onclick: () => popMenu(b, [{ heading: 'Tipo di penna' }, ...PEN_STYLES.map(([id, label]) => ({
        label, icon: 'pen_' + id, active: tools.penStyle === id, onClick: () => tools.set({ penStyle: id }),
      }))]),
    }, icon('pen_' + cur[0]), h('span', { class: 'tb-style-name' }, cur[1]), icon('chevD', 'tb-chev'));
    return b;
  }
  function colorGroup(key, dark) {
    const adapt = key === 'pen' && dark;   // gli evidenziatori restano uguali in entrambi i temi
    const g = h('div', { class: 'tb-group tb-colors' });
    for (const c of key === 'highlighter' ? HL_COLORS : PEN_COLORS) {
      const shown = adapt ? inkColor(c, true) : c;
      g.append(h('button', {
        class: 'swatch' + (tools.colors[key] === c ? ' active' : ''), style: { background: shown }, title: shown, 'aria-label': 'Colore ' + shown,
        onclick: () => tools.set({ colors: { ...tools.colors, [key]: c } }),
      }));
    }
    const custom = h('input', { type: 'color', class: 'color-input', value: adapt ? inkColor(tools.colors[key], true) : tools.colors[key], title: 'Colore personalizzato', 'aria-label': 'Colore personalizzato' });
    custom.addEventListener('change', () => tools.set({ colors: { ...tools.colors, [key]: adapt ? inkColorFromDark(custom.value) : custom.value } }));
    g.append(custom);
    return g;
  }
  function sizeGroup(t) {
    const list = SIZES[t], unit = UNIT[t];
    const free = !!RANGE[t], custom = free && !isPreset(t, tools.widths[t]);
    const cur = custom ? -1 : nearest(list, tools.widths[t]);
    const g = h('div', { class: 'tb-group tb-sizes' + (t === 'eraser' ? ' eraser' : '') });
    list.forEach((s, i) => {
      const d = t === 'eraser' ? 6 + i * 5 : Math.round(3 + i * (11 / Math.max(1, list.length - 1)));
      const name = t === 'eraser' ? 'Gomma ' + s.name.toLowerCase() : `${s.label} ${unit}`;
      g.append(h('button', {
        class: 'size-btn' + (i === cur ? ' active' : ''), type: 'button', title: name, 'aria-label': name,
        onclick: () => tools.set({ widths: { ...tools.widths, [t]: s.w } }),
      }, t === 'text' ? null : h('i', { style: { width: d + 'px', height: d + 'px' } }), h('span', {}, s.label)));
    });
    if (unit) g.append(h('span', { class: 'tb-unit' }, unit));
    // "…": spessore a scelta con la barra scorrevole (es. 5,7 mm)
    if (free) {
      const more = h('button', {
        class: 'size-btn more' + (custom ? ' active' : ''), type: 'button', title: 'Scegli lo spessore in mm', 'aria-label': 'Scegli lo spessore in mm',
        onclick: () => openSizePop(more, t),
      }, custom ? h('span', {}, num(toMM(tools.widths[t]))) : icon('more'));
      g.append(more);
    }
    return g;
  }
  let sizePop = null;
  function closeSizePop() { if (sizePop) { sizePop.el.remove(); document.removeEventListener('pointerdown', sizePop.off, true); sizePop = null; } }
  function openSizePop(anchor, t) {
    if (sizePop) { closeSizePop(); return; }
    const el = h('div', { class: 'size-pop' }, sizeSlider(t, tools.widths[t], (w, done) => {
      // durante il trascinamento aggiorna solo lo spessore, senza ridisegnare la barra
      tools.widths[t] = w;
      if (done) { const keep = sizePop; sizePop = null; tools.set({ widths: { ...tools.widths, [t]: w } }); sizePop = keep; }
    }, t === 'highlighter' ? "Dimensione dell'evidenziatore" : 'Dimensione della penna'));
    document.body.append(el);
    const r = anchor.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(r.left + r.width / 2 - el.offsetWidth / 2, innerWidth - el.offsetWidth - 8)) + 'px';
    el.style.top = Math.min(r.bottom + 8, innerHeight - el.offsetHeight - 8) + 'px';
    const off = e => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeSizePop(); };
    setTimeout(() => document.addEventListener('pointerdown', off, true));
    sizePop = { el, off };
  }
  function eraserModeGroup() {
    const g = h('div', { class: 'tb-group tb-mode' });
    for (const [id, label, title] of [['stroke', 'Tratto intero', 'Cancella l\'intero tratto toccato'], ['partial', 'Parziale', 'Cancella solo la parte toccata']]) {
      g.append(h('button', { class: 'mode-btn' + (tools.eraserMode === id ? ' active' : ''), type: 'button', title, onclick: () => tools.set({ eraserMode: id }) }, label));
    }
    return g;
  }

  function sync() {
    defs.forEach(([id], i) => toolBtns[i].classList.toggle('active', tools.tool === id));
    const t = tools.tool, dark = isDarkTheme();
    if (toolBtns[0]) toolBtns[0].replaceChildren(icon('pen_' + tools.penStyle));
    const parts = [];
    if (t === 'pen') parts.push(styleGroup());
    if (t === 'pen' || t === 'highlighter') {
      const tip = 'Forme: ogni tratto diventa una forma perfetta (linea, cerchio, rettangolo, triangolo…). Anche senza, tieni ferma la penna alla fine del tratto per raddrizzarlo.';
      parts.push(h('button', {
        class: 'tool-btn tb-shapes' + (tools.shapes ? ' active' : ''), type: 'button', title: tip, 'aria-label': 'Forme', 'aria-pressed': String(!!tools.shapes),
        onclick: () => { tools.set({ shapes: !tools.shapes }); toast(tools.shapes ? 'Forme attive: i tratti diventano forme perfette' : 'Forme disattivate (tieni ferma la penna per una forma singola)', { ms: 2200 }); },
      }, icon('shapes')));
    }
    if (t !== 'eraser' && t !== 'hand') parts.push(colorGroup(t === 'highlighter' ? 'highlighter' : 'pen', dark));
    if (SIZES[t]) parts.push(sizeGroup(t));
    if (t === 'eraser') parts.push(eraserModeGroup());
    opts.replaceChildren(...parts);
    if (penOnlyBtn) penOnlyBtn.classList.toggle('active', !!tools.penOnly);
  }
  const offTools = tools.on(sync), offTheme = onTheme(sync);
  bar.destroy = () => { offTools(); offTheme(); closeSizePop(); };
  sync();
  return bar;
}
