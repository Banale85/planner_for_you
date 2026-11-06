// Calendario in stile Microsoft Teams: viste Giorno / Settimana lavorativa / Settimana / Mese / Agenda,
// riunioni con partecipanti, link "Partecipa", ricorrenze, promemoria, categorie, trascinamento,
// e scrittura a penna o da tastiera direttamente sopra il calendario e nelle note di ogni evento.

import { db } from './db.js';
import { h, modal, toast, popMenu, confirmDialog, chooseDialog } from './ui.js';
import { icon } from './icons.js';
import { uid, pad, ymd, hm, parseLocal, toLocalISO, addDays, startOfDay, sameDay, startOfWeek, fmt, cap, pickFile, download, debounce, clamp } from './util.js';
import { InkSurface, inkToolbar, tools, emptyInk } from './ink.js';
import { parseICS, toICS } from './ics.js';
import { createLinkedNotebook, paperCanvas } from './notes.js';

export const CATS = [
  { id: 'purple', name: 'Riunione', c: '#5b5fc7' },
  { id: 'blue', name: 'Lezione', c: '#0f6cbd' },
  { id: 'green', name: 'Studio', c: '#107c41' },
  { id: 'orange', name: 'Esame', c: '#e8730c' },
  { id: 'red', name: 'Scadenza', c: '#d13438' },
  { id: 'teal', name: 'Personale', c: '#038387' },
  { id: 'gray', name: 'Altro', c: '#737373' },
];
const catOf = id => CATS.find(c => c.id === id) || CATS[0];
const HOUR = 48;
const VIEWS = { day: 'Giorno', workweek: 'Settimana lavorativa', week: 'Settimana', month: 'Mese', agenda: 'Agenda' };
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
    default: return { from: startOfDay(date), days: 30 };
  }
}
function rangeLabel(view, from, days) {
  if (view === 'day') return cap(fmt.full(from));
  if (view === 'month') return cap(fmt.monthYear(st.date));
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
    category: 'purple', showAs: 'busy', reminder: 15, attendees: '', location: '', meetingUrl: '', notes: '',
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

  let cat = ev.category || 'purple';
  const dot = h('span', { class: 'cat-dot', style: { '--c': catOf(cat).c } });
  const chips = h('div', { class: 'cat-chips' }, CATS.map(c => h('button', {
    class: 'cat-chip' + (c.id === cat ? ' active' : ''), type: 'button', style: { '--c': c.c },
    onclick: e => { cat = c.id; chips.querySelectorAll('.active').forEach(x => x.classList.remove('active')); e.currentTarget.classList.add('active'); dot.style.setProperty('--c', c.c); },
  }, h('i'), c.name)));
  const showAs = h('select', { class: 'input sm', 'aria-label': 'Mostra come' }, SHOW_AS.map(([v, l]) => h('option', { value: v }, l)));
  showAs.value = ev.showAs || 'busy';
  const rem = h('select', { class: 'input sm', 'aria-label': 'Promemoria' }, REMINDERS.map(([v, l]) => h('option', { value: v }, l)));
  if (ev.reminder != null && !REMINDERS.some(([v]) => v === String(ev.reminder))) rem.append(h('option', { value: String(ev.reminder) }, ev.reminder + ' minuti prima'));
  rem.value = ev.reminder == null ? '' : String(ev.reminder);

  // note: tastiera + penna
  const notesTA = h('textarea', { class: 'input notes-ta', rows: '7', placeholder: 'Ordine del giorno, appunti, link utili…', 'aria-label': 'Note' });
  notesTA.value = ev.notes || '';
  const inkBox = h('div', { class: 'ev-ink' });
  const tb = inkToolbar({ compact: true, hand: false });
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
  const save = async close => { if (!collect()) return; await db.put('events', ev); close(); onSaved && onSaved(); };
  const openNotes = async close => {
    if (!collect()) return;
    let nbId = ev.notebookId && (await db.get('notebooks', ev.notebookId)) ? ev.notebookId : null;
    if (!nbId) { nbId = await createLinkedNotebook(ev, catOf(ev.category).c); ev.notebookId = nbId; }
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
  surface = new InkSurface(inkBox, { data: ev.ink, drawBackground: (W, H, d) => paperCanvas(W, H, d, 'lined', 'white') });
  if (!src) setTimeout(() => title.focus(), 60);
  return m;
}

// =====================================================================
// VISTA CALENDARIO
// =====================================================================
export async function renderCalendar(host) {
  const wrap = h('div', { class: 'cal' + (st.writing ? ' writing' : '') });
  let overlay = null, timers = [], destroyed = false, miniMonth = null;

  const rangeLbl = h('div', { class: 'cal-range' });
  const viewSel = h('select', { class: 'input sm view-sel', 'aria-label': 'Vista', onchange: () => { st.view = viewSel.value; try { localStorage.setItem('pfy-view', st.view); } catch { /* ignore */ } draw(); } },
    Object.entries(VIEWS).map(([k, v]) => h('option', { value: k }, v)));
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
    h('button', { class: 'btn', onclick: () => { st.date = startOfDay(new Date()); st.scrollTop = null; draw(); } }, icon('calendar'), 'Oggi'),
    h('button', { class: 'icon-btn', title: 'Precedente', 'aria-label': 'Precedente', onclick: () => step(-1) }, icon('chevL')),
    h('button', { class: 'icon-btn', title: 'Successivo', 'aria-label': 'Successivo', onclick: () => step(1) }, icon('chevR')),
    rangeLbl, h('div', { class: 'grow' }), viewSel);
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
    else st.date = addDays(d, 7 * dir);
    draw();
  }
  function toggleWrite(v) {
    st.writing = v === undefined ? !st.writing : v;
    if (st.writing && st.view === 'agenda') { st.view = 'week'; draw(); }
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
    overlay = new InkSurface(el, { data: rec, onChange: () => save(), enabled: () => st.writing });
    overlay.flush = save.flush;
  }

  async function draw() {
    if (destroyed) return;
    if (overlay) { overlay.flush(); overlay.destroy(); overlay = null; }
    timers.forEach(clearInterval); timers = [];
    miniMonth = null;
    viewSel.value = st.view;
    const { from, days } = rangeFor(st.view, st.date);
    const events = await db.all('events');
    if (destroyed) return;
    const occs = expand(events, from, addDays(from, days));
    rangeLbl.textContent = rangeLabel(st.view, from, days);
    main.replaceChildren();
    if (st.view === 'month') drawMonth(from, occs);
    else if (st.view === 'agenda') drawAgenda(from, days, occs);
    else drawTimeGrid(from, days, occs);
    drawMini();
  }

  const chip = (o, withTime) => {
    const c = h('div', { class: 'chip', style: { '--c': catOf(o.ev.category).c }, title: o.ev.title },
      withTime && !o.ev.allDay ? h('b', {}, hm(o.start) + ' ') : null, o.ev.title || '(Senza titolo)');
    c.addEventListener('click', e => { e.stopPropagation(); if (!st.writing) openEditor(o, null, draw); });
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
      const { o } = it, c = catOf(o.ev.category);
      const height = Math.max((it.e - it.s) / 60 * HOUR - 2, 18);
      const meta = h('div', { class: 'ev-meta' }, `${hm(o.start)} – ${hm(o.end)}`, o.ev.location ? ' · ' + o.ev.location : '');
      const el = h('div', {
        class: 'ev' + (height < 40 ? ' short' : '') + ' show-' + (o.ev.showAs || 'busy'),
        style: { top: it.s / 60 * HOUR + 'px', height: height + 'px', left: `calc(${it.col / it.n * 100}% + 2px)`, width: `calc(${100 / it.n}% - 4px)`, '--c': c.c },
        title: `${o.ev.title}\n${hm(o.start)} – ${hm(o.end)}${o.ev.location ? '\n' + o.ev.location : ''}`,
      },
        h('div', { class: 'ev-title' }, o.ev.meetingUrl ? icon('video', 'ev-ic') : null, o.ev.rrule ? icon('repeat', 'ev-ic') : null, o.ev.notebookId ? icon('notes', 'ev-ic') : null, o.ev.title || '(Senza titolo)'),
        meta,
        o.ev.rrule ? null : h('div', { class: 'ev-resize' }));
      el.addEventListener('pointerdown', e => {
        if (st.writing) return;
        e.stopPropagation();
        if (e.pointerType === 'touch') { tapDetect(e, () => openEditor(o, null, draw)); return; }
        if (e.button !== 0) return;
        e.preventDefault();
        const resize = e.target.classList.contains('ev-resize');
        const sx = e.clientX, sy = e.clientY, origIdx = cols.indexOf(col), dur = o.end - o.start;
        colRects = null;
        let dragging = false, ns = o.start, ne = o.end;
        const move = ev => {
          if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
          if (o.ev.rrule) return;
          dragging = true; el.classList.add('dragging');
          const dmin = Math.round((ev.clientY - sy) / HOUR * 4) * 15;
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
        const up = async () => {
          removeEventListener('pointermove', move); removeEventListener('pointerup', up); cleanupDrag = null;
          if (!dragging) { openEditor(o, null, draw); return; }
          const updated = { ...o.ev, start: toLocalISO(ns), end: toLocalISO(ne), updatedAt: Date.now() };
          await db.put('events', updated);
          draw();
        };
        addEventListener('pointermove', move); addEventListener('pointerup', up);
        cleanupDrag = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
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
  let stopDrag = () => {};

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
          const c = catOf(o.ev.category);
          return h('div', { class: 'ag-item', style: { '--c': c.c }, onclick: () => openEditor(o, null, draw) },
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

  // ----- Mini calendario laterale -----
  function drawMini() {
    const m = miniMonth || new Date(st.date.getFullYear(), st.date.getMonth(), 1);
    const { from, days } = rangeFor(st.view, st.date);
    const rEnd = addDays(from, days), now = new Date(), start = startOfWeek(m);
    const grid = h('div', { class: 'mini-grid' });
    for (let i = 0; i < 7; i++) grid.append(h('div', { class: 'wd' }, fmt.wdShort(addDays(start, i)).charAt(0).toUpperCase()));
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      const inRange = st.view !== 'month' && st.view !== 'agenda' && d >= from && d < rEnd;
      grid.append(h('button', {
        class: (d.getMonth() !== m.getMonth() ? 'other ' : '') + (inRange ? 'inrange ' : '') + (sameDay(d, now) ? 'today' : ''),
        onclick: () => { st.date = d; draw(); }, 'aria-label': fmt.full(d),
      }, d.getDate()));
    }
    side.replaceChildren(
      h('div', { class: 'mini' },
        h('div', { class: 'mini-head' },
          h('span', {}, cap(fmt.monthYear(m))),
          h('div', {},
            h('button', { class: 'icon-btn sm', 'aria-label': 'Mese precedente', onclick: () => { miniMonth = new Date(m.getFullYear(), m.getMonth() - 1, 1); drawMini(); } }, icon('chevL')),
            h('button', { class: 'icon-btn sm', 'aria-label': 'Mese successivo', onclick: () => { miniMonth = new Date(m.getFullYear(), m.getMonth() + 1, 1); drawMini(); } }, icon('chevR')))),
        grid),
      h('div', { class: 'legend' }, h('div', { class: 'section-title' }, 'Categorie'), CATS.map(c => h('div', { class: 'legend-row' }, h('i', { style: { background: c.c } }), c.name))));
  }

  // Modifiche arrivate da un altro dispositivo
  const onRemote = e => {
    if (!(e.detail.has('events') || e.detail.has('calink'))) return;
    if ((overlay && overlay.isBusy()) || document.querySelector('.modal-overlay')) return;
    draw();
  };
  const onFlush = () => { if (overlay) overlay.flush(); };
  addEventListener('pfy-remote', onRemote);
  addEventListener('pfy-flush', onFlush);

  await draw();
  return () => {
    destroyed = true;
    removeEventListener('pfy-remote', onRemote);
    removeEventListener('pfy-flush', onFlush);
    if (overlay) { overlay.flush(); overlay.destroy(); }
    timers.forEach(clearInterval);
    calTb.destroy();
    stopDrag();
  };
}
