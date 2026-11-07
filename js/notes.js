// Appunti stile Noteful: cartelle e sottocartelle, quaderni con carta a righe/quadretti,
// PDF da annotare, pagine, scrittura a penna e testo da tastiera.

import { db } from './db.js';
import { h, modal, toast, popMenu, promptText, confirmDialog, autoFocus } from './ui.js';
import { icon } from './icons.js';
import { uid, debounce, loadScript, pickFile, download, fmt, clamp, safeName, parseLocal } from './util.js';
import { InkSurface, inkToolbar, drawStroke, tools, emptyInk, inkColor, isDarkTheme, onTheme } from './ink.js';
import { fetchFile, isEnabled as isSyncEnabled } from './sync.js';

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const JSPDF = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';

export const A4 = 1.41421356;
export const COVERS = ['#5b5fc7', '#1a5fd0', '#038387', '#107c41', '#c19c00', '#e8730c', '#d13438', '#b4009e', '#7a3fd1', '#4f4f4f'];
export const FOLDER_COLORS = ['#5b5fc7', '#1a5fd0', '#038387', '#107c41', '#c19c00', '#e8730c', '#d13438', '#b4009e', '#8a8a8a'];
export const PAPERS = [['blank', 'Bianca'], ['lined', 'A righe'], ['grid', 'Quadretti'], ['dots', 'Puntini'], ['cornell', 'Cornell']];
// [id, colore nel tema chiaro, nome, colore nel tema scuro]
export const PAPER_COLORS = [['white', '#ffffff', 'Bianco', '#202020'], ['cream', '#fbf5e4', 'Avorio', '#28251e'], ['mint', '#eef7ef', 'Menta', '#1d2620'], ['sky', '#edf3fb', 'Cielo', '#1d222b']];
const paperHex = (id, dark) => (PAPER_COLORS.find(p => p[0] === id) || PAPER_COLORS[0])[dark ? 3 : 1];

// ---------- Carta e sfondi ----------
// dark = carta del tema scuro (righe chiare su fondo scuro)
export function drawPaper(ctx, W, H, paper = 'blank', color = 'white', dark = false) {
  ctx.fillStyle = paperHex(color, dark);
  ctx.fillRect(0, 0, W, H);
  const u = W / 1000;
  ctx.lineWidth = Math.max(0.6, 1.1 * u);
  const lines = (arr, style) => {
    ctx.strokeStyle = style; ctx.beginPath();
    for (const [x1, y1, x2, y2] of arr) { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
    ctx.stroke();
  };
  if (paper === 'lined' || paper === 'cornell') {
    const g = 34 * u, top = 110 * u, L = [];
    for (let y = top; y < H - 30 * u; y += g) L.push([0, y, W, y]);
    lines(L, dark ? 'rgba(130,165,235,.26)' : 'rgba(70,110,190,.28)');
    if (paper === 'lined') lines([[120 * u, 0, 120 * u, H]], dark ? 'rgba(240,110,110,.4)' : 'rgba(215,60,60,.35)');
    else {
      ctx.lineWidth = Math.max(1, 2 * u);
      lines([[280 * u, top - g, 280 * u, H - 280 * u], [0, H - 280 * u, W, H - 280 * u], [0, top - g, W, top - g]], dark ? 'rgba(220,220,220,.35)' : 'rgba(60,60,60,.45)');
    }
  } else if (paper === 'grid') {
    const g = 25 * u, L = [];
    for (let x = g; x < W; x += g) L.push([x, 0, x, H]);
    for (let y = g; y < H; y += g) L.push([0, y, W, y]);
    lines(L, dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.11)');
  } else if (paper === 'dots') {
    const g = 25 * u, r = Math.max(0.8, 1.4 * u);
    ctx.fillStyle = dark ? 'rgba(255,255,255,.28)' : 'rgba(0,0,0,.3)'; ctx.beginPath();
    for (let x = g; x < W; x += g) for (let y = g; y < H; y += g) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2); }
    ctx.fill();
  }
}
export function paperCanvas(W, H, d, paper, color, dark = false) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(W * d)); c.height = Math.max(1, Math.round(H * d));
  const ctx = c.getContext('2d'); ctx.scale(d, d);
  drawPaper(ctx, W, H, paper, color, dark);
  return c;
}

// ---------- File (PDF e immagini) ----------
// Legge un file dal dispositivo; se manca (creato su un altro dispositivo) lo scarica da Google Drive
export async function getFileRecord(id) {
  const f = await db.get('files', id);
  if (f) return f;
  if (!isSyncEnabled()) return null;
  const t = toast('Scarico il file da Google Drive…', { ms: 60000 });
  try { return await fetchFile(id); }
  catch (e) { console.warn(e); toast('File non disponibile: collegati a internet e a Google Drive.'); return null; }
  finally { t.remove(); }
}
const urlCache = new Map();
export function fileURL(id) {
  if (!urlCache.has(id)) {
    const p = getFileRecord(id).then(f => (f ? URL.createObjectURL(f.blob) : ''));
    p.then(u => { if (!u) urlCache.delete(id); });
    urlCache.set(id, p);
  }
  return urlCache.get(id);
}
export async function loadPdfJs() {
  await loadScript(PDFJS);
  const lib = window.pdfjsLib;
  lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  return lib;
}
const pdfDocs = new Map();
function getPdf(fileId) {
  if (!pdfDocs.has(fileId)) {
    const p = (async () => {
      const lib = await loadPdfJs();
      const f = await getFileRecord(fileId);
      if (!f) throw new Error('PDF non trovato');
      return lib.getDocument({ data: new Uint8Array(await f.blob.arrayBuffer()) }).promise;
    })();
    p.catch(() => pdfDocs.delete(fileId));
    pdfDocs.set(fileId, p);
  }
  return pdfDocs.get(fileId);
}
async function pdfCanvas(W, H, d, fileId, num) {
  const doc = await getPdf(fileId);
  const page = await doc.getPage(num);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: (W * d) / vp1.width });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return c;
}
export const bgFor = p => (W, H, d, dark) => (p.pdf ? pdfCanvas(W, H, d, p.pdf.fileId, p.pdf.page) : paperCanvas(W, H, d, p.paper, p.paperColor, dark));

