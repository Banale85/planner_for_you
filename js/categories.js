// Categorie del calendario: le crea e le personalizza l'utente (al massimo 10).
// Senza un colore scelto, una categoria è "bianco panna". Si sincronizzano su tutti i dispositivi.

import { db } from './db.js';
import { h, modal, toast, autoFocus } from './ui.js';
import { uid } from './util.js';

export const MAX_CATS = 10;
export const CREAM = '#efe6cf';   // bianco panna (per le copertine dei quaderni collegati)
export const CAT_COLORS = ['#5b5fc7', '#0f6cbd', '#038387', '#107c41', '#8cbd18', '#c19c00', '#e8730c', '#d13438', '#e43ba6', '#7a3fd1', '#8e562e', '#737373'];
const KEY = 'categories';

let list = [];

export async function loadCats() {
  try {
    const r = await db.get('prefs', KEY);
    list = r && Array.isArray(r.list) ? r.list : [];
  } catch { list = []; }
  return list;
}
export const cats = () => list;
export const catOf = id => (id && list.find(c => c.id === id)) || null;
// Colore per l'interfaccia: senza colore è bianco panna, che si adatta al tema (variabile CSS)
export const catColor = id => (catOf(id) && catOf(id).color) || 'var(--cream)';
export const isCream = id => !(catOf(id) && catOf(id).color);
export const catHex = id => (catOf(id) && catOf(id).color) || CREAM;

async function save(next) {
  list = next.slice(0, MAX_CATS);
  await db.put('prefs', { key: KEY, list });
  dispatchEvent(new Event('pfy-cats'));
}
export async function addCat(name, color) {
  if (list.length >= MAX_CATS) { toast(`Puoi avere al massimo ${MAX_CATS} categorie.`); return null; }
  const c = { id: uid(), name, color: color || null };
  await save([...list, c]);
  return c;
}
export const updateCat = (id, patch) => save(list.map(c => (c.id === id ? { ...c, ...patch } : c)));
// Gli eventi che usavano la categoria restano senza categoria (bianco panna)
export const removeCat = id => save(list.filter(c => c.id !== id));

loadCats();

// Categorie modificate su un altro dispositivo
addEventListener('pfy-remote', e => {
  if (e.detail && e.detail.has('prefs')) loadCats().then(() => dispatchEvent(new Event('pfy-cats')));
});

// Finestra per creare o modificare una categoria. Restituisce { name, color } oppure null.
export function catDialog(cat = null) {
  return new Promise(res => {
    let color = cat ? cat.color : null, done = false;
    const name = h('input', { class: 'input', value: cat ? cat.name : '', placeholder: 'Es. Lezione, Esame, Palestra…', maxlength: '30', 'aria-label': 'Nome della categoria' });
    const sw = h('div', { class: 'swatches cat-colors' });
    const custom = h('input', { type: 'color', class: 'color-input', title: 'Colore personalizzato', 'aria-label': 'Colore personalizzato', value: color || '#5b5fc7' });
    const draw = () => sw.replaceChildren(
      h('button', {
        type: 'button', class: 'swatch lg cream' + (!color ? ' active' : ''), style: { background: 'var(--cream)' },
        title: 'Nessun colore (bianco panna)', 'aria-label': 'Nessun colore (bianco panna)', onclick: () => { color = null; draw(); },
      }),
      ...CAT_COLORS.map(c => h('button', {
        type: 'button', class: 'swatch lg' + (color === c ? ' active' : ''), style: { background: c }, title: c, 'aria-label': 'Colore ' + c,
        onclick: () => { color = c; draw(); },
      })),
      color && !CAT_COLORS.includes(color) ? h('button', { type: 'button', class: 'swatch lg active', style: { background: color }, title: color, 'aria-label': 'Colore ' + color }) : null);
    custom.addEventListener('change', () => { color = custom.value; draw(); });
    draw();
    const finish = close => {
      const n = name.value.trim();
      if (!n) { toast('Scrivi un nome per la categoria'); name.focus(); return; }
      done = true; res({ name: n, color: color || null }); close();
    };
    const m = modal({
      title: cat ? 'Modifica categoria' : 'Nuova categoria',
      body: h('div', { class: 'cat-form' },
        h('div', { class: 'field' }, h('label', {}, 'Nome'), name),
        h('div', { class: 'field' }, h('label', {}, 'Colore'),
          h('div', { class: 'row' }, sw, custom),
          h('p', { class: 'muted small' }, 'Se non scegli un colore, la categoria resta bianco panna.'))),
      actions: [{ label: 'Annulla' }, { label: cat ? 'Salva' : 'Crea', primary: true, onClick: finish }],
      onClose: () => { if (!done) res(null); },
    });
    name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); finish(m.close); } });
    autoFocus(name);
  });
}
