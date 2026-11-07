// Sincronizzazione con Google Drive.
// - L'app salva sempre prima sul dispositivo (funziona offline), poi invia le modifiche a Drive.
// - In Drive c'è una cartella "Planner for You": un file .json per ogni cartella/quaderno/pagina/evento,
//   e i PDF/immagini come file normali (scaricati sugli altri dispositivi solo quando servono).
// - Accesso con reindirizzamento a Google (funziona anche nell'app installata su iPad).
//   Il permesso dura circa 1 ora: all'apertura dell'app viene rinnovato in automatico.

import { db, setWriteHook, SYNCED, KEYS } from './db.js';
import { uid } from './util.js';
import { GOOGLE_CLIENT_ID } from './config.js';

const API = 'https://www.googleapis.com/drive/v3';
const UP = 'https://www.googleapis.com/upload/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'Planner for You';
const LS_CFG = 'pfy-sync', LS_OUT = 'pfy-outbox', LS_TOK = 'pfy-token';

const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

export const clientId = () => ((ls.get('pfy-client-id', '') || GOOGLE_CLIENT_ID || '') + '').trim();
export const setClientId = v => ls.set('pfy-client-id', v ? v.trim() : null);
export const isEnabled = () => !!(cfg && cfg.enabled);
export const account = () => (cfg && cfg.email) || '';

let cfg = ls.get(LS_CFG, null);          // { enabled, email, folderId, wm, last }
let outbox = ls.get(LS_OUT, {});         // "store|id" -> { n, d }
let tok = ls.get(LS_TOK, null);          // { t, exp }
let map = null;                          // "store|id" -> { key, f (id Drive), r (revisione) }
let device = ls.get('pfy-device', null);
if (!device) { device = uid(); ls.set('pfy-device', device); }

const saveCfg = () => ls.set(LS_CFG, cfg);
const saveOutbox = () => ls.set(LS_OUT, outbox);
const hasToken = () => !!(tok && Date.now() < tok.exp - 60000);

// ---------- Stato (per l'interfaccia) ----------
export const state = { status: 'off', error: '', detail: '', listeners: new Set() };
function setStatus(status, error = '', detail = '') {
  state.status = status; state.error = error; state.detail = detail;
  state.listeners.forEach(f => { try { f(state); } catch { /* ignore */ } });
}
export const onState = f => { state.listeners.add(f); return () => state.listeners.delete(f); };
export const lastSync = () => (cfg && cfg.last) || null;
export const pendingCount = () => Object.keys(outbox).length;

// ---------- Coda delle modifiche locali ----------
let pushTimer = null;
setWriteHook((store, keys, deleted) => {
  if (!isEnabled()) return;
  for (const k of keys) {
    const key = store + '|' + k;
    outbox[key] = { n: ((outbox[key] && outbox[key].n) || 0) + 1, d: !!deleted };
  }
  saveOutbox();
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncNow(), 2500);
});

async function enqueueAll() {
  for (const s of SYNCED) for (const k of await db.keys(s)) outbox[s + '|' + k] = { n: 1, d: false };
  saveOutbox();
}

// ---------- Mappa record locale -> file Drive ----------
async function loadMap() {
  if (map) return;
  map = new Map();
  for (const r of await db.all('meta')) if (r.key.startsWith('d:')) map.set(r.key.slice(2), r);
}
const mk = (key, f, r) => { const rec = { key: 'd:' + key, f, r }; map.set(key, rec); return rec; };
async function clearMap() {
  const keys = (await db.keys('meta')).filter(k => String(k).startsWith('d:'));
  await db.delMany('meta', keys, { silent: true });
  map = new Map();
}

// ---------- Accesso Google (reindirizzamento) ----------
const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');

export function startAuth(prompt = '', connect = false) {
  if (!clientId()) throw new Error('Manca il Client ID di Google (vedi Impostazioni).');
  const nonce = uid();
  ls.set('pfy-auth-nonce', nonce);
  ls.set('pfy-auth-try', Date.now());
  window.dispatchEvent(new Event('pfy-flush'));
  const p = new URLSearchParams({
    client_id: clientId(), redirect_uri: redirectUri(), response_type: 'token', scope: SCOPE,
    include_granted_scopes: 'true',
    state: JSON.stringify({ n: nonce, r: location.hash && location.hash.startsWith('#/') ? location.hash : '#/calendar', c: connect ? 1 : 0 }),
  });
  if (prompt) p.set('prompt', prompt);
  if (cfg && cfg.email && !connect) p.set('login_hint', cfg.email);
  setTimeout(() => location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + p), 300);
}

