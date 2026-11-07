// Motore di scrittura a mano: penna con pressione, evidenziatore, gomma,
// lazo (seleziona / sposta / ridimensiona), caselle di testo da tastiera e immagini.
// Le coordinate sono normalizzate (0..1) così il disegno si adatta a zoom e schermi diversi.

import { h, toast, popMenu } from './ui.js';
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
  _l: new Set(),
  load() {
    try {
      const s = JSON.parse(localStorage.getItem(LS) || '{}');
      for (const k of ['tool', 'penStyle', 'eraserMode', 'penOnly', 'penSeen']) if (k in s) this[k] = s[k];
      if (s.colors) Object.assign(this.colors, s.colors);
      if (s.widths) Object.assign(this.widths, s.widths);
    } catch { /* nessun salvataggio */ }
    // riporta gli spessori salvati con la vecchia barra alla tappa più vicina
    for (const k in SIZES) this.widths[k] = SIZES[k][nearest(SIZES[k], this.widths[k])].w;
    document.documentElement.classList.toggle('pen-only', !!this.penOnly);
  },
  set(p) {
    Object.assign(this, p);
    try {
      localStorage.setItem(LS, JSON.stringify({
        tool: this.tool, penStyle: this.penStyle, eraserMode: this.eraserMode, colors: this.colors, widths: this.widths, penOnly: this.penOnly, penSeen: this.penSeen,
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
  if (!n) return;
  const base = s.w * W / 1000;
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
    if (e.pointerType === 'pen' && !tools.penSeen) {
      tools.set({ penSeen: true, penOnly: true });
      toast('Penna rilevata: ora la penna scrive e il dito scorre la pagina.');
    }
    // Mano: dito e penna scorrono la pagina (lo fa il browser); col mouse si trascina
    if (tools.tool === 'hand') { if (e.pointerType === 'mouse' && e.button === 0) this.startPan(e); return; }
    if (e.pointerType === 'touch' && tools.penOnly) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
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
    if (g === 'draw') { for (const ev of evs) { const [x, y] = this.norm(ev); this.addPt(x, y, ev); } this.paintLive(); }
    else if (g === 'erase') { for (const ev of evs) { const [x, y] = this.norm(ev); this.eraseAt(x, y); } }
    else if (g === 'lasso') { for (const ev of evs) { const [x, y] = this.norm(ev); this.lasso.push(x * this.W, y * this.H); } this.paintLasso(); }
    else if (g === 'move') { const [x, y] = this.norm(e); this.translateSel(x - this._last[0], y - this._last[1]); this._last = [x, y]; }
    else if (g === 'scale') { const [x, y] = this.norm(e); this.doScale(x * this.W, y * this.H); }
  }
  _up(e) {
    if (e.pointerId !== this.pid || !this.gesture) return;
    const g = this.gesture;
    this.gesture = null;
    if (g === 'draw') {
      const s = this.cur;
      this.cur = null;
      cancelAnimationFrame(this._lr); this._lr = 0;
      this.clearLive();
      if (s && s.p.length) {
        this.pushUndo(this.snap());
        this.data.strokes.push(s);
        drawStroke(this.sizeCanvas(this.cv), s, this.W, this.H, this.dark);
        this.emit();
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
    }
  }
  _cancel(e) { if (e.pointerId === this.pid) this.cancelGesture(); }
  cancelGesture() {
    const g = this.gesture;
    this.gesture = null;
    if (g === 'draw') { this.cur = null; cancelAnimationFrame(this._lr); this._lr = 0; this.clearLive(); }
    else if (g === 'lasso') { this.lasso = null; this.clearLive(); }
    else if (g === 'erase') { this.clearLive(); if (this._erased) this.emit(); }
    else if (g === 'move' || g === 'scale') { if (this._before !== this.snap()) { this.pushUndo(this._before); this.emit(); } this.drawSel(); this.showSelMenu(); }
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
    return runs.filter(r => r.length > 3).map(r => ({ ...s, id: sid(), p: r }));
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
    // un tocco (senza disegnare il lazo) su un testo o un'immagine li seleziona
    if (L.length < 8) {
      const x = L[0] / W, y = L[1] / H, pad = 6 / W;
      const t = [...this.data.texts].reverse().find(q => { const b = this.textBounds(q); return x >= b.x1 - pad && x <= b.x2 + pad && y >= b.y1 && y <= b.y2; });
      const im = !t && [...this.data.images].reverse().find(q => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h);
      if (!t && !im) return;
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
    this.sel = { strokes, texts, images };
    this.drawSel();
    this.showSelMenu();
  }
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
    const btn = (label, ic, fn) => h('button', { class: 'icon-btn', title: label, 'aria-label': label, onclick: e => { e.stopPropagation(); fn(); } }, icon(ic));
    const menu = h('div', {
      class: 'ink-selmenu',
      style: { left: Math.min(Math.max((b.x1 + b.x2) / 2, 70), this.W - 70) + 'px', top: (above ? b.y1 - 8 : b.y2 + 8) + 'px', transform: above ? 'translate(-50%,-100%)' : 'translate(-50%,0)' },
    },
      btn('Applica il colore attuale', 'palette', () => this.recolorSel()),
      btn('Duplica', 'copy', () => this.duplicateSel()),
      btn('Elimina', 'trash', () => this.deleteSel()));
    menu.addEventListener('pointerdown', e => e.stopPropagation());
    this.el.append(menu);
    this._menu = menu;
  }
  hideSelMenu() { if (this._menu) { this._menu.remove(); this._menu = null; } }
  clearSel() { this.sel = null; this.hideSelMenu(); this.clearLive(); }
  translateSel(dx, dy) {
    for (const s of this.sel.strokes) {
      for (let i = 0; i < s.p.length; i += 3) { s.p[i] = R5(s.p[i] + dx); s.p[i + 1] = R5(s.p[i + 1] + dy); }
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
      s: this.sel.strokes.map(s => ({ p: s.p.slice(), w: s.w })),
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
    const strokes = this.sel.strokes.map(s => ({ ...s, id: sid(), p: s.p.map((v, i) => i % 3 === 0 ? R5(v + d) : i % 3 === 1 ? R5(v + dy) : v) }));
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
    this.clearSel(); this.rebuildObjects(); this.renderStrokes(); this.emit();
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
    this.clearSel(); this.rebuildObjects(); this.renderStrokes();
  }
  destroy() {
    this.ro.disconnect();
    this.unsub();
    this.unTheme();
    clearTimeout(this._rt);
    if (InkSurface.active === this) InkSurface.active = null;
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
    const list = SIZES[t], cur = nearest(list, tools.widths[t]), unit = UNIT[t];
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
    return g;
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
    if (t !== 'eraser' && t !== 'hand') parts.push(colorGroup(t === 'highlighter' ? 'highlighter' : 'pen', dark));
    if (SIZES[t]) parts.push(sizeGroup(t));
    if (t === 'eraser') parts.push(eraserModeGroup());
    opts.replaceChildren(...parts);
    if (penOnlyBtn) penOnlyBtn.classList.toggle('active', !!tools.penOnly);
  }
  const offTools = tools.on(sync), offTheme = onTheme(sync);
  bar.destroy = () => { offTools(); offTheme(); };
  sync();
  return bar;
}
