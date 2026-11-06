// Motore di scrittura a mano: penna con pressione, evidenziatore, gomma,
// lazo (seleziona / sposta / ridimensiona), caselle di testo da tastiera e immagini.
// Le coordinate sono normalizzate (0..1) così il disegno si adatta a zoom e schermi diversi.

import { h, toast } from './ui.js';
import { icon } from './icons.js';
import { uid } from './util.js';

export const PEN_COLORS = ['#1f1f1f', '#1a5fd0', '#d13438', '#107c41', '#7a3fd1', '#e8730c'];
export const HL_COLORS = ['#ffe14d', '#8ef08e', '#8fd9ff', '#ffa3d7', '#ffbe73'];
const RANGES = { pen: [0.8, 12, 0.1], highlighter: [6, 40, 1], eraser: [6, 60, 1], text: [10, 48, 1] };
const LS = 'pfy-tools';

export const emptyInk = () => ({ strokes: [], texts: [], images: [] });

// Stato condiviso degli strumenti (uguale in tutta l'app, come in Noteful)
export const tools = {
  tool: 'pen',
  colors: { pen: '#1f1f1f', highlighter: '#ffe14d' },
  widths: { pen: 2.4, highlighter: 16, eraser: 16, text: 18 },
  penOnly: false,
  penSeen: false,
  _l: new Set(),
  load() {
    try {
      const s = JSON.parse(localStorage.getItem(LS) || '{}');
      for (const k of ['tool', 'penOnly', 'penSeen']) if (k in s) this[k] = s[k];
      if (s.colors) Object.assign(this.colors, s.colors);
      if (s.widths) Object.assign(this.widths, s.widths);
    } catch { /* nessun salvataggio */ }
    document.documentElement.classList.toggle('pen-only', !!this.penOnly);
  },
  set(p) {
    Object.assign(this, p);
    try { localStorage.setItem(LS, JSON.stringify({ tool: this.tool, colors: this.colors, widths: this.widths, penOnly: this.penOnly, penSeen: this.penSeen })); } catch { /* ignore */ }
    document.documentElement.classList.toggle('pen-only', !!this.penOnly);
    this._l.forEach(f => f());
  },
  on(f) { this._l.add(f); return () => this._l.delete(f); },
};
tools.load();

const R5 = v => Math.round(v * 1e5) / 1e5;