// Da chiamare all'avvio, prima della navigazione: legge la risposta di Google dall'indirizzo
export function handleRedirect() {
  const h = location.hash;
  if (!h || h.startsWith('#/') || !(h.includes('access_token=') || h.includes('error='))) return null;
  const p = new URLSearchParams(h.slice(1));
  let st = {};
  try { st = JSON.parse(p.get('state') || '{}'); } catch { /* ignore */ }
  const ok = st.n && st.n === ls.get('pfy-auth-nonce', null);
  ls.set('pfy-auth-nonce', null);
  history.replaceState(null, '', location.pathname + location.search + (st.r || '#/calendar'));
  if (!ok) return { error: 'state' };
  if (p.get('access_token')) {
    if (!(p.get('scope') || '').includes('drive.file')) return { error: 'scope', connect: !!st.c };
    tok = { t: p.get('access_token'), exp: Date.now() + (Number(p.get('expires_in')) || 3600) * 1000 };
    ls.set(LS_TOK, tok);
    return { ok: true, connect: !!st.c };
  }
  return { error: p.get('error') || 'errore', connect: !!st.c };
}

async function reachable() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3500);
    await fetch(API + '/about', { mode: 'no-cors', cache: 'no-store', signal: ctl.signal });
    clearTimeout(t);
    return true;
  } catch { return false; }
}
function busyUI() {
  const a = document.activeElement;
  return !!document.querySelector('.modal-overlay') || !!(a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)));
}
// Rinnova il permesso senza chiedere nulla (se possibile), al massimo una volta ogni 2 minuti
async function maybeSilentAuth() {
  if (!isEnabled() || !clientId() || hasToken() || !navigator.onLine || busyUI()) return;
  if (Date.now() - Number(ls.get('pfy-auth-try', 0)) < 120000) return;
  if (!await reachable()) { setStatus('offline'); return; }
  startAuth('none', false);
}
export function reconnect() { startAuth('', false); }

