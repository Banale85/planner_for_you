// Impostazioni: tema, penna, installazione, notifiche, calendario Teams, backup

import { db, STORES } from './db.js';
import { h, toast, confirmDialog } from './ui.js';
import { icon } from './icons.js';
import { tools } from './ink.js';
import { importICS, exportICS } from './calendar.js';
import { download, pickFile, blobToDataURL, dataURLToBlob, ymd } from './util.js';
import * as sync from './sync.js';

const STATUS_TEXT = { idle: 'Sincronizzato', syncing: 'Sincronizzazione in corso…', auth: 'Accesso scaduto: tocca "Riconnetti"', offline: 'Offline: le modifiche verranno inviate appena torni online', error: 'Errore', off: 'Non collegato' };

function driveCard() {
  const body = h('div');
  function draw() {
    const cid = sync.clientId(), st = sync.state;
    const appUrl = location.origin + location.pathname.replace(/index\.html$/, '');
    const err = st.error ? h('p', { class: 'err' }, st.error) : '';
    if (!sync.isEnabled()) {
      if (!cid) {
        const inp = h('input', { class: 'input', placeholder: '1234567890-xxxx.apps.googleusercontent.com', 'aria-label': 'Client ID' });
        body.replaceChildren(
          h('p', { class: 'muted' }, 'Serve una configurazione iniziale di 10 minuti (una volta sola): crea un "Client ID" gratuito su Google Cloud Console seguendo la guida nel file README.md, poi incollalo qui sotto o nel file js/config.js.'),
          h('p', { class: 'muted small' }, 'Indirizzo di questa app da inserire nella console Google: ', h('code', {}, appUrl)),
          h('div', { class: 'row' }, inp, h('button', { class: 'btn primary', onclick: () => { if (!inp.value.trim()) return; sync.setClientId(inp.value); draw(); } }, 'Salva')), err);
      } else {
        body.replaceChildren(
          h('p', { class: 'muted' }, 'Accedi con il tuo account Google: l\'app creerà nel tuo Drive la cartella "Planner for You" e potrà vedere solo quella. Fallo su ogni dispositivo con lo stesso account.'),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', onclick: () => { try { sync.startAuth('select_account consent', true); } catch (e) { toast(e.message); } } }, icon('cloud'), 'Collega Google Drive'),
            h('button', { class: 'btn ghost', onclick: () => { sync.setClientId(''); draw(); } }, 'Cambia Client ID')), err);
      }
      return;
    }
    const last = sync.lastSync(), pend = sync.pendingCount();
    body.replaceChildren(
      h('div', { class: 'sync-info' },
        h('div', {}, h('span', { class: 'muted' }, 'Account: '), h('b', {}, sync.account() || 'Google')),
        h('div', {}, h('span', { class: 'muted' }, 'Stato: '), h('span', { class: 'st-' + st.status }, STATUS_TEXT[st.status] || st.status), st.detail ? h('span', { class: 'muted' }, ' · ' + st.detail) : null),
        h('div', { class: 'muted small' }, last ? 'Ultima sincronizzazione: ' + new Date(last).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Mai sincronizzato', pend ? ` · ${pend} modifiche in attesa di invio` : '')),
      err,
      h('div', { class: 'row' },
        st.status === 'auth'
          ? h('button', { class: 'btn primary', onclick: () => sync.reconnect() }, icon('cloud'), 'Riconnetti')
          : h('button', { class: 'btn primary', onclick: () => sync.syncNow() }, icon('repeat'), 'Sincronizza ora'),
        h('button', {
          class: 'btn', onclick: async () => {
            if (!await confirmDialog('Scollegare Google Drive da questo dispositivo? I dati restano sia qui sia nel tuo Drive.', { title: 'Scollega', okLabel: 'Scollega' })) return;
            await sync.disconnect(); draw();
          },
        }, 'Scollega')));
  }
  const unsub = sync.onState(draw);
  draw();
  const el = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, icon('cloud'), h('h3', {}, 'Sincronizzazione con Google Drive')),
    h('p', { class: 'muted' }, 'Tutto ciò che fai su iPad compare sul PC e viceversa, senza backup. I PDF vengono salvati nel tuo Drive (15 GB gratuiti) e scaricati sugli altri dispositivi solo quando li apri.'),
    body);
  el.destroy = unsub;
  return el;
}

export function applyTheme() {
  let t = 'system';
  try { t = localStorage.getItem('pfy-theme') || 'system'; } catch { /* ignore */ }
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

async function exportBackup() {
  const t = toast('Preparazione del backup…', { ms: 60000 });
  try {
    const out = { app: 'planner-for-you', version: 1, date: new Date().toISOString() };
    for (const s of STORES) if (s !== 'files' && s !== 'meta') out[s] = await db.all(s);
    const files = await db.all('files');
    out.files = [];
    for (const f of files) out.files.push({ id: f.id, name: f.name, type: f.type, data: await blobToDataURL(f.blob) });
    download(new Blob([JSON.stringify(out)], { type: 'application/json' }), `planner-backup-${ymd(new Date())}.json`);
  } finally { t.remove(); }
}

async function importBackup() {
  const [f] = await pickFile('.json,application/json');
  if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); } catch { toast('File non valido'); return; }
  if (!data || data.app !== 'planner-for-you') { toast('Questo file non è un backup di Planner for You'); return; }
  if (!await confirmDialog('Il backup sostituirà TUTTI i dati presenti su questo dispositivo. Continuare?', { title: 'Ripristina backup', okLabel: 'Sostituisci', danger: true })) return;
  const t = toast('Ripristino in corso…', { ms: 60000 });
  for (const s of STORES) {
    if (s === 'meta') continue;
    await db.clear(s);
    if (s === 'files') {
      const files = [];
      for (const x of data.files || []) files.push({ id: x.id, name: x.name, type: x.type, blob: await dataURLToBlob(x.data) });
      await db.putMany('files', files);
    } else await db.putMany(s, data[s] || []);
  }
  t.remove();
  toast('Backup ripristinato');
  setTimeout(() => location.reload(), 600);
}