// Disegna un tratto. p = [x, y, pressione, x, y, pressione, ...] normalizzati
export function drawStroke(ctx, s, W, H) {
  const p = s.p, n = p.length / 3;
  if (!n) return;
  const base = s.w * W / 1000;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = s.c;
  if (s.t === 'hl') {
    ctx.globalAlpha = 0.38;
    ctx.globalCompositeOperation = 'multiply';
    ctx.lineWidth = base;
    ctx.beginPath();
    ctx.moveTo(p[0] * W, p[1] * H);
    if (n === 1) ctx.lineTo(p[0] * W + 0.1, p[1] * H);
    for (let i = 3; i < p.length; i += 3) ctx.lineTo(p[i] * W, p[i + 1] * H);
    ctx.stroke();
  } else if (n === 1) {
    ctx.fillStyle = s.c;
    ctx.beginPath();
    ctx.arc(p[0] * W, p[1] * H, Math.max(0.6, base * (0.35 + p[2] * 1.1) / 2), 0, Math.PI * 2);
    ctx.fill();
  } else {
    let px = p[0] * W, py = p[1] * H, mx = px, my = py;
    for (let i = 3; i < p.length; i += 3) {
      const x = p[i] * W, y = p[i + 1] * H, pr = p[i + 2];
      const nx = (px + x) / 2, ny = (py + y) / 2;
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.quadraticCurveTo(px, py, nx, ny);
      ctx.lineWidth = Math.max(0.6, base * (0.35 + pr * 1.1));
      ctx.stroke();
      mx = nx; my = ny; px = x; py = y;
    }
    ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(px, py); ctx.stroke();
  }
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
    const stylusGuard = e => {
      if (!this.enabled()) return;
      for (const t of e.changedTouches) if (t.touchType === 'stylus') { e.preventDefault(); return; }
    };
    this.live.addEventListener('touchstart', stylusGuard, { passive: false });
    this.live.addEventListener('touchmove', stylusGuard, { passive: false });
    this.txtLayer.addEventListener('click', e => this._textClick(e));

    this.rebuildObjects();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.unsub = tools.on(() => this.updateMode());
    this.updateMode();
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
    try { r = this.drawBackground(W, H, this._d); } catch (e) { console.warn(e); return; }
    if (r && typeof r.then === 'function') r.then(paint, e => console.warn(e));
    else paint(r);
  }
  refreshBackground() { if (this.visible && this.rendered) this.renderBg(); }
  renderStrokes() {
    if (!this.rendered) return;
    const ctx = this.sizeCanvas(this.cv);
    ctx.clearRect(0, 0, this.W, this.H);
    for (const s of this.data.strokes) drawStroke(ctx, s, this.W, this.H);
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
      this.cur = { id: uid().replace(/-/g, '').slice(0, 10), t: tool === 'pen' ? 'pen' : 'hl', c: tools.colors[tool], w: tools.widths[tool], p: [] };
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
        drawStroke(this.sizeCanvas(this.cv), s, this.W, this.H);
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
      drawStroke(ctx, this.cur, this.W, this.H);
    });
  }

  // ---------- gomma ----------
  eraseAt(x, y) {
    const W = this.W, H = this.H, px = x * W, py = y * H;
    const r = tools.widths.eraser * W / 1000 / 2 + 1;
    const keep = [];
    for (const s of this.data.strokes) {
      const b = strokeBB(s), m = (r + s.w * W / 1000) / W, mY = (r + s.w * W / 1000) / H;
      if (x < b[0] - m || x > b[2] + m || y < b[1] - mY || y > b[3] + mY) { keep.push(s); continue; }
      if (!this.hitStroke(s, px, py, r + s.w * W / 2000)) keep.push(s);
    }
    if (keep.length !== this.data.strokes.length) {
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
  finishLasso() {
    const L = this.lasso; this.lasso = null; this.clearLive();
    if (!L || L.length < 8) return;
    const W = this.W, H = this.H;
    const strokes = this.data.strokes.filter(s => {
      const p = s.p, step = Math.max(1, Math.floor(p.length / 3 / 30));
      let n = 0, inn = 0;
      for (let i = 0; i < p.length; i += 3 * step) { n++; if (pointInPoly(p[i] * W, p[i + 1] * H, L)) inn++; }
      return n && inn / n >= 0.5;
    });
    const texts = this.data.texts.filter(t => {
      const el = this.textEl(t), hh = el ? el.offsetHeight : 20;
      return pointInPoly(t.x * W + t.w * W / 2, t.y * H + hh / 2, L);
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
      const el = this.textEl(t), hh = (el ? el.offsetHeight : 20) / this.H;
      x1 = Math.min(x1, t.x); y1 = Math.min(y1, t.y); x2 = Math.max(x2, t.x + t.w); y2 = Math.max(y2, t.y + hh);
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
    const strokes = this.sel.strokes.map(s => ({ ...s, id: uid().replace(/-/g, '').slice(0, 10), p:s.p.map((v, i) => i % 3 === 0 ? R5(v + d) : i % 3 === 1 ? R5(v + dy) : v) }));
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
    el.addEventListener('focus', () => { InkSurface.active = this; if (el._before == null) el._before = this.snap(); });
    el.addEventListener('input', () => { t.v = el.innerText.replace(/\n$/, ''); this.emit(); });
    el.addEventListener('blur', () => {
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
      el.style.fontSize = (t.s * W / 1000) + 'px'; el.style.color = t.c;
    }
    for (const el of this.imgLayer.children) {
      const im = el._i; if (!im) continue;
      el.style.left = im.x * W + 'px'; el.style.top = im.y * H + 'px'; el.style.width = im.w * W + 'px'; el.style.height = im.h * H + 'px';
    }
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
    clearTimeout(this._rt);
    if (InkSurface.active === this) InkSurface.active = null;
  }
}

// Barra degli strumenti di scrittura (condivisa tra quaderni e calendario)
export function inkToolbar({ compact = false, lasso = true, text = true, hand = true, extra = [] } = {}) {
  const bar = h('div', { class: 'ink-toolbar' + (compact ? ' compact' : '') });
  const defs = [
    ['pen', 'pen', 'Penna (P)'],
    ['highlighter', 'highlighter', 'Evidenziatore (H)'],
    ['eraser', 'eraser', 'Gomma (E)'],
    lasso && ['lasso', 'lasso', 'Lazo: seleziona, sposta, ridimensiona (L)'],
    text && ['text', 'text', 'Testo da tastiera (T)'],
  ].filter(Boolean);
  const toolBtns = defs.map(([id, ic, label]) => h('button', { class: 'tool-btn', title: label, 'aria-label': label, onclick: () => tools.set({ tool: id }) }, icon(ic)));
  const colors = h('div', { class: 'tb-group tb-colors' });
  const widthKey = () => (tools.tool in RANGES ? tools.tool : null);
  const range = h('input', {
    type: 'range', class: 'tb-width', 'aria-label': 'Spessore',
    oninput: () => { const k = widthKey(); if (k) tools.set({ widths: { ...tools.widths, [k]: Number(range.value) } }); },
  });
  const rangeWrap = h('div', { class: 'tb-group tb-range', title: 'Spessore / dimensione testo' }, range);
  const act = () => InkSurface.active;
  const undo = h('button', { class: 'tool-btn', title: 'Annulla (Ctrl+Z)', 'aria-label': 'Annulla', onclick: () => act() && act().undo() }, icon('undo'));
  const redo = h('button', { class: 'tool-btn', title: 'Ripeti (Ctrl+Y)', 'aria-label': 'Ripeti', onclick: () => act() && act().redo() }, icon('redo'));
  const handBtn = hand ? h('button', { class: 'tool-btn', title: 'Solo penna: il dito scorre, la penna scrive', 'aria-label': 'Solo penna', onclick: () => tools.set({ penOnly: !tools.penOnly }) }, icon('hand')) : null;
  bar.append(h('div', { class: 'tb-group' }, toolBtns), colors, rangeWrap, h('div', { class: 'tb-group' }, undo, redo, handBtn), ...extra);

  function sync() {
    defs.forEach(([id], i) => toolBtns[i].classList.toggle('active', tools.tool === id));
    const t = tools.tool, key = t === 'highlighter' ? 'highlighter' : 'pen';
    colors.hidden = t === 'eraser';
    colors.replaceChildren();
    for (const c of key === 'highlighter' ? HL_COLORS : PEN_COLORS) {
      colors.append(h('button', {
        class: 'swatch' + (tools.colors[key] === c ? ' active' : ''), style: { background: c }, title: c, 'aria-label': 'Colore ' + c,
        onclick: () => tools.set({ colors: { ...tools.colors, [key]: c } }),
      }));
    }
    const custom = h('input', { type: 'color', class: 'color-input', value: tools.colors[key], title: 'Colore personalizzato' });
    custom.addEventListener('change', () => tools.set({ colors: { ...tools.colors, [key]: custom.value } }));
    colors.append(custom);
    const wk = widthKey();
    rangeWrap.hidden = !wk;
    if (wk) { const [mn, mx, st] = RANGES[wk]; range.min = mn; range.max = mx; range.step = st; range.value = tools.widths[wk]; }
    if (handBtn) handBtn.classList.toggle('active', !!tools.penOnly);
  }
  bar.destroy = tools.on(sync);
  sync();
  return bar;
}
