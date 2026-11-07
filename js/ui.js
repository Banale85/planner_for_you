// Mattoncini dell'interfaccia: creazione elementi, finestre, menu, notifiche

import { icon } from './icons.js';
export { icon };

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  let value;
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') {
        if (typeof v === 'string') el.style.cssText = v;
        else for (const s in v) { if (s.startsWith('--')) el.style.setProperty(s, v[s]); else el.style[s] = v[s]; }
      }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  if (value !== undefined) el.value = value;
  return el;
}

// ---------- Finestre modali ----------
const stack = [];
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && stack.length) {
    const top = stack[stack.length - 1];
    if (top.dismissable !== false) { e.preventDefault(); top.close(); }
  }
});

export function modal({ title, body, actions = [], wide = false, dismissable = true, onClose, cls = '' }) {
  const root = document.getElementById('modal-root');
  const overlay = h('div', { class: 'modal-overlay' });
  const box = h('div', { class: 'modal' + (wide ? ' wide' : '') + (cls ? ' ' + cls : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const head = h('div', { class: 'modal-head' },
    h('h2', {}, title),
    h('button', { class: 'icon-btn', 'aria-label': 'Chiudi', onclick: () => close() }, icon('close')));
  const left = actions.filter(a => a.left), right = actions.filter(a => !a.left);
  const mk = a => h('button', { class: 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''), onclick: () => a.onClick ? a.onClick(close) : close() }, a.icon ? icon(a.icon) : null, a.label);
  const foot = h('div', { class: 'modal-foot' }, left.map(mk), h('div', { class: 'grow' }), right.map(mk));
  box.append(head, h('div', { class: 'modal-body' }, body), actions.length ? foot : null);
  overlay.append(box);
  if (dismissable) overlay.addEventListener('pointerdown', e => { if (e.target === overlay) close(); });
  root.append(overlay);
  let closed = false;
  const entry = { close, dismissable };
  stack.push(entry);
  function close() {
    if (closed) return;
    closed = true;
    overlay.remove();
    const i = stack.indexOf(entry); if (i >= 0) stack.splice(i, 1);
    onClose && onClose();
  }
  return { close, el: box };
}

export function promptText(title, { label = '', value = '', placeholder = '', okLabel = 'OK' } = {}) {
  return new Promise(res => {
    let done = false;
    const inp = h('input', { class: 'input', value, placeholder });
    const finish = c => { done = true; res(inp.value.trim()); c(); };
    const m = modal({
      title,
      body: h('div', { class: 'field' }, label ? h('label', {}, label) : null, inp),
      actions: [{ label: 'Annulla' }, { label: okLabel, primary: true, onClick: finish }],
      onClose: () => { if (!done) res(null); },
    });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') finish(m.close); });
    setTimeout(() => { inp.focus(); inp.select(); }, 60);
  });
}

export function confirmDialog(message, { title = 'Conferma', okLabel = 'OK', danger = false } = {}) {
  return new Promise(res => {
    let done = false;
    modal({
      title,
      body: h('p', { class: 'muted' }, message),
      actions: [{ label: 'Annulla' }, { label: okLabel, primary: !danger, danger, onClick: c => { done = true; res(true); c(); } }],
      onClose: () => { if (!done) res(false); },
    });
  });
}

export function chooseDialog(title, message, options) {
  return new Promise(res => {
    let done = false;
    modal({
      title,
      body: h('p', { class: 'muted' }, message),
      actions: [{ label: 'Annulla' }, ...options.map(o => ({ ...o, onClick: c => { done = true; res(o.value); c(); } }))],
      onClose: () => { if (!done) res(null); },
    });
  });
}

// ---------- Notifiche brevi ----------
export function toast(msg, { ms = 2800 } = {}) {
  const root = document.getElementById('toast-root');
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  root.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
  return t;
}

// ---------- Menu a comparsa ----------
let openMenu = null;
export function closeMenu() {
  if (!openMenu) return;
  openMenu.m.remove();
  document.removeEventListener('pointerdown', openMenu.off, true);
  openMenu = null;
}
export function popMenu(anchor, items) {
  closeMenu();
  const m = h('div', { class: 'popmenu', role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it.divider) { m.append(h('hr')); continue; }
    if (it.heading) { m.append(h('div', { class: 'pm-head' }, it.heading)); continue; }
    m.append(h('button', {
      class: (it.danger ? 'danger ' : '') + (it.active ? 'active' : ''), role: 'menuitem',
      onclick: e => { e.stopPropagation(); closeMenu(); it.onClick && it.onClick(); },
    },
      it.swatch ? h('span', { class: 'pm-swatch', style: { background: it.swatch } }) : (it.icon ? icon(it.icon) : h('span', { class: 'icon' })),
      h('span', { class: 'grow' }, it.label),
      it.active ? icon('check') : null));
  }
  document.body.append(m);
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let x = r.left, y = r.bottom + 4;
  if (x + mw > innerWidth - 8) x = Math.max(8, r.right - mw);
  if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 4);
  m.style.left = x + 'px';
  m.style.top = y + 'px';
  const off = e => { if (!m.contains(e.target)) closeMenu(); };
  setTimeout(() => document.addEventListener('pointerdown', off, true));
  openMenu = { m, off };
}