function drawText(ctx, t, W, H, dark) {
  const fs = t.s * W / 1000, lh = fs * 1.3, maxW = t.w * W;
  ctx.save();
  ctx.fillStyle = inkColor(t.c, dark);
  ctx.font = `${fs}px "Segoe UI", system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = 'top';
  let y = t.y * H + (lh - fs) / 2;
  for (const para of (t.v || '').split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, t.x * W + 2, y); y += lh; line = word; }
      else line = test;
    }
    ctx.fillText(line, t.x * W + 2, y); y += lh;
  }
  ctx.restore();
}
// dark = come appare nel tema scuro (per le miniature); esportazioni in PDF/immagine restano chiare
export async function renderPageToCanvas(p, width, dark = false) {
  dark = dark && !p.pdf;
  const W = width, H = Math.round(width * p.aspect);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  try { const bg = await bgFor(p)(W, H, 1, dark); ctx.drawImage(bg, 0, 0, W, H); }
  catch { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); }
  const ink = p.ink || emptyInk();
  for (const im of ink.images) {
    try { const img = new Image(); img.src = await fileURL(im.fileId); await img.decode(); ctx.drawImage(img, im.x * W, im.y * H, im.w * W, im.h * H); } catch { /* immagine mancante */ }
  }
  for (const s of ink.strokes) drawStroke(ctx, s, W, H, dark);
  for (const t of ink.texts) drawText(ctx, t, W, H, dark);
  return c;
}

// ---------- Operazioni sui dati ----------
const newPage = (nb, index, like) => ({
  id: uid(), notebookId: nb.id, index,
  aspect: like && !like.pdf && like.aspect ? like.aspect : A4,
  paper: (like && !like.pdf && like.paper) || (nb.kind === 'pdf' ? 'blank' : nb.paper) || 'lined',
  paperColor: (like && !like.pdf && like.paperColor) || nb.paperColor || 'white',
  ink: emptyInk(),
});

export async function createNotebook({ title, folderId = null, cover, paper = 'lined', paperColor = 'white', eventId }) {
  const now = Date.now();
  const nb = { id: uid(), title: title || 'Nuovo quaderno', folderId, cover: cover || COVERS[0], paper, paperColor, kind: 'note', eventId, createdAt: now, updatedAt: now };
  await db.put('notebooks', nb);
  await db.put('pages', newPage(nb, 0));
  return nb.id;
}

// Crea il quaderno collegato a un evento del calendario (cartella "Riunioni e lezioni")
export async function createLinkedNotebook(ev, color) {
  const folders = await db.all('folders');
  let f = folders.find(x => x.system === 'meetings');
  if (!f) {
    f = { id: uid(), name: 'Riunioni e lezioni', parentId: null, color: '#5b5fc7', system: 'meetings', createdAt: Date.now() };
    await db.put('folders', f);
  }
  const d = parseLocal(ev.start);
  return createNotebook({ title: `${ev.title} – ${d.toLocaleDateString('it-IT')}`, folderId: f.id, cover: color || COVERS[0], paper: 'lined', eventId: ev.id });
}

async function deleteNotebook(id) {
  const pages = await db.byIndex('pages', 'notebookId', id);
  const files = new Set();
  for (const p of pages) { if (p.pdf) files.add(p.pdf.fileId); for (const im of (p.ink && p.ink.images) || []) files.add(im.fileId); }
  await db.delMany('pages', pages.map(p => p.id));
  await db.delMany('files', [...files]);
  await db.del('notebooks', id);
}

async function duplicateNotebook(nb) {
  const pages = await db.byIndex('pages', 'notebookId', nb.id);
  const fileMap = new Map();
  const cloneFile = async id => {
    if (!fileMap.has(id)) {
      const f = await getFileRecord(id);
      const nid = uid();
      if (f) await db.put('files', { id: nid, name: f.name, type: f.type, blob: f.blob });
      fileMap.set(id, nid);
    }
    return fileMap.get(id);
  };
  const now = Date.now();
  const copy = { ...nb, id: uid(), title: nb.title + ' (copia)', createdAt: now, updatedAt: now };
  const newPages = [];
  for (const p of pages) {
    const np = JSON.parse(JSON.stringify(p));
    np.id = uid(); np.notebookId = copy.id;
    if (np.pdf) np.pdf.fileId = await cloneFile(np.pdf.fileId);
    for (const im of np.ink.images) im.fileId = await cloneFile(im.fileId);
    newPages.push(np);
  }
  await db.putMany('pages', newPages);
  await db.put('notebooks', copy);
}

export async function exportNotebookPdf(nb, pages) {
  if (!pages) pages = (await db.byIndex('pages', 'notebookId', nb.id)).sort((a, b) => a.index - b.index);
  const t = toast('Creazione del PDF in corso…', { ms: 60000 });
  try {
    await loadScript(JSPDF);
    const { jsPDF } = window.jspdf;
    let doc = null;
    for (const p of pages) {
      const wPt = 595.28, hPt = wPt * p.aspect, orient = hPt >= wPt ? 'portrait' : 'landscape';
      const c = await renderPageToCanvas(p, 1240);
      const img = c.toDataURL('image/jpeg', 0.9);
      if (!doc) doc = new jsPDF({ unit: 'pt', format: [wPt, hPt], orientation: orient });
      else doc.addPage([wPt, hPt], orient);
      doc.addImage(img, 'JPEG', 0, 0, wPt, hPt);
    }
    doc.save(safeName(nb.title) + '.pdf');
    t.remove();
  } catch (e) { t.remove(); toast('Errore durante l\'esportazione: ' + e.message); }
}

// ---------- Piccoli componenti ----------
const field = (label, ...kids) => h('div', { class: 'field' }, h('label', {}, label), ...kids);
const mark = (group, el) => { group.querySelectorAll('.active').forEach(x => x.classList.remove('active')); el.classList.add('active'); };
const byName = (a, b) => a.name.localeCompare(b.name, 'it', { numeric: true });

function colorDialog(title, colors, current) {
  return new Promise(res => {
    let done = false;
    const grid = h('div', { class: 'swatches' }, colors.map(c => h('button', {
      class: 'swatch lg' + (c === current ? ' active' : ''), style: { background: c }, 'aria-label': c,
      onclick: () => { done = true; res(c); m.close(); },
    })));
    const m = modal({ title, body: grid, actions: [{ label: 'Annulla' }], onClose: () => { if (!done) res(null); } });
  });
}

function moveDialog(title, folders, exclude) {
  return new Promise(res => {
    let chosen, done = false;
    const list = h('div', { class: 'move-list' });
    const mk = (id, name, depth, color) => h('button', {
      class: 'move-row', style: { paddingLeft: (10 + depth * 18) + 'px' },
      onclick: e => { mark(list, e.currentTarget); chosen = id; },
    }, h('span', { style: { color: color || 'var(--text2)' } }, icon(id === null ? 'notes' : 'folderFill')), name);
    list.append(mk(null, 'Tutti gli appunti (livello principale)', 0));
    const walk = (pid, depth) => {
      for (const f of folders.filter(x => (x.parentId || null) === pid).sort(byName)) {
        if (exclude.has(f.id)) continue;
        list.append(mk(f.id, f.name, depth, f.color));
        walk(f.id, depth + 1);
      }
    };
    walk(null, 1);
    modal({
      title, body: list,
      actions: [{ label: 'Annulla' }, { label: 'Sposta qui', primary: true, onClick: c => { if (chosen === undefined) { toast('Scegli una cartella'); return; } done = true; res(chosen); c(); } }],
      onClose: () => { if (!done) res(undefined); },
    });
  });
}

function newNotebookDialog(folderId) {
  let cover = COVERS[0], paper = 'lined', pcolor = 'white';
  const title = h('input', { class: 'input', placeholder: 'Es. Analisi 1 – Lezioni' });
  const covers = h('div', { class: 'swatches' }, COVERS.map(c => h('button', { class: 'swatch lg' + (c === cover ? ' active' : ''), style: { background: c }, 'aria-label': 'Copertina ' + c, onclick: e => { cover = c; mark(covers, e.currentTarget); } })));
  const papers = h('div', { class: 'paper-opts' }, PAPERS.map(([id, label]) => {
    const cv = paperCanvas(64, 90, 2, id, 'white'); cv.className = 'paper-prev';
    return h('button', { class: 'paper-opt' + (id === paper ? ' active' : ''), onclick: e => { paper = id; mark(papers, e.currentTarget); } }, cv, h('span', {}, label));
  }));
  const pcolors = h('div', { class: 'swatches' }, PAPER_COLORS.map(([id, hex, label]) => h('button', { class: 'swatch lg bordered' + (id === pcolor ? ' active' : ''), title: label, 'aria-label': label, style: { background: hex }, onclick: e => { pcolor = id; mark(pcolors, e.currentTarget); } })));
  const create = async c => {
    const id = await createNotebook({ title: title.value.trim() || 'Nuovo quaderno', folderId, cover, paper, paperColor: pcolor });
    c();
    location.hash = '#/notebook/' + id;
  };
  const m = modal({
    title: 'Nuovo quaderno',
    body: h('div', { class: 'form' }, field('Titolo', title), field('Copertina', covers), field('Tipo di carta', papers), field('Colore della carta', pcolors)),
    actions: [{ label: 'Annulla' }, { label: 'Crea quaderno', primary: true, onClick: create }],
  });
  title.addEventListener('keydown', e => { if (e.key === 'Enter') create(m.close); });
  autoFocus(title);
}

async function importPdf(folderId, after) {
  const files = await pickFile('application/pdf,.pdf', true);
  if (!files.length) return;
  const t = toast('Importazione PDF in corso…', { ms: 120000 });
  try {
    const lib = await loadPdfJs();
    let lastId;
    for (const f of files) {
      const doc = await lib.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
      const fileId = uid();
      await db.put('files', { id: fileId, name: f.name, type: 'application/pdf', blob: f });
      const nbId = uid(), now = Date.now(), pages = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
        pages.push({ id: uid(), notebookId: nbId, index: i - 1, aspect: vp.height / vp.width, paper: 'blank', paperColor: 'white', pdf: { fileId, page: i }, ink: emptyInk() });
      }
      await db.putMany('pages', pages);
      await db.put('notebooks', { id: nbId, title: f.name.replace(/\.pdf$/i, ''), folderId, cover: COVERS[(Math.random() * COVERS.length) | 0], paper: 'blank', paperColor: 'white', kind: 'pdf', createdAt: now, updatedAt: now });
      pdfDocs.set(fileId, Promise.resolve(doc));
      lastId = nbId;
    }
    t.remove();
    toast(files.length > 1 ? `${files.length} PDF importati` : 'PDF importato');
    if (files.length === 1) location.hash = '#/notebook/' + lastId; else after && after();
  } catch (e) {
    t.remove();
    toast('Errore nell\'importazione del PDF: ' + e.message);
  }
}

// =====================================================================
// LIBRERIA (cartelle + quaderni)
// =====================================================================
const EXP_KEY = 'pfy-expanded';
const expanded = new Set((() => { try { return JSON.parse(localStorage.getItem(EXP_KEY) || '[]'); } catch { return []; } })());
const saveExpanded = () => { try { localStorage.setItem(EXP_KEY, JSON.stringify([...expanded])); } catch { /* ignore */ } };
const libState = { search: '', sort: localStorage.getItem('pfy-sort') || 'updated' };

export async function renderNotes(host, { folderId = null }) {
  let folders = [], notebooks = [];
  const wrap = h('div', { class: 'notes' });
  host.append(wrap);
  const current = folderId === 'recent' ? 'recent' : (folderId || null);

  const load = async () => { [folders, notebooks] = await Promise.all([db.all('folders'), db.all('notebooks')]); };
  const refresh = async () => { await load(); draw(); };
  const go = id => { location.hash = id ? '#/notes/folder/' + id : '#/notes'; };
  const children = pid => folders.filter(f => (f.parentId || null) === pid).sort(byName);
  const descendants = id => { const out = new Set(); const walk = p => { for (const f of folders) if (f.parentId === p && !out.has(f.id)) { out.add(f.id); walk(f.id); } }; walk(id); return out; };
  const pathTo = id => { const out = []; let f = folders.find(x => x.id === id); while (f) { out.unshift(f); f = folders.find(x => x.id === f.parentId); } return out; };
  const countIn = id => folders.filter(f => f.parentId === id).length + notebooks.filter(n => n.folderId === id).length;

  // ----- spostamenti -----
  async function moveItem(type, id, target) {
    if (type === 'nb') {
      const nb = notebooks.find(n => n.id === id);
      if (!nb || (nb.folderId || null) === target) return;
      nb.folderId = target; await db.put('notebooks', nb);
    } else if (type === 'folder') {
      if (id === target || descendants(id).has(target)) { toast('Non puoi spostare una cartella dentro sé stessa'); return; }
      const f = folders.find(x => x.id === id);
      if (!f || (f.parentId || null) === target) return;
      f.parentId = target; await db.put('folders', f);
    }
    toast('Spostato');
    refresh();
  }
  const dragSrc = (el, type, id) => {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', type + ':' + id); e.dataTransfer.effectAllowed = 'move'; });
  };
  const dropTarget = (el, target) => {
    el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drop'); });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', e => {
      e.preventDefault(); el.classList.remove('drop');
      const [type, id] = (e.dataTransfer.getData('text/plain') || '').split(':');
      if (type && id) moveItem(type, id, target);
    });
  };

  // ----- azioni -----
  async function newFolder(parentId) {
    const name = await promptText(parentId ? 'Nuova sottocartella' : 'Nuova cartella', { label: 'Nome', placeholder: 'Es. Primo semestre', okLabel: 'Crea' });
    if (!name) return;
    const f = { id: uid(), name, parentId: parentId || null, color: FOLDER_COLORS[0], createdAt: Date.now() };
    await db.put('folders', f);
    if (parentId) { expanded.add(parentId); saveExpanded(); }
    refresh();
  }
  function folderMenu(anchor, f) {
    popMenu(anchor, [
      { label: 'Apri', icon: 'open', onClick: () => go(f.id) },
      { label: 'Nuova sottocartella', icon: 'folderPlus', onClick: () => newFolder(f.id) },
      { label: 'Nuovo quaderno qui', icon: 'notes', onClick: () => newNotebookDialog(f.id) },
      { divider: true },
      { label: 'Rinomina', icon: 'edit', onClick: async () => { const n = await promptText('Rinomina cartella', { value: f.name, okLabel: 'Salva' }); if (n) { f.name = n; await db.put('folders', f); refresh(); } } },
      { label: 'Colore', icon: 'palette', onClick: async () => { const c = await colorDialog('Colore della cartella', FOLDER_COLORS, f.color); if (c) { f.color = c; await db.put('folders', f); refresh(); } } },
      { label: 'Sposta in…', icon: 'folderMove', onClick: async () => { const ex = descendants(f.id); ex.add(f.id); const t = await moveDialog('Sposta "' + f.name + '"', folders, ex); if (t !== undefined) moveItem('folder', f.id, t); } },
      { divider: true },
      {
        label: 'Elimina', icon: 'trash', danger: true, onClick: async () => {
          const ids = descendants(f.id); ids.add(f.id);
          const nbs = notebooks.filter(n => ids.has(n.folderId));
          const ok = await confirmDialog(`Eliminare "${f.name}"${ids.size > 1 ? ' con le sue sottocartelle' : ''}${nbs.length ? ` e ${nbs.length} quaderni` : ''}? L'operazione non si può annullare.`, { title: 'Elimina cartella', okLabel: 'Elimina', danger: true });
          if (!ok) return;
          for (const n of nbs) await deleteNotebook(n.id);
          await db.delMany('folders', [...ids]);
          if (current && ids.has(current)) go(f.parentId); else refresh();
        },
      },
    ]);
  }
  function notebookMenu(anchor, nb) {
    popMenu(anchor, [
      { label: 'Apri', icon: 'open', onClick: () => { location.hash = '#/notebook/' + nb.id; } },
      { label: 'Rinomina', icon: 'edit', onClick: async () => { const n = await promptText('Rinomina quaderno', { value: nb.title, okLabel: 'Salva' }); if (n) { nb.title = n; await db.put('notebooks', nb); refresh(); } } },
      { label: 'Copertina', icon: 'palette', onClick: async () => { const c = await colorDialog('Colore della copertina', COVERS, nb.cover); if (c) { nb.cover = c; await db.put('notebooks', nb); refresh(); } } },
      { label: 'Sposta in…', icon: 'folderMove', onClick: async () => { const t = await moveDialog('Sposta "' + nb.title + '"', folders, new Set()); if (t !== undefined) moveItem('nb', nb.id, t); } },
      { label: 'Duplica', icon: 'copy', onClick: async () => { await duplicateNotebook(nb); toast('Quaderno duplicato'); refresh(); } },
      { label: 'Esporta PDF', icon: 'download', onClick: () => exportNotebookPdf(nb) },
      { divider: true },
      { label: 'Elimina', icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog(`Eliminare il quaderno "${nb.title}"? L'operazione non si può annullare.`, { title: 'Elimina quaderno', okLabel: 'Elimina', danger: true })) { await deleteNotebook(nb.id); refresh(); } } },
    ]);
  }
  const target = () => (current === 'recent' ? null : current);
  const newMenu = anchor => popMenu(anchor, [
    { label: 'Quaderno', icon: 'notes', onClick: () => newNotebookDialog(target()) },
    { label: target() ? 'Sottocartella' : 'Cartella', icon: 'folderPlus', onClick: () => newFolder(target()) },
    { label: 'Importa PDF da annotare', icon: 'file', onClick: () => importPdf(target(), refresh) },
  ]);

  // ----- albero cartelle -----
  function treePane() {
    const tree = h('div', { class: 'tree', role: 'tree' });
    const row = (id, name, ic, depth, { color, hasKids, folder } = {}) => {
      const isOpen = folder && expanded.has(id);
      const r = h('div', {
        class: 'tree-row' + (current === id ? ' active' : '') + (folder && !isOpen ? ' collapsed' : ''), role: 'treeitem',
        style: { paddingLeft: (6 + depth * 16) + 'px' },
        onclick: () => go(id),
      },
        h('button', {
          class: 'tw' + (hasKids ? '' : ' empty'), 'aria-label': 'Espandi',
          onclick: e => { e.stopPropagation(); if (!hasKids) return; if (expanded.has(id)) expanded.delete(id); else expanded.add(id); saveExpanded(); draw(); },
        }, hasKids ? icon('chevD') : null),
        h('span', { class: 'ti', style: { color: color || 'var(--text2)' } }, icon(ic)),
        h('span', { class: 'name' }, name),
        folder ? h('span', { class: 'count' }, countIn(id) || '') : null);
      if (folder) {
        dragSrc(r, 'folder', id);
        r.addEventListener('contextmenu', e => { e.preventDefault(); folderMenu({ x: e.clientX, y: e.clientY }, folders.find(f => f.id === id)); });
      }
      if (id !== 'recent') dropTarget(r, id);
      return r;
    };
    tree.append(row(null, 'Tutti gli appunti', 'notes', 0), row('recent', 'Recenti', 'clock', 0));
    tree.append(h('div', { class: 'tree-sep' }));
    const walk = (pid, depth) => {
      for (const f of children(pid)) {
        const kids = folders.some(x => x.parentId === f.id);
        tree.append(row(f.id, f.name, 'folderFill', depth, { color: f.color, hasKids: kids, folder: true }));
        if (kids && expanded.has(f.id)) walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    if (!folders.length) tree.append(h('p', { class: 'tree-empty' }, 'Nessuna cartella. Creane una con il pulsante +'));
    return h('aside', { class: 'tree-pane' },
      h('div', { class: 'tree-head' }, h('span', {}, 'Cartelle'), h('button', { class: 'icon-btn', title: 'Nuova cartella', 'aria-label': 'Nuova cartella', onclick: () => newFolder(target()) }, icon('folderPlus'))),
      tree);
  }

  // ----- contenuto principale -----
  const gridHost = h('div', { class: 'lib-scroll' });
  function mainPane() {
    const crumbs = h('div', { class: 'crumbs' });
    const crumb = (label, id, last) => h('button', { class: 'crumb' + (last ? ' last' : ''), onclick: () => go(id) }, label);
    if (current === 'recent') crumbs.append(crumb('Recenti', 'recent', true));
    else {
      const path = current ? pathTo(current) : [];
      crumbs.append(crumb('Tutti gli appunti', null, !path.length));
      path.forEach((f, i) => crumbs.append(icon('chevR', 'crumb-sep'), crumb(f.name, f.id, i === path.length - 1)));
    }
    const search = h('input', { class: 'input search', type: 'search', placeholder: 'Cerca quaderni…', value: libState.search, 'aria-label': 'Cerca' });
    search.addEventListener('input', () => { libState.search = search.value; drawGrid(); });
    const sort = h('select', { class: 'input sm', 'aria-label': 'Ordina', onchange: () => { libState.sort = sort.value; localStorage.setItem('pfy-sort', sort.value); drawGrid(); } },
      h('option', { value: 'updated' }, 'Modificati di recente'), h('option', { value: 'name' }, 'Nome'), h('option', { value: 'created' }, 'Data di creazione'));
    sort.value = libState.sort;
    const top = h('div', { class: 'topbar lib-top' },
      h('button', { class: 'icon-btn only-narrow', 'aria-label': 'Cartelle', onclick: () => wrap.classList.toggle('tree-open') }, icon('sidebar')),
      crumbs, h('div', { class: 'grow' }),
      h('div', { class: 'search-wrap' }, icon('search'), search), sort,
      h('button', { class: 'btn primary', onclick: e => newMenu(e.currentTarget) }, icon('plus'), h('span', {}, 'Nuovo')));
    drawGrid();
    return h('section', { class: 'lib-main' }, top, gridHost);
  }

  function drawGrid() {
    const q = libState.search.trim().toLowerCase();
    let fs = [], nbs = [];
    if (q) {
      fs = folders.filter(f => f.name.toLowerCase().includes(q));
      nbs = notebooks.filter(n => n.title.toLowerCase().includes(q));
    } else if (current === 'recent') {
      nbs = [...notebooks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 24);
    } else {
      fs = children(current);
      nbs = notebooks.filter(n => (n.folderId || null) === current);
    }
    if (current !== 'recent' || q) {
      const s = libState.sort;
      nbs.sort(s === 'name' ? (a, b) => a.title.localeCompare(b.title, 'it', { numeric: true }) : s === 'created' ? (a, b) => b.createdAt - a.createdAt : (a, b) => b.updatedAt - a.updatedAt);
    }
    const out = [];
    if (fs.length) {
      out.push(h('div', { class: 'section-title' }, 'Cartelle'));
      out.push(h('div', { class: 'grid folders' }, fs.map(f => {
        const more = h('button', { class: 'icon-btn more', 'aria-label': 'Opzioni', onclick: e => { e.stopPropagation(); folderMenu(e.currentTarget, f); } }, icon('more'));
        const n = countIn(f.id);
        const tile = h('div', { class: 'tile folder-tile', onclick: () => go(f.id) },
          h('div', { class: 'fbig', style: { color: f.color } }, icon('folderFill')),
          h('div', { class: 'tile-text' }, h('div', { class: 'tile-title' }, f.name), h('div', { class: 'tile-sub' }, n === 1 ? '1 elemento' : `${n} elementi`)),
          more);
        dragSrc(tile, 'folder', f.id); dropTarget(tile, f.id);
        return tile;
      })));
    }
    if (nbs.length) {
      out.push(h('div', { class: 'section-title' }, q ? 'Quaderni trovati' : 'Quaderni'));
      out.push(h('div', { class: 'grid notebooks' }, nbs.map(nb => {
        const more = h('button', { class: 'icon-btn more', 'aria-label': 'Opzioni', onclick: e => { e.stopPropagation(); notebookMenu(e.currentTarget, nb); } }, icon('more'));
        const where = (q || current === 'recent') && nb.folderId ? pathTo(nb.folderId).map(f => f.name).join(' › ') : '';
        const tile = h('div', { class: 'tile nb-tile', onclick: () => { location.hash = '#/notebook/' + nb.id; } },
          h('div', { class: 'cover', style: { '--c': nb.cover } },
            h('div', { class: 'label' }, nb.title),
            nb.kind === 'pdf' ? h('span', { class: 'badge' }, 'PDF') : null),
          h('div', { class: 'tile-title', title: nb.title }, nb.title),
          h('div', { class: 'tile-sub' }, where || fmt.rel(nb.updatedAt)),
          more);
        tile.addEventListener('contextmenu', e => { e.preventDefault(); notebookMenu({ x: e.clientX, y: e.clientY }, nb); });
        dragSrc(tile, 'nb', nb.id);
        return tile;
      })));
    }
    if (!out.length) {
      out.push(h('div', { class: 'empty' },
        icon(q ? 'search' : 'notes'),
        h('h3', {}, q ? 'Nessun risultato' : (current === 'recent' ? 'Nessun quaderno recente' : 'Questa cartella è vuota')),
        h('p', {}, q ? 'Prova con un\'altra parola.' : 'Crea un quaderno, una sottocartella o importa un PDF da annotare.'),
        q ? null : h('div', { class: 'empty-actions' },
          h('button', { class: 'btn primary', onclick: () => newNotebookDialog(target()) }, icon('plus'), 'Nuovo quaderno'),
          h('button', { class: 'btn', onclick: () => newFolder(target()) }, icon('folderPlus'), target() ? 'Nuova sottocartella' : 'Nuova cartella'),
          h('button', { class: 'btn', onclick: () => importPdf(target(), refresh) }, icon('file'), 'Importa PDF'))));
    }
    gridHost.replaceChildren(...out);
  }

  function draw() {
    if (current && current !== 'recent') for (const f of pathTo(current).slice(0, -1)) expanded.add(f.id);
    wrap.replaceChildren(treePane(), mainPane(), h('div', { class: 'tree-scrim', onclick: () => wrap.classList.remove('tree-open') }));
  }

  await refresh();
  // Modifiche arrivate da un altro dispositivo
  const onRemote = e => { if (['folders', 'notebooks'].some(s => e.detail.has(s))) refresh(); };
  addEventListener('pfy-remote', onRemote);
  return () => removeEventListener('pfy-remote', onRemote);
}

// =====================================================================
// EDITOR DEL QUADERNO
// =====================================================================
export async function renderNotebook(host, { id }) {
  const nb = await db.get('notebooks', id);
  if (!nb) {
    host.append(h('div', { class: 'empty' }, icon('notes'), h('h3', {}, 'Quaderno non trovato'), h('a', { class: 'btn', href: '#/notes' }, 'Vai agli appunti')));
    return;
  }
  let pages = (await db.byIndex('pages', 'notebookId', id)).sort((a, b) => a.index - b.index);
  if (!pages.length) { const p = newPage(nb, 0); pages = [p]; await db.put('pages', p); }
  pages.forEach(p => { if (!p.ink) p.ink = emptyInk(); });

  let zoom = clamp(Number(localStorage.getItem('pfy-zoom')) || 1, 0.5, 4);
  let cur = 0;
  const surfaces = new Map(), savers = new Map();
  const touchNb = debounce(() => { nb.updatedAt = Date.now(); db.put('notebooks', nb); }, 800);
  const saver = p => {
    let s = savers.get(p.id);
    if (!s) { s = debounce(() => db.put('pages', p), 400); savers.set(p.id, s); }
    return s;
  };
  const flushAll = () => { savers.forEach(s => s.flush()); touchNb.flush(); };
  const curSurface = () => (InkSurface.active && [...surfaces.values()].includes(InkSurface.active) ? InkSurface.active : surfaces.get(pages[cur] && pages[cur].id));

  // ----- DOM -----
  const ed = h('div', { class: 'editor' });
  const scroll = h('div', { class: 'ed-scroll' });
  const pagesEl = h('div', { class: 'ed-pages' });
  scroll.append(pagesEl);
  const panel = h('aside', { class: 'pages-panel' });
  const ind = h('div', { class: 'page-ind' });
  const zoomLbl = h('button', { class: 'btn ghost zoom-lbl', title: 'Adatta alla larghezza', onclick: () => setZoom(1) }, '100%');
  const titleIn = h('input', { class: 'ed-title', value: nb.title, 'aria-label': 'Titolo del quaderno' });
  titleIn.addEventListener('change', () => { nb.title = titleIn.value.trim() || 'Senza titolo'; touchNb(); });
  titleIn.addEventListener('keydown', e => { if (e.key === 'Enter') titleIn.blur(); });
  const top = h('div', { class: 'ed-top' },
    h('button', { class: 'icon-btn', title: 'Torna agli appunti', 'aria-label': 'Indietro', onclick: () => { location.hash = nb.folderId ? '#/notes/folder/' + nb.folderId : '#/notes'; } }, icon('back')),
    h('button', { class: 'icon-btn', title: 'Pagine', 'aria-label': 'Pagine', onclick: togglePanel }, icon('pages')),
    titleIn,
    h('div', { class: 'grow' }),
    h('button', { class: 'icon-btn', title: 'Riduci', 'aria-label': 'Riduci', onclick: () => setZoom(zoom / 1.2) }, icon('zoomOut')),
    zoomLbl,
    h('button', { class: 'icon-btn', title: 'Ingrandisci', 'aria-label': 'Ingrandisci', onclick: () => setZoom(zoom * 1.2) }, icon('zoomIn')),
    h('button', { class: 'icon-btn', title: 'Altre opzioni', 'aria-label': 'Altre opzioni', onclick: e => moreMenu(e.currentTarget) }, icon('more')));
  const tb = inkToolbar({
    extra: [h('div', { class: 'tb-group' },
      h('button', { class: 'tool-btn', title: 'Inserisci immagine', 'aria-label': 'Inserisci immagine', onclick: insertImage }, icon('image')),
      h('button', { class: 'tool-btn', title: 'Tipo di carta', 'aria-label': 'Tipo di carta', onclick: e => paperMenu(e.currentTarget) }, icon('paper')),
      h('button', { class: 'tool-btn', title: 'Aggiungi pagina', 'aria-label': 'Aggiungi pagina', onclick: () => addPage(cur + 1) }, icon('pagePlus')))],
  });
  ed.append(top, h('div', { class: 'ed-tools' }, tb), h('div', { class: 'ed-body' }, panel, scroll, ind));
  host.append(ed);

  // ----- pagine -----
  const io = new IntersectionObserver(entries => {
    for (const en of entries) { const s = surfaces.get(en.target.dataset.id); if (s) s.setVisible(en.isIntersecting); }
  }, { root: scroll, rootMargin: '700px 0px' });
  const baseW = () => Math.max(260, Math.min(scroll.clientWidth - 32, 900));
  const pageW = () => Math.round(baseW() * zoom);

  function mountPages() {
    for (const s of surfaces.values()) s.destroy();
    surfaces.clear(); io.disconnect();
    pagesEl.replaceChildren();
    const w = pageW();
    for (const p of pages) {
      const el = h('div', { class: 'page', 'data-id': p.id, style: { width: w + 'px', height: Math.round(w * p.aspect) + 'px' } });
      pagesEl.append(el);
      const s = new InkSurface(el, { data: p.ink, blend: true, themed: !p.pdf, drawBackground: bgFor(p), loadFile: fileURL, onChange: () => { saver(p)(); touchNb(); } });
      s.setVisible(false);
      surfaces.set(p.id, s);
      io.observe(el);
    }
    zoomLbl.textContent = Math.round(zoom * 100) + '%';
    updateInd();
  }
  function applyWidths() {
    const w = pageW();
    [...pagesEl.children].forEach((el, i) => { el.style.width = w + 'px'; el.style.height = Math.round(w * pages[i].aspect) + 'px'; });
    zoomLbl.textContent = Math.round(zoom * 100) + '%';
  }
  function setZoom(z, focus) {
    z = clamp(z, 0.5, 4);
    if (Math.abs(z - zoom) < 0.001) return;
    const r = scroll.getBoundingClientRect();
    const fx = focus ? focus.x - r.left : scroll.clientWidth / 2, fy = focus ? focus.y - r.top : scroll.clientHeight / 2;
    const cx = scroll.scrollLeft + fx, cy = scroll.scrollTop + fy, ratio = z / zoom;
    zoom = z;
    try { localStorage.setItem('pfy-zoom', String(z)); } catch { /* ignore */ }
    applyWidths();
    scroll.scrollLeft = cx * ratio - fx;
    scroll.scrollTop = cy * ratio - fy;
  }
  function updateInd() {
    const mid = scroll.scrollTop + scroll.clientHeight / 2;
    const els = pagesEl.children;
    let best = 0;
    for (let i = 0; i < els.length; i++) { if (els[i].offsetTop <= mid) best = i; else break; }
    if (best !== cur) { cur = best; panel.querySelectorAll('.thumb').forEach((t, i) => t.classList.toggle('active', i === cur)); }
    ind.textContent = `${cur + 1} / ${pages.length}`;
  }
  const scrollToPage = (i, smooth = true) => {
    const el = pagesEl.children[i];
    if (el) scroll.scrollTo({ top: el.offsetTop - 16, behavior: smooth ? 'smooth' : 'auto' });
  };
  const reindex = () => pages.forEach((p, i) => { p.index = i; });

  async function addPage(at) {
    const p = newPage(nb, at, pages[Math.min(at - 1, pages.length - 1)]);
    pages.splice(at, 0, p);
    reindex();
    await db.putMany('pages', pages);
    flushAll(); mountPages(); refreshPanel();
    requestAnimationFrame(() => scrollToPage(at));
    touchNb();
  }
  async function deletePage(i) {
    if (pages.length === 1) { toast('Il quaderno deve avere almeno una pagina'); return; }
    if (!await confirmDialog(`Eliminare la pagina ${i + 1}?`, { title: 'Elimina pagina', okLabel: 'Elimina', danger: true })) return;
    const [p] = pages.splice(i, 1);
    const s = savers.get(p.id); if (s) savers.delete(p.id);
    await db.del('pages', p.id);
    reindex(); await db.putMany('pages', pages);
    flushAll(); mountPages(); refreshPanel(); touchNb();
  }
  async function duplicatePage(i) {
    const p = JSON.parse(JSON.stringify(pages[i]));
    p.id = uid();
    pages.splice(i + 1, 0, p);
    reindex(); await db.putMany('pages', pages);
    flushAll(); mountPages(); refreshPanel(); touchNb();
  }
  async function movePage(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= pages.length) return;
    [pages[i], pages[j]] = [pages[j], pages[i]];
    reindex(); await db.putMany('pages', pages);
    flushAll(); mountPages(); refreshPanel();
    requestAnimationFrame(() => scrollToPage(j, false));
  }

  // ----- pannello pagine (miniature) -----
  function togglePanel() { ed.classList.toggle('show-pages'); refreshPanel(); }
  let thumbJob = 0;
  function refreshPanel() {
    if (!ed.classList.contains('show-pages')) return;
    const job = ++thumbJob;
    panel.replaceChildren();
    const slots = pages.map((p, i) => {
      const img = h('div', { class: 'thumb-img', style: { aspectRatio: `1 / ${p.aspect}` } });
      const more = h('button', {
        class: 'icon-btn', 'aria-label': 'Opzioni pagina', onclick: e => {
          e.stopPropagation();
          popMenu(e.currentTarget, [
            { label: 'Aggiungi pagina dopo', icon: 'pagePlus', onClick: () => addPage(i + 1) },
            { label: 'Duplica', icon: 'copy', onClick: () => duplicatePage(i) },
            { label: 'Sposta su', icon: 'arrowUp', onClick: () => movePage(i, -1) },
            { label: 'Sposta giù', icon: 'arrowDown', onClick: () => movePage(i, 1) },
            { divider: true },
            { label: 'Elimina pagina', icon: 'trash', danger: true, onClick: () => deletePage(i) },
          ]);
        },
      }, icon('more'));
      panel.append(h('div', { class: 'thumb' + (i === cur ? ' active' : ''), onclick: () => { scrollToPage(i); if (innerWidth < 700) togglePanel(); } }, img, h('div', { class: 'thumb-foot' }, h('span', {}, i + 1), more)));
      return img;
    });
    panel.append(h('button', { class: 'btn add-page', onclick: () => addPage(pages.length) }, icon('plus'), 'Pagina'));
    (async () => {
      for (let i = 0; i < pages.length; i++) {
        if (job !== thumbJob) return;
        try { const c = await renderPageToCanvas(pages[i], 220, isDarkTheme()); if (job === thumbJob) slots[i].append(c); } catch { /* ignore */ }
      }
    })();
  }

  // ----- menu -----
  function paperMenu(anchor) {
    const apply = async patch => {
      Object.assign(nb, patch);
      for (const p of pages) if (!p.pdf) Object.assign(p, patch);
      await db.putMany('pages', pages.filter(p => !p.pdf));
      touchNb();
      for (const s of surfaces.values()) s.refreshBackground();
    };
    const sample = pages.find(p => !p.pdf) || nb;
    popMenu(anchor, [
      { heading: 'Tipo di carta (tutte le pagine)' },
      ...PAPERS.map(([pid, label]) => ({ label, icon: 'paper', active: sample.paper === pid, onClick: () => apply({ paper: pid }) })),
      { divider: true },
      { heading: 'Colore della carta' },
      ...PAPER_COLORS.map(([pid, hex, label]) => ({ label, swatch: hex, active: sample.paperColor === pid, onClick: () => apply({ paperColor: pid }) })),
    ]);
  }
  function moreMenu(anchor) {
    popMenu(anchor, [
      { label: 'Esporta come PDF', icon: 'download', onClick: () => { flushAll(); exportNotebookPdf(nb, pages); } },
      { label: 'Esporta pagina come immagine', icon: 'image', onClick: async () => { const c = await renderPageToCanvas(pages[cur], 1600); c.toBlob(b => download(b, `${safeName(nb.title)} - pagina ${cur + 1}.png`)); } },
      { divider: true },
      { label: 'Aggiungi pagina alla fine', icon: 'pagePlus', onClick: () => addPage(pages.length) },
      { label: 'Duplica pagina corrente', icon: 'copy', onClick: () => duplicatePage(cur) },
      { label: 'Elimina pagina corrente', icon: 'trash', danger: true, onClick: () => deletePage(cur) },
    ]);
  }
  async function insertImage() {
    const [f] = await pickFile('image/*');
    if (!f) return;
    const fileId = uid();
    await db.put('files', { id: fileId, name: f.name, type: f.type, blob: f });
    let aspect = 0.75;
    try { const bmp = await createImageBitmap(f); aspect = bmp.height / bmp.width; if (bmp.close) bmp.close(); } catch { /* formato non leggibile */ }
    const s = surfaces.get(pages[cur].id);
    if (s) s.addImage(fileId, aspect);
  }

  // ----- gesti: zoom con due dita, Ctrl+rotellina -----
  let pinch = null;
  const tdist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const tmid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
  scroll.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      const [a, b] = e.touches;
      pinch = { d: tdist(a, b), z: zoom, m: tmid(a, b) };
      for (const s of surfaces.values()) if (s.gesture) s.cancelGesture();
    }
  }, { passive: true });
  scroll.addEventListener('touchmove', e => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const [a, b] = e.touches, m = tmid(a, b);
    setZoom(pinch.z * tdist(a, b) / pinch.d, m);
    scroll.scrollLeft -= m.x - pinch.m.x;
    scroll.scrollTop -= m.y - pinch.m.y;
    pinch.m = m;
  }, { passive: false });
  scroll.addEventListener('touchend', e => { if (e.touches.length < 2) pinch = null; });
  scroll.addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { x: e.clientX, y: e.clientY });
  }, { passive: false });
  let indRaf = 0;
  scroll.addEventListener('scroll', () => { if (!indRaf) indRaf = requestAnimationFrame(() => { indRaf = 0; updateInd(); }); });

  const onKey = e => {
    const a = document.activeElement;
    if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
    if (document.querySelector('.modal-overlay')) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase(), s = curSurface();
    if (mod && k === 'z') { e.preventDefault(); if (s) (e.shiftKey ? s.redo() : s.undo()); }
    else if (mod && k === 'y') { e.preventDefault(); if (s) s.redo(); }
    else if (!mod && !e.altKey) {
      const map = { p: 'pen', h: 'highlighter', e: 'eraser', l: 'lasso', t: 'text', m: 'hand' };
      if (map[k]) tools.set({ tool: map[k] });
      else if ((e.key === 'Delete' || e.key === 'Backspace') && s && s.sel) { e.preventDefault(); s.deleteSel(); }
    }
  };
  const onResize = debounce(applyWidths, 150);
  const onVis = () => { if (document.visibilityState === 'hidden') flushAll(); };
  // Modifiche arrivate da un altro dispositivo
  const onRemote = async e => {
    const ch = e.detail;
    if (ch.has('notebooks') && ch.get('notebooks').has(nb.id)) {
      const fresh = await db.get('notebooks', nb.id);
      if (!fresh) { toast('Questo quaderno è stato eliminato su un altro dispositivo'); location.hash = '#/notes'; return; }
      Object.assign(nb, fresh);
      if (document.activeElement !== titleIn) titleIn.value = nb.title;
    }
    if (!ch.has('pages')) return;
    const fresh = (await db.byIndex('pages', 'notebookId', id)).sort((a, b) => a.index - b.index);
    if (!fresh.length) return;
    const same = fresh.length === pages.length && fresh.every((p, i) => p.id === pages[i].id);
    if (!same) {
      flushAll(); savers.clear();
      fresh.forEach(p => { if (!p.ink) p.ink = emptyInk(); });
      pages = fresh;
      mountPages(); refreshPanel();
      return;
    }
    for (const f of fresh) {
      if (!ch.get('pages').has(f.id)) continue;
      const p = pages.find(x => x.id === f.id), s = surfaces.get(f.id);
      if (!p || (s && s.isBusy())) continue;
      const bgChanged = p.paper !== f.paper || p.paperColor !== f.paperColor;
      const { ink, ...rest } = f;
      Object.assign(p, rest);
      if (s) { s.replaceData(ink || emptyInk()); if (bgChanged) s.refreshBackground(); }
      else p.ink = ink || emptyInk();
    }
  };
  document.addEventListener('keydown', onKey);
  addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVis);
  addEventListener('pagehide', flushAll);
  addEventListener('pfy-flush', flushAll);
  addEventListener('pfy-remote', onRemote);

  mountPages();
  // cambio tema: le miniature vanno ridisegnate (le pagine si aggiornano da sole)
  const offTheme = onTheme(() => refreshPanel());

  return () => {
    flushAll();
    for (const s of surfaces.values()) s.destroy();
    io.disconnect();
    tb.destroy();
    offTheme();
    thumbJob++;
    document.removeEventListener('keydown', onKey);
    removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVis);
    removeEventListener('pagehide', flushAll);
    removeEventListener('pfy-flush', flushAll);
    removeEventListener('pfy-remote', onRemote);
  };
}
