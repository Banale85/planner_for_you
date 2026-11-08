// Calendario in stile Microsoft Teams: viste Giorno / Settimana lavorativa / Settimana / Mese / Agenda,
// riunioni con partecipanti, link "Partecipa", ricorrenze, promemoria, categorie, trascinamento,
// e scrittura a penna o da tastiera direttamente sopra il calendario e nelle note di ogni evento.

import { db } from './db.js';
import { h, modal, toast, popMenu, confirmDialog, chooseDialog, autoFocus } from './ui.js';
import { icon } from './icons.js';
import { uid, pad, ymd, hm, parseLocal, toLocalISO, addDays, startOfDay, sameDay, startOfWeek, fmt, cap, pickFile, download, debounce, clamp } from './util.js';
import { InkSurface, inkToolbar, tools, emptyInk } from './ink.js';
import { parseICS, toICS } from './ics.js';
import { createLinkedNotebook, paperCanvas } from './notes.js';
import { cats, catOf, catColor, isCream, catHex, loadCats, addCat, catDialog, MAX_CATS } from './categories.js';

// classe CSS degli eventi senza colore (bianco panna)
const creamCls = id => (isCream(id) ? ' cream' : '');
const HOUR = 48;
const VIEWS = { day: 'Giorno', workweek: 'Settimana lavorativa', week: 'Settimana', month: 'Mese', year: 'Anno', agenda: 'Agenda' };
// etichette brevi per i pulsanti delle viste, con la scorciatoia da tastiera
const VIEW_BTNS = [['day', 'Giorno', '1'], ['workweek', 'Lavorativa', '2'], ['week', 'Settimana', '3'], ['month', 'Mese', '4'], ['year', 'Anno', '5'], ['agenda', 'Agenda', '6']];
const TIME_VIEWS = new Set(['day', 'workweek', 'week']);
const SHOW_AS = [['busy', 'Occupato'], ['free', 'Libero'], ['tentative', 'Provvisorio'], ['oof', 'Fuori sede']];
const REMINDERS = [['', 'Nessun promemoria'], ['0', 'All\'inizio'], ['5', '5 minuti prima'], ['15', '15 minuti prima'], ['30', '30 minuti prima'], ['60', '1 ora prima'], ['1440', '1 giorno prima']];

const st = {
  view: VIEWS[localStorage.getItem('pfy-view')] ? localStorage.getItem('pfy-view') : (innerWidth < 700 ? 'day' : 'workweek'),
  date: startOfDay(new Date()),
  writing: false,
  scrollTop: null,
};