export async function renderSettings(host) {
  const card = (ic, title, desc, ...body) => h('section', { class: 'card' },
    h('div', { class: 'card-head' }, icon(ic), h('h3', {}, title)),
    desc ? h('p', { class: 'muted' }, desc) : null, ...body);

  // Tema
  let theme = 'system';
  try { theme = localStorage.getItem('pfy-theme') || 'system'; } catch { /* ignore */ }
  const seg = h('div', { class: 'segmented' }, [['system', 'Sistema'], ['light', 'Chiaro'], ['dark', 'Scuro']].map(([v, l]) => h('button', {
    class: v === theme ? 'active' : '',
    onclick: e => { try { localStorage.setItem('pfy-theme', v); } catch { /* ignore */ } applyTheme(); seg.querySelectorAll('button').forEach(b => b.classList.remove('active')); e.currentTarget.classList.add('active'); },
  }, l)));

  // Penna
  const penOnly = h('input', { type: 'checkbox', checked: tools.penOnly });
  penOnly.addEventListener('change', () => tools.set({ penOnly: penOnly.checked }));

  // Installazione
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installBody = standalone
    ? h('p', { class: 'ok' }, icon('check'), 'L\'app è installata su questo dispositivo.')
    : h('div', {},
      window.__installPrompt ? h('button', { class: 'btn primary', onclick: async () => { const p = window.__installPrompt; p.prompt(); await p.userChoice; window.__installPrompt = null; } }, icon('download'), 'Installa l\'app') : null,
      h('ul', { class: 'steps' },
        h('li', { class: ios ? 'hl' : '' }, h('b', {}, 'iPad / iPhone: '), 'apri il sito con Safari → tocca Condividi (il quadrato con la freccia) → "Aggiungi alla schermata Home".'),
        h('li', {}, h('b', {}, 'Android: '), 'apri con Chrome → menu ⋮ → "Installa app" (o "Aggiungi a schermata Home").'),
        h('li', {}, h('b', {}, 'Windows / Mac: '), 'apri con Chrome o Edge → icona "Installa" nella barra degli indirizzi.')));

  // Notifiche
  const notifState = h('span', { class: 'muted' });
  const updNotif = () => {
    if (!('Notification' in window)) notifState.textContent = 'Non supportate da questo browser (su iPhone/iPad funzionano solo dopo aver installato l\'app).';
    else notifState.textContent = { granted: 'Attive', denied: 'Bloccate dalle impostazioni del browser', default: 'Non ancora attivate' }[Notification.permission];
  };
  updNotif();

  // Spazio
  const usage = h('span', { class: 'muted' });
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(e => { usage.textContent = `Spazio usato: ${(e.usage / 1048576).toFixed(1)} MB`; }).catch(() => {});

  const drive = driveCard();
  const wrap = h('div', { class: 'settings' },
    h('div', { class: 'topbar' }, h('h1', {}, icon('settings'), 'Impostazioni')),
    h('div', { class: 'settings-body' },
      drive,
      card('palette', 'Aspetto', 'Scegli il tema dell\'app.', seg),
      card('pen', 'Penna e scrittura', 'Con "Solo penna" attivo scrivi con la penna (Apple Pencil, S Pen…) e con il dito scorri e fai zoom. Si attiva da solo quando l\'app rileva una penna.',
        h('label', { class: 'switch-row' }, penOnly, h('span', {}, 'Solo penna (il dito scorre la pagina)'))),
      card('download', 'Installa sul dispositivo', 'L\'app non passa dall\'App Store: si installa direttamente dal browser e funziona anche offline.', installBody),
      card('bell', 'Promemoria', 'Ricevi un avviso prima delle riunioni e delle lezioni.',
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { if ('Notification' in window) { await Notification.requestPermission(); updNotif(); } } }, icon('bell'), 'Attiva notifiche'), notifState)),
      card('calendar', 'Calendario di Teams / Outlook', null,
        h('p', { class: 'muted' }, 'Per portare qui il calendario di Teams: apri Outlook sul web → Impostazioni → Calendario → Calendari condivisi → "Pubblica un calendario" → scarica il link ICS e importa il file. Le riunioni Teams mantengono il pulsante "Partecipa". Reimportando lo stesso file, gli eventi vengono aggiornati senza perdere le tue note.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => importICS() }, icon('upload'), 'Importa .ics'),
          h('button', { class: 'btn', onclick: exportICS }, icon('download'), 'Esporta .ics'))),
      card('copy', 'Backup', 'Una copia completa di tutti i dati in un unico file, da conservare per sicurezza.',
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: exportBackup }, icon('download'), 'Esporta backup'),
          h('button', { class: 'btn', onclick: importBackup }, icon('upload'), 'Importa backup'),
          usage)),
      h('p', { class: 'muted center small' }, 'Planner for You · versione 1.1')));
  host.append(wrap);
  return () => drive.destroy();
}
