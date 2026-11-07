// Avvio dell'app e navigazione

import { h, toast } from './ui.js';
import { icon } from './icons.js';
import { renderCalendar, startReminders } from './calendar.js';
import { renderNotes, renderNotebook } from './notes.js';
import { renderSettings, applyTheme } from './settings.js';
import * as sync from './sync.js';

applyTheme();
// Ritorno dalla pagina di accesso Google (va letto prima della navigazione)
const redirect = sync.handleRedirect();

const rail = document.getElementById('rail');
rail.append(h('div', { class: 'rail-logo', title: 'Planner for You' }, h('img', { src: 'icons/icon.svg', alt: '' })));
for (const [route, ic, label] of [['calendar', 'calendar', 'Calendario'], ['notes', 'notes', 'Appunti']]) {
  rail.append(h('a', { class: 'rail-btn', href: '#/' + route, 'data-route': route }, icon(ic), h('span', {}, label)));
}
rail.append(h('div', { class: 'rail-spacer' }));

// Pulsante di stato della sincronizzazione
const syncLabel = h('span', {}, 'Sync');
const syncBtn = h('button', { class: 'rail-btn sync-btn', type: 'button', hidden: true }, icon('cloud'), syncLabel);
syncBtn.addEventListener('click', () => {
  const s = sync.state.status;
  if (s === 'auth') sync.reconnect();
  else if (s === 'error') { toast(sync.state.error || 'Errore di sincronizzazione'); sync.syncNow(); }
  else if (s === 'offline') toast('Sei offline: le modifiche sono salvate sul dispositivo e verranno inviate appena torni online.');
  else sync.syncNow();
});
const LABELS = { idle: 'Sincronizzato', syncing: 'Sincronizzo…', auth: 'Riconnetti', offline: 'Offline', error: 'Errore' };
sync.onState(st => {
  syncBtn.hidden = st.status === 'off';
  syncBtn.dataset.state = st.status;
  syncLabel.textContent = st.status === 'auth' ? 'Riconnetti' : st.status === 'offline' ? 'Offline' : 'Sync';
  const last = sync.lastSync();
  syncBtn.title = (LABELS[st.status] || '') + (st.detail ? ' · ' + st.detail : '') + (st.error ? ' · ' + st.error : '') +
    (last ? `\nUltima sincronizzazione: ${new Date(last).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}` : '') +
    (sync.account() ? '\n' + sync.account() : '');
});
rail.append(syncBtn);
rail.append(h('a', { class: 'rail-btn', href: '#/settings', 'data-route': 'settings' }, icon('settings'), h('span', {}, 'Impostazioni')));

let cleanup = null, tok = 0;
async function route() {
  const t = ++tok;
  const parts = (location.hash.replace(/^#\/?/, '') || 'calendar').split('/');
  const name = parts[0];
  try { if (cleanup) cleanup(); } catch (e) { console.error(e); }
  cleanup = null;
  const view = document.getElementById('view');
  const host = h('div', { class: 'view-host' });
  view.replaceChildren(host);
  const nav = name === 'notebook' ? 'notes' : name;
  rail.querySelectorAll('.rail-btn[data-route]').forEach(b => b.classList.toggle('active', b.dataset.route === nav));
  document.body.dataset.view = name;

  let fn = renderCalendar, params = {};
  if (name === 'notes') { fn = renderNotes; if (parts[1] === 'folder') params.folderId = parts[2] || null; }
  else if (name === 'notebook') { fn = renderNotebook; params.id = parts[1]; }
  else if (name === 'settings') fn = renderSettings;

  try {
    const c = await fn(host, params);
    if (t !== tok) { if (c) c(); return; }
    cleanup = c || null;
  } catch (e) {
    console.error(e);
    host.append(h('div', { class: 'empty' }, h('h3', {}, 'Si è verificato un errore'), h('p', {}, String(e && e.message || e))));
  }
}
addEventListener('hashchange', route);
route();
startReminders();
sync.init(redirect).then(st => {
  if (redirect && redirect.ok && redirect.connect) toast('Google Drive collegato' + (sync.account() ? ': ' + sync.account() : '') + '. Sincronizzazione in corso…', { ms: 4000 });
  else if (redirect && redirect.error && st.error) toast(st.error, { ms: 5000 });
}).catch(e => console.warn(e));

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
addEventListener('beforeinstallprompt', e => { e.preventDefault(); window.__installPrompt = e; });