// ---------- Chiamate a Google Drive ----------
class NeedAuth extends Error {}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(url, opts = {}, tries = 3) {
  if (!hasToken()) throw new NeedAuth('auth');
  let r;
  try { r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + tok.t } }); }
  catch (e) { if (tries > 1) { await sleep(1500); return api(url, opts, tries - 1); } throw e; }
  if (r.status === 401) { tok = null; ls.set(LS_TOK, null); throw new NeedAuth('auth'); }
  if ((r.status === 429 || r.status === 403 || r.status >= 500) && tries > 1) { await sleep(2000 * (4 - tries)); return api(url, opts, tries - 1); }
  if (!r.ok) { const e = new Error('Google Drive: errore ' + r.status); e.status = r.status; throw e; }
  return r;
}
async function ensureFolder() {
  if (cfg.folderId) return cfg.folderId;
  const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const r = await (await api(`${API}/files?q=${q}&fields=files(id)&spaces=drive`)).json();
  let id = r.files && r.files[0] && r.files[0].id;
  if (!id) {
    id = (await (await api(`${API}/files?fields=id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder', appProperties: { pfy: 'root' } }),
    })).json()).id;
  }
  cfg.folderId = id; saveCfg();
  return id;
}
async function uploadJson(meta, body, fileId) {
  const b = 'pfy' + Math.random().toString(36).slice(2);
  const data = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}\r\n--${b}--`;
  const url = fileId ? `${UP}/files/${fileId}?uploadType=multipart&fields=id` : `${UP}/files?uploadType=multipart&fields=id`;
  return (await api(url, { method: fileId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body: data })).json();
}
async function uploadBlob(meta, blob) {
  const type = blob.type || 'application/octet-stream';
  const r = await api(`${UP}/files?uploadType=resumable&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(blob.size) },
    body: JSON.stringify(meta),
  });
  const loc = r.headers.get('Location');
  if (loc) {
    const r2 = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': type }, body: blob });
    if (!r2.ok) throw new Error('Caricamento file non riuscito (' + r2.status + ')');
    return r2.json();
  }
  // Ripiego: caricamento in un'unica richiesta
  const b = 'pfy' + Math.random().toString(36).slice(2);
  const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${type}\r\n\r\n`, blob, `\r\n--${b}--`]);
  return (await api(`${UP}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body })).json();
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

// Unisce due versioni della stessa pagina modificata su due dispositivi: nessun tratto va perso
function mergePage(local, remote) {
  const L = local.ink || { strokes: [], texts: [], images: [] }, R = remote.ink || { strokes: [], texts: [], images: [] };
  const sk = s => s.id || s.p.slice(0, 6).join(',');
  const union = (a, b, k) => { const m = new Map(); for (const x of b) m.set(k(x), x); for (const x of a) m.set(k(x), x); return [...m.values()]; };
  return { ...remote, ...local, ink: { strokes: union(L.strokes || [], R.strokes || [], sk), texts: union(L.texts || [], R.texts || [], t => t.id), images: union(L.images || [], R.images || [], i => i.id) } };
}

// ---------- Ricezione ----------
async function pull(changed) {
  const folder = await ensureFolder();
  const since = cfg.wm ? new Date(new Date(cfg.wm).getTime() - 5000).toISOString() : '1970-01-01T00:00:00Z';
  const files = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${folder}' in parents and trashed=false and modifiedTime > '${since}'`);
    const r = await (await api(`${API}/files?q=${q}&fields=nextPageToken,files(id,appProperties,modifiedTime)&pageSize=1000&orderBy=modifiedTime${pageToken ? '&pageToken=' + pageToken : ''}`)).json();
    files.push(...(r.files || []));
    pageToken = r.nextPageToken;
  } while (pageToken);

  let wm = cfg.wm, gc = false;
  const metaOut = [], todo = [];
  for (const f of files) {
    if (!wm || f.modifiedTime > wm) wm = f.modifiedTime;
    const a = f.appProperties || {};
    if (!a.k || !a.rid || !SYNCED.has(a.k)) continue;
    const key = a.k + '|' + a.rid, rev = Number(a.rev) || 0, m = map.get(key);
    if (m && m.f === f.id && m.r >= rev) continue;
    if (a.k === 'files') { metaOut.push(mk(key, f.id, rev)); continue; }
    todo.push({ f, a, key, rev, base: m ? m.r : 0 });
  }
  let n = 0;
  await pool(todo, 6, async it => {
    const { a, key, rev } = it;
    if (todo.length > 20) setStatus('syncing', '', `Ricezione ${++n}/${todo.length}`);
    const local = await db.get(a.k, a.rid);
    const lrev = (local && local._rev) || 0;
    const dirty = !!outbox[key];
    const conflictPage = a.k === 'pages' && dirty && local && it.base < rev;
    if (local && lrev >= rev && !conflictPage) { metaOut.push(mk(key, it.f.id, rev)); return; }
    const rec = await (await api(`${API}/files/${it.f.id}?alt=media`)).json();
    const add = () => { if (!changed.has(a.k)) changed.set(a.k, new Set()); changed.get(a.k).add(a.rid); };
    if (rec._deleted) {
      if (!(dirty && lrev > rev) && local) {
        await db.del(a.k, a.rid, { silent: true });
        if (a.k === 'pages') gc = true;
        delete outbox[key]; add();
      }
    } else if (conflictPage) {
      const merged = mergePage(local, rec);
      merged._rev = Math.max(lrev, rev) + 1;
      await db.put('pages', merged, { silent: true });
      outbox[key] = { n: ((outbox[key] && outbox[key].n) || 0) + 1, d: false };
      add();
    } else {
      await db.put(a.k, rec, { silent: true });
      delete outbox[key]; add();
    }
    metaOut.push(mk(key, it.f.id, rev));
  });
  if (metaOut.length) await db.putMany('meta', metaOut, { silent: true });
  cfg.wm = wm; saveCfg(); saveOutbox();
  return gc;
}

// Elimina dal dispositivo PDF e immagini che nessuna pagina usa più (dopo eliminazioni remote)
async function gcFiles() {
  const used = new Set();
  for (const p of await db.all('pages')) { if (p.pdf) used.add(p.pdf.fileId); for (const im of (p.ink && p.ink.images) || []) used.add(im.fileId); }
  const del = (await db.keys('files')).filter(k => !used.has(k) && !outbox['files|' + k]);
  if (del.length) await db.delMany('files', del, { silent: true });
}

// ---------- Invio ----------
async function push() {
  const folder = await ensureFolder();
  const keys = Object.keys(outbox);
  let n = 0;
  const metaOut = [], metaDel = [];
  await pool(keys, 4, async key => {
    const ent = outbox[key];
    if (!ent) return;
    if (keys.length > 5) setStatus('syncing', '', `Invio ${++n}/${keys.length}`);
    const i = key.indexOf('|'), store = key.slice(0, i), id = key.slice(i + 1);
    if (!SYNCED.has(store)) { delete outbox[key]; return; }
    const m = map.get(key);
    const rec = ent.d ? null : await db.get(store, id);
    if (store === 'files') {
      if (!rec) {
        if (m) { try { await api(`${API}/files/${m.f}`, { method: 'DELETE' }); } catch (e) { if (e instanceof NeedAuth) throw e; } map.delete(key); metaDel.push(m.key); }
      } else if (!m) {
        const r = await uploadBlob({ name: rec.name || id, parents: [folder], appProperties: { k: 'files', rid: id, rev: String(rec._rev || 1), dev: device } }, rec.blob);
        metaOut.push(mk(key, r.id, rec._rev || 1));
      }
    } else {
      const body = rec || { [KEYS[store]]: id, _deleted: true, _rev: Date.now() };
      const rev = body._rev || 1;
      if (!(m && m.r >= rev && rec)) {
        const meta = { name: `${store}-${id}.json`.replace(/[\\/]/g, '_'), appProperties: { k: store, rid: id, rev: String(rev), dev: device } };
        let r;
        try { r = await uploadJson(m ? meta : { ...meta, parents: [folder], mimeType: 'application/json' }, body, m && m.f); }
        catch (e) { if (e.status === 404 && m) r = await uploadJson({ ...meta, parents: [folder], mimeType: 'application/json' }, body); else throw e; }
        metaOut.push(mk(key, r.id, rev));
      }
    }
    if (outbox[key] && outbox[key].n === ent.n) delete outbox[key];
  });
  if (metaOut.length) await db.putMany('meta', metaOut, { silent: true });
  if (metaDel.length) await db.delMany('meta', metaDel, { silent: true });
  saveOutbox();
}

// ---------- Ciclo di sincronizzazione ----------
let running = null, again = false;
export function syncNow() {
  if (running) { again = true; return running; }
  running = (async () => {
    if (!isEnabled()) { setStatus('off'); return; }
    if (!navigator.onLine) { setStatus('offline'); return; }
    if (!hasToken()) { setStatus('auth'); maybeSilentAuth(); return; }
    setStatus('syncing');
    window.dispatchEvent(new Event('pfy-flush'));
    await sleep(50);
    await loadMap();
    const changed = new Map();
    try {
      const gc = await pull(changed);
      if (gc) await gcFiles();
      await push();
      cfg.last = Date.now(); saveCfg();
      setStatus('idle');
      if (changed.size) window.dispatchEvent(new CustomEvent('pfy-remote', { detail: changed }));
    } catch (e) {
      if (changed.size) window.dispatchEvent(new CustomEvent('pfy-remote', { detail: changed }));
      if (e instanceof NeedAuth) { setStatus('auth'); maybeSilentAuth(); }
      else { console.warn(e); setStatus(navigator.onLine ? 'error' : 'offline', e.message || String(e)); }
    }
  })().finally(() => { running = null; if (again) { again = false; syncNow(); } });
  return running;
}

// Scarica un PDF/immagine da Drive quando non è ancora sul dispositivo
const inflight = new Map();
export function fetchFile(id) {
  if (inflight.has(id)) return inflight.get(id);
  const p = (async () => {
    if (!isEnabled()) return null;
    await loadMap();
    const m = map.get('files|' + id);
    if (!m) return null;
    const blob = await (await api(`${API}/files/${m.f}?alt=media`)).blob();
    const rec = { id, name: id, type: blob.type, blob, _rev: m.r };
    await db.put('files', rec, { silent: true });
    return rec;
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

let loopStarted = false;
function startLoop() {
  if (loopStarted) return;
  loopStarted = true;
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 25000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
  addEventListener('online', () => syncNow());
  addEventListener('offline', () => setStatus('offline'));
}

// Avvio: `red` è il risultato di handleRedirect()
export async function init(red) {
  if (red && red.ok && red.connect) {
    let email = '';
    try { const a = await (await api(`${API}/about?fields=user(emailAddress)`)).json(); email = (a.user && a.user.emailAddress) || ''; } catch { /* ignore */ }
    cfg = { enabled: true, email, folderId: null, wm: null, last: null };
    saveCfg();
    await clearMap();
    await enqueueAll();
    setStatus('syncing', '', 'Primo collegamento…');
  } else if (red && red.error && (red.connect || isEnabled())) {
    setStatus(isEnabled() ? 'auth' : 'off', red.error === 'scope' ? 'Devi consentire l\'accesso a Google Drive.' : 'Accesso a Google non riuscito (' + red.error + ').');
  }
  if (!isEnabled()) { if (!state.error) setStatus('off'); return state; }
  startLoop();
  syncNow();
  return state;
}

export async function disconnect() {
  if (tok) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(tok.t), { method: 'POST', mode: 'no-cors' }).catch(() => {});
  cfg = null; tok = null; outbox = {};
  ls.set(LS_CFG, null); ls.set(LS_TOK, null); ls.set(LS_OUT, null);
  await clearMap();
  setStatus('off');
}