// ---------- Ricorrenze ----------
function* iterStarts(ev) {
  const s0 = parseLocal(ev.start), r = ev.rrule;
  if (!r) { yield s0; return; }
  const until = r.until ? addDays(parseLocal(r.until), 1) : null;
  const max = r.count || Infinity, intv = Math.max(1, r.interval || 1);
  let count = 0;
  const ok = d => !(until && d >= until) && count++ < max;
  if (r.freq === 'daily') {
    for (let d = s0; ; d = addDays(d, intv)) { if (!ok(d)) return; yield d; }
  } else if (r.freq === 'weekdays') {
    for (let d = s0; ; d = addDays(d, 1)) {
      const wd = d.getDay();
      if (wd === 0 || wd === 6) { if (until && d >= until) return; continue; }
      if (!ok(d)) return; yield d;
    }
  } else if (r.freq === 'weekly') {
    const days = (r.byDay && r.byDay.length ? [...r.byDay] : [s0.getDay()]).map(d => (d + 6) % 7).sort((a, b) => a - b);
    const wk = startOfWeek(s0);
    for (let w = 0; ; w++) {
      const ws = addDays(wk, w * 7 * intv);
      for (const off of days) {
        const d = addDays(ws, off); d.setHours(s0.getHours(), s0.getMinutes());
        if (d < s0) continue;
        if (!ok(d)) return; yield d;
      }
    }
  } else if (r.freq === 'monthly' || r.freq === 'yearly') {
    for (let k = 0; ; k++) {
      const d = r.freq === 'monthly'
        ? new Date(s0.getFullYear(), s0.getMonth() + k * intv, s0.getDate(), s0.getHours(), s0.getMinutes())
        : new Date(s0.getFullYear() + k * intv, s0.getMonth(), s0.getDate(), s0.getHours(), s0.getMinutes());
      if (until && d >= until) return;
      if (d.getDate() !== s0.getDate()) continue;
      if (!ok(d)) return; yield d;
    }
  }
}
export function expand(events, from, to) {
  const out = [];
  for (const ev of events) {
    const s0 = parseLocal(ev.start), e0 = parseLocal(ev.end);
    if (isNaN(s0)) continue;
    const dur = Math.max(0, e0 - s0), ex = new Set(ev.exdates || []);
    let guard = 0;
    for (const s of iterStarts(ev)) {
      if (++guard > 20000 || s >= to) break;
      const e = new Date(s.getTime() + dur);
      if ((e > from || (dur === 0 && s >= from)) && !ex.has(ymd(s))) out.push({ ev, start: s, end: e, key: ev.id + '|' + ymd(s) });
    }
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

function rangeFor(view, date) {
  switch (view) {
    case 'day': return { from: startOfDay(date), days: 1 };
    case 'workweek': return { from: startOfWeek(date), days: 5 };
    case 'week': return { from: startOfWeek(date), days: 7 };
    case 'month': return { from: startOfWeek(new Date(date.getFullYear(), date.getMonth(), 1)), days: 42 };
    case 'year': { const y = date.getFullYear(); return { from: new Date(y, 0, 1), days: Math.round((new Date(y + 1, 0, 1) - new Date(y, 0, 1)) / 864e5) }; }
    default: return { from: startOfDay(date), days: 30 };
  }
}
function rangeLabel(view, from, days) {
  if (view === 'day') return cap(fmt.full(from));
  if (view === 'month') return cap(fmt.monthYear(st.date));
  if (view === 'year') return String(st.date.getFullYear());
  const to = addDays(from, days - 1);
  if (from.getMonth() === to.getMonth()) return `${from.getDate()}–${to.getDate()} ${fmt.monthYear(to)}`;
  if (from.getFullYear() === to.getFullYear()) return `${fmt.dayMonth(from)} – ${fmt.dayMonth(to)} ${to.getFullYear()}`;
  return `${fmt.dayMonth(from)} ${from.getFullYear()} – ${fmt.dayMonth(to)} ${to.getFullYear()}`;
}
const nextHalfHour = () => { const d = new Date(); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() < 30 ? 30 : 60); return d; };

// Riconosce un tocco (senza trascinamento) con il dito
function tapDetect(e, fn) {
  const x = e.clientX, y = e.clientY, t = Date.now(), id = e.pointerId;
  const up = ev => { if (ev.pointerId !== id) return; clean(); if (Math.hypot(ev.clientX - x, ev.clientY - y) < 10 && Date.now() - t < 700) fn(); };
  const cancel = ev => { if (ev.pointerId === id) clean(); };
  const clean = () => { removeEventListener('pointerup', up); removeEventListener('pointercancel', cancel); };
  addEventListener('pointerup', up);
  addEventListener('pointercancel', cancel);
}

// ---------- Trascinamento con mouse, penna e dito ----------
// Mentre un evento viene trascinato blocchiamo lo scorrimento della pagina (serve su iPad,
// dove sia il dito sia Apple Pencil farebbero scorrere la griglia invece di spostare l'evento).
let dragLock = false, lastDragAt = 0;
document.addEventListener('touchmove', e => { if (dragLock && e.cancelable) e.preventDefault(); }, { passive: false });

// Mouse e penna trascinano subito; con il dito si tiene premuto un attimo e poi si trascina
// (un movimento rapido del dito continua a far scorrere il calendario).
// Restituisce una funzione che interrompe il gesto.
function pressDrag(e, { onTap, onArm, onStart, onMove, onEnd }) {
  const id = e.pointerId, touch = e.pointerType === 'touch', sx = e.clientX, sy = e.clientY, t0 = Date.now();
  const minMove = e.pointerType === 'pen' ? 10 : 5;
  let armed = !touch, dragging = false, ended = false, timer = 0;
  if (armed) dragLock = true;
  else timer = setTimeout(() => { armed = true; dragLock = true; try { navigator.vibrate && navigator.vibrate(12); } catch { /* ignore */ } onArm && onArm(); }, 380);
  const dist = ev => Math.hypot(ev.clientX - sx, ev.clientY - sy);
  const move = ev => {
    if (ev.pointerId !== id) return;
    if (!armed) { if (dist(ev) > 10) finish(null); return; }
    if (!dragging) { if (dist(ev) < minMove) return; dragging = true; lastDragAt = Date.now(); onStart && onStart(ev); }
    lastDragAt = Date.now();
    onMove && onMove(ev);
  };
  const up = ev => { if (ev.pointerId === id) finish(ev); };
  const cancel = ev => { if (ev.pointerId === id) finish(null); };
  function finish(ev) {
    if (ended) return;
    ended = true;
    clearTimeout(timer); dragLock = false;
    removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', cancel);
    if (dragging) { lastDragAt = Date.now(); onEnd && onEnd(ev); return; }
    if (armed && onEnd) onEnd(null); // sollevato senza muoversi dopo la pressione lunga
    if (ev && dist(ev) < 12 && (armed || Date.now() - t0 < 700)) onTap && onTap();
  }
  addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', cancel);
  return () => finish(null);
}

// ---------- Mini calendario (giorni → mesi → anni) ----------
const isoWeek = d => {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(t.getFullYear(), 0, 4);
  return 1 + Math.round(((t - w1) / 864e5 - 3 + ((w1.getDay() + 6) % 7)) / 7);
};
const MONTHS_SHORT = Array.from({ length: 12 }, (_, i) => cap(new Date(2000, i, 1).toLocaleDateString('it-IT', { month: 'short' }).replace('.', '')));

// onPick(tipo, data): tipo = 'day' | 'week' | 'month' | 'year'
function miniCal({ events = [], onPick }) {
  const root = h('div', { class: 'mini' });
  let level = 'days', cur = new Date(st.date.getFullYear(), st.date.getMonth(), 1);
  const now = () => new Date();
  function render() {
    let title, shift, body;
    if (level === 'days') {
      title = cap(fmt.monthYear(cur));
      shift = n => { cur = new Date(cur.getFullYear(), cur.getMonth() + n, 1); };
      const { from, days } = rangeFor(st.view, st.date), rEnd = addDays(from, days);
      const start = startOfWeek(cur), n = now();
      const busy = new Set(expand(events, start, addDays(start, 42)).map(o => ymd(o.start)));
      body = h('div', { class: 'mini-grid' });
      body.append(h('div', { class: 'wd wk-h', title: 'Settimana' }, 'S'));
      for (let i = 0; i < 7; i++) body.append(h('div', { class: 'wd' }, fmt.wdShort(addDays(start, i)).charAt(0).toUpperCase()));
      for (let w = 0; w < 6; w++) {
        const ws = addDays(start, w * 7);
        const wkSel = (st.view === 'week' || st.view === 'workweek') && sameDay(ws, from);
        body.append(h('button', { class: 'wk' + (wkSel ? ' sel' : ''), title: `Vai alla settimana ${isoWeek(ws)}`, 'aria-label': `Settimana ${isoWeek(ws)}`, onclick: () => onPick('week', ws) }, isoWeek(ws)));
        for (let i = 0; i < 7; i++) {
          const d = addDays(ws, i);
          const cls = [d.getMonth() !== cur.getMonth() && 'other', TIME_VIEWS.has(st.view) && d >= from && d < rEnd && 'inrange',
            sameDay(d, n) && 'today', sameDay(d, st.date) && 'sel', busy.has(ymd(d)) && 'busy'].filter(Boolean).join(' ');
          body.append(h('button', { class: 'day ' + cls, 'aria-label': fmt.full(d), onclick: () => onPick('day', d) }, d.getDate()));
        }
      }
    } else if (level === 'months') {
      const y = cur.getFullYear(), n = now();
      title = String(y);
      shift = k => { cur = new Date(y + k, cur.getMonth(), 1); };
      body = h('div', { class: 'mini-grid big' },
        MONTHS_SHORT.map((m, i) => h('button', {
          class: [y === n.getFullYear() && i === n.getMonth() && 'today', y === st.date.getFullYear() && i === st.date.getMonth() && 'sel'].filter(Boolean).join(' '),
          onclick: () => { cur = new Date(y, i, 1); level = 'days'; onPick('month', cur); },
        }, m)));
      body = h('div', {}, body, h('button', { class: 'btn sm mini-year', onclick: () => onPick('year', new Date(y, 0, 1)) }, icon('calendar'), `Vedi tutto il ${y}`));
    } else {
      const y0 = cur.getFullYear() - 4, n = now();
      title = `${y0} – ${y0 + 11}`;
      shift = k => { cur = new Date(cur.getFullYear() + 12 * k, cur.getMonth(), 1); };
      body = h('div', { class: 'mini-grid big' },
        Array.from({ length: 12 }, (_, i) => y0 + i).map(y => h('button', {
          class: [y === n.getFullYear() && 'today', y === st.date.getFullYear() && 'sel'].filter(Boolean).join(' '),
          onclick: () => { cur = new Date(y, cur.getMonth(), 1); level = 'months'; render(); },
        }, y)));
    }
    const next = { days: 'months', months: 'years', years: 'days' }[level];
    root.replaceChildren(
      h('div', { class: 'mini-head' },
        h('button', { class: 'mini-title', title: level === 'days' ? 'Scegli mese e anno' : level === 'months' ? "Scegli l'anno" : 'Torna ai giorni', onclick: () => { level = next; render(); } },
          title, icon(level === 'years' ? 'chevL' : 'chevD')),
        h('div', { class: 'mini-arrows' },
          h('button', { class: 'icon-btn sm', 'aria-label': 'Precedente', onclick: () => { shift(-1); render(); } }, icon('chevL')),
          h('button', { class: 'icon-btn sm', 'aria-label': 'Successivo', onclick: () => { shift(1); render(); } }, icon('chevR')))),
      body);
  }
  render();
  return root;
}

// ---------- Import / export ----------
export async function importICS() {
  const [f] = await pickFile('.ics,text/calendar');
  if (!f) return 0;
  let list;
  try { list = parseICS(await f.text()); } catch (e) { toast('File .ics non valido'); return 0; }
  const existing = await db.all('events');
  const byUid = new Map(existing.filter(e => e.uid).map(e => [e.uid, e]));
  const out = list.map(ev => {
    const old = byUid.get(ev.uid);
    if (old) Object.assign(ev, { id: old.id, ink: old.ink, notes: old.notes || ev.notes, notebookId: old.notebookId, category: old.category });
    return ev;
  });
  await db.putMany('events', out);
  toast(out.length === 1 ? '1 evento importato' : `${out.length} eventi importati`);
  return out.length;
}
export async function exportICS() {
  const events = await db.all('events');
  if (!events.length) { toast('Non ci sono eventi da esportare'); return; }
  download(new Blob([toICS(events)], { type: 'text/calendar' }), 'calendario-planner.ics');
}

// ---------- Promemoria ----------
export function startReminders() {
  const check = async () => {
    let evs;
    try { evs = (await db.all('events')).filter(e => e.reminder != null && e.reminder >= 0 && !e.allDay); } catch { return; }
    if (!evs.length) return;
    const now = new Date();
    const occs = expand(evs, new Date(now - 10 * 60000), new Date(now.getTime() + 2 * 86400000));
    let done;
    try { done = JSON.parse(localStorage.getItem('pfy-notified') || '[]'); } catch { done = []; }
    let changed = false;
    for (const o of occs) {
      const at = o.start - o.ev.reminder * 60000;
      if (now >= at && now < o.start.getTime() + 5 * 60000 && !done.includes(o.key)) { done.push(o.key); changed = true; notify(o); }
    }
    if (changed) try { localStorage.setItem('pfy-notified', JSON.stringify(done.slice(-300))); } catch { /* ignore */ }
  };
  check();
  setInterval(check, 30000);
}
function notify(o) {
  const body = `${hm(o.start)}–${hm(o.end)}${o.ev.location ? ' · ' + o.ev.location : ''}`;
  toast(`🔔 ${o.ev.title} · ${body}`, { ms: 9000 });
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = { body, icon: 'icons/icon-192.png', tag: o.key };
  if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.ready.then(r => r.showNotification(o.ev.title, opts)).catch(() => {});
  else try { new Notification(o.ev.title, opts); } catch { /* non supportato */ }
}

// =====================================================================
// FINESTRA EVENTO / RIUNIONE
// =====================================================================
export function openEditor(o, preset, onSaved) {
  const src = o ? o.ev : null;
  const ev = src ? JSON.parse(JSON.stringify(src)) : {
    id: uid(), title: '', start: toLocalISO(preset.start), end: toLocalISO(preset.end), allDay: !!preset.allDay,
    category: null, showAs: 'busy', reminder: 15, attendees: '', location: '', meetingUrl: '', notes: '',
    ink: emptyInk(), rrule: null, exdates: [], createdAt: Date.now(),
  };
  if (!ev.ink) ev.ink = emptyInk();
  const S = parseLocal(ev.start), E = parseLocal(ev.end);

  const title = h('input', { class: 'evf-title', value: ev.title === '(Senza titolo)' ? '' : ev.title, placeholder: 'Aggiungi un titolo', 'aria-label': 'Titolo' });
  const att = h('input', { class: 'input', value: ev.attendees || '', placeholder: 'Invita partecipanti (email separate da virgola)', 'aria-label': 'Partecipanti' });
  const sd = h('input', { type: 'date', class: 'input sm', value: ymd(S), 'aria-label': 'Data di inizio' });
  const stt = h('input', { type: 'time', class: 'input sm', step: '900', value: hm(S), 'aria-label': 'Ora di inizio' });
  const endShown = ev.allDay ? addDays(E, -1) : E;
  const edI = h('input', { type: 'date', class: 'input sm', value: ymd(endShown), 'aria-label': 'Data di fine' });
  const ett = h('input', { type: 'time', class: 'input sm', step: '900', value: hm(E), 'aria-label': 'Ora di fine' });
  const allDay = h('input', { type: 'checkbox', checked: !!ev.allDay });
  const syncAll = () => { stt.hidden = ett.hidden = allDay.checked; };
  allDay.addEventListener('change', syncAll); syncAll();
  let prevStart = parseLocal(sd.value + 'T' + (stt.value || '00:00'));
  const onStart = () => {
    const ns = parseLocal(sd.value + 'T' + (stt.value || '00:00'));
    const ce = parseLocal(edI.value + 'T' + (ett.value || '00:00'));
    if (!isNaN(ns) && !isNaN(prevStart) && !isNaN(ce)) { const ne = new Date(ce.getTime() + (ns - prevStart)); edI.value = ymd(ne); ett.value = hm(ne); }
    if (!isNaN(ns)) prevStart = ns;
  };
  sd.addEventListener('change', onStart); stt.addEventListener('change', onStart);

  // ricorrenza
  const freqSel = h('select', { class: 'input sm', 'aria-label': 'Ripetizione' },
    [['none', 'Non si ripete'], ['daily', 'Ogni giorno'], ['weekdays', 'Ogni giorno feriale (lun–ven)'], ['weekly', 'Ogni settimana'], ['monthly', 'Ogni mese'], ['yearly', 'Ogni anno']].map(([v, l]) => h('option', { value: v }, l)));
  freqSel.value = (ev.rrule && ev.rrule.freq) || 'none';
  const until = h('input', { type: 'date', class: 'input sm', value: (ev.rrule && ev.rrule.until) || '', 'aria-label': 'Fino al' });
  const untilWrap = h('label', { class: 'inline' }, 'fino al', until);
  const days = new Set((ev.rrule && ev.rrule.byDay) || [S.getDay()]);
  const daysWrap = h('div', { class: 'wd-picker' }, [[1, 'L'], [2, 'M'], [3, 'M'], [4, 'G'], [5, 'V'], [6, 'S'], [0, 'D']].map(([d, l]) => {
    const b = h('button', { class: 'wd' + (days.has(d) ? ' active' : ''), type: 'button', 'aria-label': 'Giorno ' + l, onclick: () => { if (days.has(d)) days.delete(d); else days.add(d); b.classList.toggle('active', days.has(d)); } }, l);
    return b;
  }));
  const syncRep = () => { const f = freqSel.value; untilWrap.hidden = f === 'none'; daysWrap.hidden = f !== 'weekly'; };
  freqSel.addEventListener('change', syncRep); syncRep();

  const loc = h('input', { class: 'input', value: ev.location || '', placeholder: 'Aggiungi un luogo (aula, edificio…)', 'aria-label': 'Luogo' });
  const link = h('input', { class: 'input', type: 'url', value: ev.meetingUrl || '', placeholder: 'Incolla il link della riunione Teams', 'aria-label': 'Link riunione' });
  const joinBtn = h('button', { class: 'btn join', type: 'button', onclick: () => { const u = link.value.trim(); if (u) window.open(u, '_blank', 'noopener'); } }, icon('video'), 'Partecipa');
  const syncJoin = () => { joinBtn.hidden = !link.value.trim(); };
  link.addEventListener('input', syncJoin); syncJoin();

  // categoria: "Nessuna" + quelle create dall'utente + "Nuova" (fino a 10)
  let cat = catOf(ev.category) ? ev.category : null;
  const dot = h('span', { class: 'cat-dot', style: { '--c': catColor(cat) } });
  const chips = h('div', { class: 'cat-chips' });
  const pick = id => { cat = id; dot.style.setProperty('--c', catColor(id)); drawChips(); };
  const drawChips = () => {
    const chip = (id, name, color) => h('button', {
      class: 'cat-chip' + (id === cat ? ' active' : ''), type: 'button', style: { '--c': color }, onclick: () => pick(id),
    }, h('i'), name);
    chips.replaceChildren(
      chip(null, 'Nessuna', 'var(--cream)'),
      ...cats().map(c => chip(c.id, c.name, c.color || 'var(--cream)')),
      cats().length < MAX_CATS ? h('button', {
        class: 'cat-chip add', type: 'button', title: 'Crea una nuova categoria',
        onclick: async () => { const r = await catDialog(); if (!r) return; const c = await addCat(r.name, r.color); if (c) pick(c.id); },
      }, icon('plus'), 'Nuova') : null);
  };
  drawChips();
  const showAs = h('select', { class: 'input sm', 'aria-label': 'Mostra come' }, SHOW_AS.map(([v, l]) => h('option', { value: v }, l)));
  showAs.value = ev.showAs || 'busy';
  const rem = h('select', { class: 'input sm', 'aria-label': 'Promemoria' }, REMINDERS.map(([v, l]) => h('option', { value: v }, l)));
  if (ev.reminder != null && !REMINDERS.some(([v]) => v === String(ev.reminder))) rem.append(h('option', { value: String(ev.reminder) }, ev.reminder + ' minuti prima'));
  rem.value = ev.reminder == null ? '' : String(ev.reminder);

  // note: tastiera + penna
  const notesTA = h('textarea', { class: 'input notes-ta', rows: '7', placeholder: 'Ordine del giorno, appunti, link utili…', 'aria-label': 'Note' });
  notesTA.value = ev.notes || '';
  const inkBox = h('div', { class: 'ev-ink' });
  const tb = inkToolbar({ compact: true, hand: false, penOnly: false });
  const inkWrap = h('div', { class: 'ev-ink-wrap' }, tb, inkBox);
  const hasInk = ev.ink.strokes.length || ev.ink.texts.length;
  const tabK = h('button', { class: 'tab', type: 'button', onclick: () => setTab('k') }, icon('keyboard'), 'Tastiera');
  const tabP = h('button', { class: 'tab', type: 'button', onclick: () => setTab('p') }, icon('pen'), 'Penna');
  const setTab = t => { tabK.classList.toggle('active', t === 'k'); tabP.classList.toggle('active', t === 'p'); notesTA.hidden = t !== 'k'; inkWrap.hidden = t !== 'p'; if (t === 'p' && !['pen', 'highlighter', 'eraser', 'lasso', 'text'].includes(tools.tool)) tools.set({ tool: 'pen' }); };
  setTab(hasInk && !ev.notes ? 'p' : 'k');

  const row = (ic, ...kids) => h('div', { class: 'evf-row' }, h('span', { class: 'evf-ic' }, icon(ic)), h('div', { class: 'evf-ctl' }, ...kids));
  const body = h('div', { class: 'evf' },
    h('div', { class: 'evf-row' }, h('span', { class: 'evf-ic' }, dot), h('div', { class: 'evf-ctl' }, title)),
    row('people', att),
    row('clock', h('div', { class: 'dt' }, sd, stt, h('span', { class: 'dt-sep' }, '→'), edI, ett, h('label', { class: 'inline' }, allDay, 'Tutto il giorno'))),
    row('repeat', h('div', { class: 'dt' }, freqSel, untilWrap), daysWrap),
    row('location', loc),
    row('video', h('div', { class: 'dt nowrap' }, link, joinBtn)),
    row('bell', h('div', { class: 'dt' }, rem, showAs)),
    row('tag', chips),
    h('div', { class: 'evf-notes' }, h('div', { class: 'tabs' }, tabK, tabP), notesTA, inkWrap));
  if (src && src.rrule) body.prepend(h('div', { class: 'note-bar' }, icon('repeat'), 'Evento ricorrente: le modifiche valgono per tutta la serie.'));

  let surface = null;
  const collect = () => {
    ev.title = title.value.trim() || '(Senza titolo)';
    ev.attendees = att.value.trim(); ev.location = loc.value.trim(); ev.meetingUrl = link.value.trim(); ev.notes = notesTA.value;
    ev.allDay = allDay.checked;
    const sdv = sd.value || ymd(new Date());
    if (ev.allDay) {
      const s = parseLocal(sdv); let e = parseLocal(edI.value || sdv);
      if (isNaN(e) || e < s) e = s;
      ev.start = toLocalISO(s); ev.end = toLocalISO(addDays(e, 1));
    } else {
      const s = parseLocal(sdv + 'T' + (stt.value || '09:00'));
      let e = parseLocal((edI.value || sdv) + 'T' + (ett.value || '09:30'));
      if (isNaN(e) || !(e > s)) e = new Date(s.getTime() + 30 * 60000);
      ev.start = toLocalISO(s); ev.end = toLocalISO(e);
    }
    const f = freqSel.value;
    if (f === 'none') ev.rrule = null;
    else {
      const r = { freq: f, interval: (ev.rrule && ev.rrule.freq === f && ev.rrule.interval) || 1, until: until.value || null };
      if (f === 'weekly') r.byDay = days.size ? [...days] : [parseLocal(ev.start).getDay()];
      if (!r.until && src && src.rrule && src.rrule.freq === f && src.rrule.count) r.count = src.rrule.count;
      ev.rrule = r;
    }
    ev.category = cat; ev.showAs = showAs.value;
    ev.reminder = rem.value === '' ? null : Number(rem.value);
    ev.updatedAt = Date.now();
    if (isNaN(parseLocal(ev.start))) { toast('Data non valida'); return false; }
    return true;
  };
  // Prima di leggere i campi, chiude la scrittura in corso: su iPad la parola appena scritta
  // (tastiera con suggerimenti o penna con Scribble) viene confermata solo quando il campo si chiude.
  const commitTyping = async () => {
    const a = document.activeElement;
    if (a && body.contains(a) && a !== document.body) { a.blur(); await new Promise(r => setTimeout(r, 60)); }
  };
  const save = async close => { await commitTyping(); if (!collect()) return; await db.put('events', ev); close(); onSaved && onSaved(); };
  const openNotes = async close => {
    await commitTyping();
    if (!collect()) return;
    let nbId = ev.notebookId && (await db.get('notebooks', ev.notebookId)) ? ev.notebookId : null;
    if (!nbId) { nbId = await createLinkedNotebook(ev, catHex(ev.category)); ev.notebookId = nbId; }
    await db.put('events', ev);
    close();
    location.hash = '#/notebook/' + nbId;
  };
  const del = async close => {
    if (src.rrule && o) {
      const v = await chooseDialog('Elimina evento ricorrente', `Vuoi eliminare solo l'occorrenza del ${fmt.dayMonth(o.start)} o tutta la serie?`, [
        { label: 'Solo questa', value: 'one' }, { label: 'Tutta la serie', value: 'all', danger: true }]);
      if (!v) return;
      if (v === 'one') { const copy = JSON.parse(JSON.stringify(src)); copy.exdates = [...(copy.exdates || []), ymd(o.start)]; await db.put('events', copy); }
      else await db.del('events', src.id);
    } else {
      if (!await confirmDialog(`Eliminare "${src.title}"?`, { title: 'Elimina evento', okLabel: 'Elimina', danger: true })) return;
      await db.del('events', src.id);
    }
    close(); onSaved && onSaved();
  };

  const actions = [];
  if (src) actions.push({ label: 'Elimina', icon: 'trash', danger: true, left: true, onClick: del });
  actions.push({ label: ev.notebookId ? 'Apri appunti' : 'Prendi appunti', icon: 'notes', left: true, onClick: openNotes });
  actions.push({ label: 'Annulla' }, { label: 'Salva', primary: true, onClick: save });
  const m = modal({
    title: src ? 'Modifica evento' : 'Nuova riunione', body, wide: true, dismissable: false, actions, cls: 'event-modal',
    onClose: () => { if (surface) surface.destroy(); tb.destroy(); },
  });
  surface = new InkSurface(inkBox, { data: ev.ink, drawBackground: (W, H, d, dark) => paperCanvas(W, H, d, 'lined', 'white', dark) });
  if (!src) autoFocus(title);
  return m;
}

// =====================================================================
// VISTA CALENDARIO
// =====================================================================
export async function renderCalendar(host) {
  const wrap = h('div', { class: 'cal' + (st.writing ? ' writing' : '') });
  let overlay = null, timers = [], destroyed = false, allEvents = [], stopDrag = () => {};

  const setView = v => { st.view = v; try { localStorage.setItem('pfy-view', v); } catch { /* ignore */ } };
  const rangeTxt = h('span', {});
  const rangeLbl = h('button', { class: 'cal-range', title: 'Scegli una data', 'aria-haspopup': 'dialog', onclick: () => openPicker() }, rangeTxt, icon('chevD'));
  const viewSel = h('select', { class: 'input sm view-sel', 'aria-label': 'Vista', onchange: () => { setView(viewSel.value); draw(); } },
    Object.entries(VIEWS).map(([k, v]) => h('option', { value: k }, v)));
  const viewSeg = h('div', { class: 'view-seg', role: 'tablist', 'aria-label': 'Vista' },
    VIEW_BTNS.map(([k, label, key]) => h('button', { role: 'tab', 'data-v': k, title: `${VIEWS[k]} (${key})`, onclick: () => { if (st.writing && (k === 'agenda' || k === 'year')) return; setView(k); draw(); } }, label)));
  // pannello laterale: su schermi larghi si può nascondere, su quelli stretti si apre sopra il calendario
  const narrow = () => innerWidth < 900;
  let sideOff = false;
  try { sideOff = localStorage.getItem('pfy-cal-side') === '0'; } catch { /* ignore */ }
  const sideBtn = h('button', { class: 'icon-btn', title: 'Mostra / nascondi il mini calendario', 'aria-label': 'Mini calendario', onclick: () => toggleSide() }, icon('sidebar'));
  function toggleSide(v) {
    if (narrow()) { wrap.classList.toggle('side-open', v === undefined ? !wrap.classList.contains('side-open') : v); return; }
    sideOff = v === undefined ? !sideOff : !v;
    wrap.classList.toggle('side-off', sideOff);
    try { localStorage.setItem('pfy-cal-side', sideOff ? '0' : '1'); } catch { /* ignore */ }
  }
  wrap.classList.toggle('side-off', sideOff);

  // scelta dal mini calendario
  function pick(kind, d) {
    if (kind === 'day') {
      // secondo tocco sullo stesso giorno, oppure da Mese/Anno → vista Giorno
      if (sameDay(d, st.date) || st.view === 'month' || st.view === 'year') setView('day');
      st.date = startOfDay(d);
    } else if (kind === 'week') { setView(st.view === 'workweek' ? 'workweek' : 'week'); st.date = d; }
    else if (kind === 'month') { setView('month'); st.date = d; }
    else if (kind === 'year') { setView('year'); st.date = d; }
    if (st.writing && (st.view === 'agenda' || st.view === 'year')) setView('week');
    st.scrollTop = null;
    if (narrow()) wrap.classList.remove('side-open');
    draw();
  }
  let picker = null;
  function closePicker() { if (!picker) return; picker.el.remove(); document.removeEventListener('pointerdown', picker.off, true); picker = null; }
  function openPicker() {
    if (picker) { closePicker(); return; }
    const el = h('div', { class: 'popmenu cal-pop', role: 'dialog', 'aria-label': 'Scegli una data' },
      miniCal({ events: allEvents, onPick: (k, d) => { closePicker(); pick(k, d); } }),
      h('div', { class: 'cal-pop-foot' },
        h('button', { class: 'btn sm', onclick: () => { closePicker(); st.date = startOfDay(new Date()); st.scrollTop = null; draw(); } }, 'Oggi')));
    document.body.append(el);
    const r = rangeLbl.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(r.left, innerWidth - el.offsetWidth - 8)) + 'px';
    el.style.top = Math.min(r.bottom + 4, innerHeight - el.offsetHeight - 8) + 'px';
    const off = e => { if (!el.contains(e.target) && !rangeLbl.contains(e.target)) closePicker(); };
    setTimeout(() => document.addEventListener('pointerdown', off, true));
    picker = { el, off };
  }
  const writeBtn = h('button', { class: 'btn write-btn', title: 'Scrivi a penna o con la tastiera sul calendario', onclick: () => toggleWrite() }, icon('pen'), h('span', { class: 'hide-sm' }, 'Scrivi'));
  const newBtn = h('button', { class: 'btn primary', onclick: () => { const s = nextHalfHour(); const d = sameDay(s, st.date) || st.view !== 'day' ? s : new Date(st.date.getFullYear(), st.date.getMonth(), st.date.getDate(), 9); openEditor(null, { start: d, end: new Date(d.getTime() + 30 * 60000) }, draw); } }, icon('plus'), h('span', {}, 'Nuova riunione'));
  const head = h('div', { class: 'topbar' },
    h('h1', {}, icon('calendar'), 'Calendario'),
    h('div', { class: 'grow' }),
    writeBtn,
    h('button', {
      class: 'icon-btn', title: 'Importa / esporta', 'aria-label': 'Importa o esporta', onclick: e => popMenu(e.currentTarget, [
        { label: 'Importa calendario Teams/Outlook (.ics)', icon: 'upload', onClick: async () => { if (await importICS()) draw(); } },
        { label: 'Esporta calendario (.ics)', icon: 'download', onClick: exportICS },
      ]),
    }, icon('more')),
    newBtn);
  const nav = h('div', { class: 'cal-nav' },
    sideBtn,
    h('button', { class: 'btn', title: 'Vai a oggi (T)', onclick: () => { st.date = startOfDay(new Date()); st.scrollTop = null; draw(); } }, 'Oggi'),
    h('button', { class: 'icon-btn', title: 'Precedente (←)', 'aria-label': 'Precedente', onclick: () => step(-1) }, icon('chevL')),
    h('button', { class: 'icon-btn', title: 'Successivo (→)', 'aria-label': 'Successivo', onclick: () => step(1) }, icon('chevR')),
    rangeLbl, h('div', { class: 'grow' }), viewSeg, viewSel);
  const calTb = inkToolbar({});
  const inkRow = h('div', { class: 'cal-inkbar' },
    calTb,
    h('div', { class: 'grow' }),
    h('button', { class: 'btn primary', onclick: () => toggleWrite(false) }, icon('check'), 'Fine'));
  inkRow.hidden = !st.writing;
  const side = h('aside', { class: 'cal-side' });
  const main = h('div', { class: 'cal-main' });
  wrap.append(head, nav, inkRow, h('div', { class: 'cal-body' }, side, main));
  host.append(wrap);

  function step(dir) {
    const d = st.date;
    if (st.view === 'day') st.date = addDays(d, dir);
    else if (st.view === 'month') st.date = new Date(d.getFullYear(), d.getMonth() + dir, 1);
    else if (st.view === 'year') st.date = new Date(d.getFullYear() + dir, 0, 1);
    else if (st.view === 'agenda') st.date = addDays(d, 30 * dir);
    else st.date = addDays(d, 7 * dir);
    main.classList.remove('slide-l', 'slide-r');
    void main.offsetWidth;
    main.classList.add(dir > 0 ? 'slide-l' : 'slide-r');
    draw();
  }
  function toggleWrite(v) {
    st.writing = v === undefined ? !st.writing : v;
    if (st.writing && (st.view === 'agenda' || st.view === 'year')) { setView('week'); draw(); }
    wrap.classList.toggle('writing', st.writing);
    inkRow.hidden = !st.writing;
    writeBtn.classList.toggle('active', st.writing);
    if (overlay) overlay.updateMode();
  }
  writeBtn.classList.toggle('active', st.writing);

  async function mountOverlay(el, key) {
    const rec = (await db.get('calink', key)) || { key, strokes: [], texts: [], images: [] };
    if (destroyed || !el.isConnected) return;
    const save = debounce(() => db.put('calink', rec), 500);
    // adaptText: false perché i testi sul calendario sono foglietti gialli, sempre chiari
    overlay = new InkSurface(el, { data: rec, onChange: () => save(), enabled: () => st.writing, adaptText: false });
    overlay.flush = save.flush;
  }

  async function draw() {
    if (destroyed) return;
    if (overlay) { overlay.flush(); overlay.destroy(); overlay = null; }
    timers.forEach(clearInterval); timers = [];
    stopDrag(); stopDrag = () => {};
    viewSel.value = st.view;
    for (const b of viewSeg.children) { const on = b.dataset.v === st.view; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); }
    const { from, days } = rangeFor(st.view, st.date);
    const events = await db.all('events');
    if (destroyed) return;
    allEvents = events;
    const occs = expand(events, from, addDays(from, days));
    rangeTxt.textContent = rangeLabel(st.view, from, days);
    main.replaceChildren();
    if (st.view === 'month') drawMonth(from, occs);
    else if (st.view === 'year') drawYear(occs);
    else if (st.view === 'agenda') drawAgenda(from, days, occs);
    else drawTimeGrid(from, days, occs);
    drawMini();
  }

  // Sposta un evento (anche ricorrente) e offre "Annulla"
  async function moveEvent(o, ns, ne) {
    const ev = o.ev, now = Date.now();
    const before = JSON.parse(JSON.stringify(ev));
    let created = null;
    if (ev.rrule) {
      const v = await chooseDialog('Sposta evento ricorrente', `Vuoi spostare solo l'occorrenza del ${fmt.dayMonth(o.start)} o tutta la serie?`, [
        { label: 'Solo questa', value: 'one' },
        { label: 'Tutta la serie', value: 'all', primary: true },
      ]);
      if (!v) { draw(); return; }
      if (v === 'one') {
        created = { ...JSON.parse(JSON.stringify(ev)), id: uid(), rrule: null, exdates: [], start: toLocalISO(ns), end: toLocalISO(ne), createdAt: now, updatedAt: now };
        await db.put('events', { ...ev, exdates: [...(ev.exdates || []), ymd(o.start)], updatedAt: now });
        await db.put('events', created);
      } else {
        const dd = Math.round((startOfDay(ns) - startOfDay(o.start)) / 864e5);
        const ns0 = addDays(parseLocal(ev.start), dd); ns0.setHours(ns.getHours(), ns.getMinutes());
        const ne0 = new Date(ns0.getTime() + (ne - ns));
        const r = { ...ev.rrule };
        if (r.byDay && dd) r.byDay = r.byDay.map(x => (((x + dd) % 7) + 7) % 7);
        const exdates = (ev.exdates || []).map(x => ymd(addDays(parseLocal(x), dd)));
        await db.put('events', { ...ev, rrule: r, exdates, start: toLocalISO(ns0), end: toLocalISO(ne0), updatedAt: now });
      }
    } else {
      await db.put('events', { ...ev, start: toLocalISO(ns), end: toLocalISO(ne), updatedAt: now });
    }
    await draw();
    const when = o.ev.allDay || st.view === 'month' ? fmt.dayMonth(ns) : `${cap(fmt.wdShort(ns))} ${ns.getDate()}, ${hm(ns)}`;
    toast(`Spostato: ${when}`, {
      ms: 5000,
      action: {
        label: 'Annulla', onClick: async () => {
          await db.put('events', { ...before, updatedAt: Date.now() });
          if (created) await db.del('events', created.id);
          draw();
        },
      },
    });
  }

  const chip = (o, withTime) => {
    const c = h('div', { class: 'chip' + creamCls(o.ev.category), style: { '--c': catColor(o.ev.category) }, title: o.ev.title },
      withTime && !o.ev.allDay ? h('b', {}, hm(o.start) + ' ') : null, o.ev.title || '(Senza titolo)');
    // il clic non deve arrivare alla cella (che creerebbe un nuovo evento)
    c.addEventListener('click', e => e.stopPropagation());
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('pointerdown', e => {
      if (st.writing || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.stopPropagation();
      if (e.pointerType === 'mouse') e.preventDefault();
      const kind = c.closest('.mv-cell') ? '.mv-cell' : '.tg-allday .cell';
      const src = c.closest(kind);
      let ghost = null, target = null, ox = 0, oy = 0;
      const setTarget = cell => { if (cell === target) return; if (target) target.classList.remove('drop-target'); target = cell; if (cell) cell.classList.add('drop-target'); };
      stopDrag = pressDrag(e, {
        onTap: () => openEditor(o, null, draw),
        onArm: () => c.classList.add('lifted'),
        onStart: ev => {
          const r = c.getBoundingClientRect();
          ox = ev.clientX - r.left; oy = ev.clientY - r.top;
          ghost = c.cloneNode(true);
          ghost.classList.add('chip-ghost');
          Object.assign(ghost.style, { width: r.width + 'px', left: r.left + 'px', top: r.top + 'px' });
          document.body.append(ghost);
          c.classList.add('drag-src');
        },
        onMove: ev => {
          ghost.style.left = ev.clientX - ox + 'px'; ghost.style.top = ev.clientY - oy + 'px';
          const under = document.elementFromPoint(ev.clientX, ev.clientY);
          setTarget(under && under.closest(kind));
        },
        onEnd: ev => {
          if (ghost) ghost.remove();
          const t = target; setTarget(null);
          c.classList.remove('drag-src', 'lifted');
          if (!ev || !t || !t._day || !src || !src._day) return;
          const dd = Math.round((t._day - src._day) / 864e5);
          if (dd) moveEvent(o, addDays(o.start, dd), addDays(o.end, dd));
        },
      });
    });
    return c;
  };

  // ----- Giorno / Settimana -----
  function drawTimeGrid(from, nDays, occs) {
    const days = Array.from({ length: nDays }, (_, i) => addDays(from, i));
    const now = new Date();
    const grid = h('div', { class: 'tg', style: { '--days': nDays, '--hour': HOUR + 'px' } });
    const headRow = h('div', { class: 'tg-row tg-head' }, h('div', { class: 'tg-gutter' }),
      days.map(d => h('button', { class: 'tg-dayhead' + (sameDay(d, now) ? ' today' : ''), onclick: () => { if (st.writing) return; st.view = 'day'; st.date = d; draw(); } },
        h('span', { class: 'num' }, d.getDate()), h('span', { class: 'wd' }, cap(nDays > 5 && innerWidth < 900 ? fmt.wdShort(d) : fmt.wdLong(d))))));
    const allday = h('div', { class: 'tg-row tg-allday' }, h('div', { class: 'tg-gutter' }),
      days.map(d => {
        const cell = h('div', { class: 'cell' });
        cell._day = d;
        const dEnd = addDays(d, 1);
        for (const o of occs) if (o.ev.allDay && o.start < dEnd && o.end > d) cell.append(chip(o));
        cell.addEventListener('click', () => { if (!st.writing) openEditor(null, { start: d, end: dEnd, allDay: true }, draw); });
        return cell;
      }));
    const content = h('div', { class: 'tg-content', style: { height: 24 * HOUR + 'px' } });
    const times = h('div', { class: 'tg-times' });
    for (let i = 1; i < 24; i++) times.append(h('span', { style: { top: i * HOUR + 'px' } }, pad(i) + ':00'));
    content.append(times);

    const cols = days.map(d => {
      const col = h('div', { class: 'tg-col' + (sameDay(d, now) ? ' today' : '') });
      col._day = d;
      const dEnd = addDays(d, 1);
      const items = occs.filter(o => !o.ev.allDay && o.start < dEnd && (o.end > d || (o.end - o.start === 0 && o.start >= d))).map(o => {
        const s = Math.max(o.start, d), e = Math.min(o.end, dEnd);
        const sm = (s - d) / 60000;
        return { o, s: sm, e: Math.max((e - d) / 60000, sm + 15) };
      });
      layoutDay(items);
      for (const it of items) col.append(evEl(it, col));
      if (sameDay(d, now)) {
        const line = h('div', { class: 'now-line' });
        const upd = () => { const n = new Date(); line.style.top = ((n - startOfDay(n)) / 3600000 * HOUR) + 'px'; };
        upd(); timers.push(setInterval(upd, 60000));
        col.append(line);
      }
      return col;
    });
    content.append(...cols);
    let cleanupDrag = null;
    let colRects = null;
    const colAt = x => { colRects = colRects || cols.map(c => c.getBoundingClientRect()); return colRects.findIndex(r => x >= r.left && x < r.right); };

    // clic / trascinamento su area vuota → nuova riunione
    content.addEventListener('pointerdown', e => {
      if (st.writing) return;
      const col = e.target.closest('.tg-col');
      if (!col || e.target.closest('.ev')) return;
      const r = col.getBoundingClientRect();
      const slot = y => clamp(Math.floor((y - r.top) / HOUR * 2) * 30, 0, 1410);
      const a = slot(e.clientY);
      const openAt = (s, en) => { const d = col._day; openEditor(null, { start: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, s), end: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, en) }, draw); };
      if (e.pointerType === 'touch') { tapDetect(e, () => openAt(a, a + 30)); return; }
      if (e.button !== 0) return;
      e.preventDefault();
      const ghost = h('div', { class: 'ev-ghost' });
      col.append(ghost);
      let s = a, en = a + 30;
      const upd = () => { ghost.style.top = s / 60 * HOUR + 'px'; ghost.style.height = (en - s) / 60 * HOUR + 'px'; ghost.textContent = `${pad(Math.floor(s / 60))}:${pad(s % 60)} – ${pad(Math.floor(en / 60) % 24)}:${pad(en % 60)}`; };
      upd();
      const move = ev => { const b = slot(ev.clientY); s = Math.min(a, b); en = Math.max(a, b) + 30; upd(); };
      const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); cleanupDrag = null; ghost.remove(); openAt(s, en); };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
      cleanupDrag = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    });

    function evEl(it, col) {
      const { o } = it;
      const height = Math.max((it.e - it.s) / 60 * HOUR - 2, 18);
      const meta = h('div', { class: 'ev-meta' }, `${hm(o.start)} – ${hm(o.end)}`, o.ev.location ? ' · ' + o.ev.location : '');
      const el = h('div', {
        class: 'ev' + (height < 40 ? ' short' : '') + ' show-' + (o.ev.showAs || 'busy') + creamCls(o.ev.category),
        style: { top: it.s / 60 * HOUR + 'px', height: height + 'px', left: `calc(${it.col / it.n * 100}% + 2px)`, width: `calc(${100 / it.n}% - 4px)`, '--c': catColor(o.ev.category) },
        title: `${o.ev.title}\n${hm(o.start)} – ${hm(o.end)}${o.ev.location ? '\n' + o.ev.location : ''}`,
      },
        h('div', { class: 'ev-title' }, o.ev.meetingUrl ? icon('video', 'ev-ic') : null, o.ev.rrule ? icon('repeat', 'ev-ic') : null, o.ev.notebookId ? icon('notes', 'ev-ic') : null, o.ev.title || '(Senza titolo)'),
        meta,
        o.ev.rrule ? null : h('div', { class: 'ev-resize' }));
      el.addEventListener('contextmenu', e => e.preventDefault());
      el.addEventListener('pointerdown', e => {
        if (st.writing || (e.pointerType === 'mouse' && e.button !== 0)) return;
        e.stopPropagation();
        if (e.pointerType === 'mouse') e.preventDefault();
        const resize = e.target.classList.contains('ev-resize');
        const sy = e.clientY, st0 = scroller.scrollTop, origIdx = cols.indexOf(col), dur = o.end - o.start;
        let ns = o.start, ne = o.end, last = e, raf = 0;
        const apply = ev => {
          // anche lo scorrimento automatico conta come spostamento
          const dmin = Math.round((ev.clientY - sy + scroller.scrollTop - st0) / HOUR * 4) * 15;
          if (resize) {
            ne = new Date(Math.max(o.start.getTime() + 15 * 60000, o.end.getTime() + dmin * 60000));
            el.style.height = Math.max((ne - Math.max(o.start, col._day)) / 3600000 * HOUR - 2, 18) + 'px';
          } else {
            const ci = colAt(ev.clientX), dd = ci >= 0 ? ci - origIdx : 0;
            ns = new Date(addDays(o.start, dd).getTime() + dmin * 60000); ne = new Date(ns.getTime() + dur);
            const dx = ci >= 0 ? colRects[ci].left - colRects[origIdx].left : 0;
            el.style.transform = `translate(${dx}px, ${dmin / 60 * HOUR}px)`;
          }
          meta.textContent = `${hm(ns)} – ${hm(ne)}`;
        };
        // vicino ai bordi la griglia scorre da sola
        const autoScroll = () => {
          // solo se ci si è spostati verso quel bordo (afferrare un evento già vicino al bordo non deve far scorrere)
          const r = scroller.getBoundingClientRect(), y = last.clientY, edge = 44;
          const v = y < r.top + edge && y < sy - 12 ? -(r.top + edge - y) : y > r.bottom - edge && y > sy + 12 ? y - (r.bottom - edge) : 0;
          if (v) { const before = scroller.scrollTop; scroller.scrollTop += Math.sign(v) * Math.min(18, Math.ceil(Math.abs(v) / 3)); if (scroller.scrollTop !== before) apply(last); }
          raf = requestAnimationFrame(autoScroll);
        };
        const reset = () => { el.style.transform = ''; el.classList.remove('dragging', 'lifted'); meta.textContent = `${hm(o.start)} – ${hm(o.end)}`; };
        stopDrag = pressDrag(e, {
          onTap: () => openEditor(o, null, draw),
          onArm: () => el.classList.add('lifted'),
          onStart: () => { colRects = null; el.classList.add('dragging'); raf = requestAnimationFrame(autoScroll); },
          onMove: ev => { last = ev; apply(ev); },
          onEnd: ev => {
            cancelAnimationFrame(raf);
            if (!ev || (+ns === +o.start && +ne === +o.end)) { reset(); return; }
            el.classList.remove('lifted');
            moveEvent(o, ns, ne);
          },
        });
      });
      return el;
    }

    const ov = h('div', { class: 'cal-ink' });
    content.append(ov);
    const scroller = h('div', { class: 'tg-scroll' }, content);
    grid.append(headRow, allday, scroller);
    main.append(grid);
    const hasToday = days.some(d => sameDay(d, now));
    scroller.scrollTop = st.scrollTop != null ? st.scrollTop : (hasToday ? Math.max(0, (now.getHours() - 1.5) * HOUR) : 7.5 * HOUR);
    scroller.addEventListener('scroll', () => { st.scrollTop = scroller.scrollTop; colRects = null; });
    mountOverlay(ov, `${st.view}|${ymd(from)}`);
    stopDrag = () => cleanupDrag && cleanupDrag();
  }

  function layoutDay(items) {
    items.sort((a, b) => a.s - b.s || b.e - a.e);
    let cluster = [], end = -1;
    const flush = () => {
      const colsEnd = [];
      for (const it of cluster) {
        let c = colsEnd.findIndex(x => x <= it.s);
        if (c < 0) { c = colsEnd.length; colsEnd.push(it.e); } else colsEnd[c] = it.e;
        it.col = c;
      }
      for (const it of cluster) it.n = colsEnd.length;
      cluster = [];
    };
    for (const it of items) {
      if (cluster.length && it.s >= end) flush();
      cluster.push(it);
      end = cluster.length === 1 ? it.e : Math.max(end, it.e);
    }
    if (cluster.length) flush();
  }

  // ----- Mese -----
  function drawMonth(from, occs) {
    const now = new Date(), month = st.date.getMonth();
    const wdNames = Array.from({ length: 7 }, (_, i) => cap(fmt.wdShort(addDays(from, i))));
    const headRow = h('div', { class: 'mv-head' }, wdNames.map(n => h('div', {}, n)));
    const gridEl = h('div', { class: 'mv-grid' });
    for (let i = 0; i < 42; i++) {
      const d = addDays(from, i), dEnd = addDays(d, 1);
      const list = occs.filter(o => o.start < dEnd && (o.end > d || o.start >= d));
      const max = 3;
      const cell = h('div', { class: 'mv-cell' + (d.getMonth() !== month ? ' other' : '') + (sameDay(d, now) ? ' today' : '') },
        h('button', { class: 'mv-num', onclick: e => { e.stopPropagation(); if (st.writing) return; st.view = 'day'; st.date = d; draw(); } }, d.getDate() === 1 ? `${d.getDate()} ${fmt.dayMonthShort(d).split(' ')[1]}` : d.getDate()),
        list.slice(0, max).map(o => chip(o, true)),
        list.length > max ? h('button', { class: 'mv-more', onclick: e => { e.stopPropagation(); st.view = 'day'; st.date = d; draw(); } }, `+${list.length - max} altri`) : null);
      cell._day = d;
      cell.addEventListener('click', () => { if (st.writing) return; const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9); openEditor(null, { start: s, end: new Date(s.getTime() + 30 * 60000) }, draw); });
      gridEl.append(cell);
    }
    const ov = h('div', { class: 'cal-ink month' });
    gridEl.append(ov);
    main.append(h('div', { class: 'mv' }, headRow, gridEl));
    mountOverlay(ov, `month|${ymd(from)}`);
  }

  // ----- Agenda -----
  function drawAgenda(from, nDays, occs) {
    const list = h('div', { class: 'agenda' });
    const now = new Date();
    let any = false;
    for (let i = 0; i < nDays; i++) {
      const d = addDays(from, i), dEnd = addDays(d, 1);
      const items = occs.filter(o => o.start < dEnd && (o.end > d || o.start >= d));
      if (!items.length) continue;
      any = true;
      list.append(h('div', { class: 'ag-day' + (sameDay(d, now) ? ' today' : '') },
        h('div', { class: 'ag-date' }, h('span', { class: 'num' }, d.getDate()), h('span', {}, cap(fmt.wdLong(d)) + ', ' + fmt.monthYear(d))),
        items.map(o => {
          const c = catOf(o.ev.category) || {};
          return h('div', { class: 'ag-item' + creamCls(o.ev.category), style: { '--c': catColor(o.ev.category) }, onclick: () => openEditor(o, null, draw) },
            h('div', { class: 'ag-time' }, o.ev.allDay ? 'Tutto il giorno' : [h('div', {}, hm(o.start)), h('div', { class: 'muted' }, hm(o.end))]),
            h('div', { class: 'ag-bar' }),
            h('div', { class: 'ag-main' },
              h('div', { class: 'ag-title' }, o.ev.title),
              h('div', { class: 'ag-meta' }, [c.name, o.ev.location, o.ev.attendees && `${o.ev.attendees.split(',').filter(Boolean).length} partecipanti`].filter(Boolean).join(' · '))),
            o.ev.meetingUrl ? h('button', { class: 'btn join', onclick: e => { e.stopPropagation(); window.open(o.ev.meetingUrl, '_blank', 'noopener'); } }, icon('video'), 'Partecipa') : null);
        })));
    }
    if (!any) list.append(h('div', { class: 'empty' }, icon('calendar'), h('h3', {}, 'Nessun evento nei prossimi 30 giorni'), h('p', {}, 'Crea una riunione o importa il tuo calendario di Teams.'),
      h('div', { class: 'empty-actions' }, h('button', { class: 'btn primary', onclick: () => newBtn.click() }, icon('plus'), 'Nuova riunione'), h('button', { class: 'btn', onclick: async () => { if (await importICS()) draw(); } }, icon('upload'), 'Importa .ics'))));
    main.append(list);
  }

  // ----- Anno: 12 mesi, tocca un giorno per aprirlo -----
  function drawYear(occs) {
    const y = st.date.getFullYear(), now = new Date();
    const count = new Map();
    for (const o of occs) { const k = ymd(o.start); count.set(k, (count.get(k) || 0) + 1); }
    const wrapY = h('div', { class: 'yv' });
    for (let mI = 0; mI < 12; mI++) {
      const first = new Date(y, mI, 1), start = startOfWeek(first);
      const grid = h('div', { class: 'mini-grid yv-grid' });
      for (let i = 0; i < 7; i++) grid.append(h('div', { class: 'wd' }, fmt.wdShort(addDays(start, i)).charAt(0).toUpperCase()));
      for (let i = 0; i < 42; i++) {
        const d = addDays(start, i);
        if (d.getMonth() !== mI) { grid.append(h('span', {})); continue; }
        const n = count.get(ymd(d)) || 0;
        grid.append(h('button', {
          class: 'day' + (sameDay(d, now) ? ' today' : '') + (n ? ' busy' : ''),
          title: n ? `${fmt.full(d)} · ${n} event${n > 1 ? 'i' : 'o'}` : fmt.full(d),
          onclick: () => { setView('day'); st.date = d; st.scrollTop = null; draw(); },
        }, d.getDate()));
      }
      wrapY.append(h('div', { class: 'yv-month' + (y === now.getFullYear() && mI === now.getMonth() ? ' current' : '') },
        h('button', { class: 'yv-title', title: 'Apri il mese', onclick: () => { setView('month'); st.date = first; draw(); } }, cap(first.toLocaleDateString('it-IT', { month: 'long' }))),
        grid));
    }
    main.append(wrapY);
  }

  // ----- Mini calendario laterale -----
  function drawMini() {
    const today = startOfDay(new Date());
    const jump = (label, fn) => h('button', { class: 'jump-btn', onclick: fn }, label);
    side.replaceChildren(
      h('div', { class: 'side-head' },
        h('span', { class: 'section-title' }, 'Vai a'),
        h('button', { class: 'icon-btn sm side-close', 'aria-label': 'Chiudi', onclick: () => toggleSide(false) }, icon('close'))),
      miniCal({ events: allEvents, onPick: pick }),
      h('div', { class: 'jumps' },
        jump('Oggi', () => { st.date = today; st.scrollTop = null; if (narrow()) wrap.classList.remove('side-open'); draw(); }),
        jump('Domani', () => { setView('day'); pick('day', addDays(today, 1)); }),
        jump('Questa settimana', () => pick('week', startOfWeek(today))),
        jump('Prossima settimana', () => pick('week', addDays(startOfWeek(today), 7))),
        jump('Questo mese', () => pick('month', new Date(today.getFullYear(), today.getMonth(), 1))),
        jump('Mese prossimo', () => pick('month', new Date(today.getFullYear(), today.getMonth() + 1, 1)))),
      h('div', { class: 'legend' }, h('div', { class: 'section-title' }, 'Categorie'),
        cats().map(c => h('div', { class: 'legend-row' }, h('i', { style: { background: c.color || 'var(--cream)' } }), c.name)),
        h('a', { class: 'legend-manage', href: '#/settings' }, cats().length ? 'Gestisci categorie' : '+ Crea una categoria')));
  }

  // Modifiche arrivate da un altro dispositivo
  const onRemote = e => {
    if (!(e.detail.has('events') || e.detail.has('calink'))) return;
    if ((overlay && overlay.isBusy()) || document.querySelector('.modal-overlay')) return;
    draw();
  };
  const onFlush = () => { if (overlay) overlay.flush(); };
  // categorie create, modificate o eliminate (qui o su un altro dispositivo)
  const onCats = () => { if (!(overlay && overlay.isBusy())) draw(); };
  addEventListener('pfy-remote', onRemote);
  addEventListener('pfy-flush', onFlush);
  addEventListener('pfy-cats', onCats);

  // Scorciatoie: T = oggi, ← → = periodo precedente/successivo, 1–6 = viste
  const onKey = e => {
    if (e.ctrlKey || e.metaKey || e.altKey || st.writing) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.querySelector('.modal-overlay')) return;
    const vb = VIEW_BTNS.find(v => v[2] === e.key);
    if (vb) { setView(vb[0]); draw(); }
    else if (e.key === 't' || e.key === 'T') { st.date = startOfDay(new Date()); st.scrollTop = null; draw(); }
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else return;
    e.preventDefault();
  };
  document.addEventListener('keydown', onKey);

  // Scorri con un dito verso sinistra/destra per cambiare periodo
  let sw = null;
  const onTouchStart = e => {
    const t = e.touches[0];
    sw = e.touches.length === 1 && !st.writing && t.touchType !== 'stylus' ? { x: t.clientX, y: t.clientY, t: Date.now() } : null;
  };
  const onTouchEnd = e => {
    if (!sw) return;
    const t = e.changedTouches[0], dx = t.clientX - sw.x, dy = t.clientY - sw.y, s = sw;
    sw = null;
    if (lastDragAt >= s.t || Date.now() - s.t > 700 || Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
    if (document.querySelector('.modal-overlay')) return;
    step(dx < 0 ? 1 : -1);
  };
  main.addEventListener('touchstart', onTouchStart, { passive: true });
  main.addEventListener('touchend', onTouchEnd, { passive: true });

  await loadCats();
  await draw();
  return () => {
    destroyed = true;
    document.removeEventListener('keydown', onKey);
    closePicker();
    removeEventListener('pfy-cats', onCats);
    removeEventListener('pfy-remote', onRemote);
    removeEventListener('pfy-flush', onFlush);
    if (overlay) { overlay.flush(); overlay.destroy(); }
    timers.forEach(clearInterval);
    calTb.destroy();
    stopDrag();
  };
}
