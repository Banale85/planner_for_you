// Archivio locale (IndexedDB): tutto resta sul dispositivo, funziona anche offline.
// Ogni modifica viene segnalata al modulo di sincronizzazione (Google Drive).

const DB_NAME = 'planner-for-you';
const VERSION = 1;
export const KEYS = { folders: 'id', notebooks: 'id', pages: 'id', events: 'id', files: 'id', calink: 'key', meta: 'key' };
export const STORES = Object.keys(KEYS);
// Archivi che vengono sincronizzati con Google Drive
export const SYNCED = new Set(['folders', 'notebooks', 'pages', 'events', 'files', 'calink']);

let hook = null;
export const setWriteHook = f => { hook = f; };
const silent = o => !!(o && o.silent);
const stamp = (s, v, o) => { if (SYNCED.has(s) && !silent(o)) v._rev = Date.now(); };
const notify = (s, keys, deleted, o) => { if (hook && SYNCED.has(s) && !silent(o) && keys.length) hook(s, keys, deleted); };

let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const [name, keyPath] of Object.entries(KEYS)) {
        if (!d.objectStoreNames.contains(name)) {
          const os = d.createObjectStore(name, { keyPath });
          if (name === 'pages') os.createIndex('notebookId', 'notebookId');
        }
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

const wrap = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const done = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
async function store(name, mode = 'readonly') { return (await open()).transaction(name, mode).objectStore(name); }

// Opzione { silent: true }: scrittura che arriva dalla sincronizzazione (non va rimandata al cloud)
export const db = {
  async get(s, key) { if (key == null) return undefined; return wrap((await store(s)).get(key)); },
  async all(s) { return wrap((await store(s)).getAll()); },
  async keys(s) { return wrap((await store(s)).getAllKeys()); },
  async byIndex(s, idx, val) { return wrap((await store(s)).index(idx).getAll(val)); },
  async put(s, v, o) {
    stamp(s, v, o);
    const os = await store(s, 'readwrite'); os.put(v); await done(os.transaction);
    notify(s, [v[KEYS[s]]], false, o);
  },
  async putMany(s, arr, o) {
    if (!arr.length) return;
    for (const v of arr) stamp(s, v, o);
    const os = await store(s, 'readwrite'); for (const v of arr) os.put(v); await done(os.transaction);
    notify(s, arr.map(v => v[KEYS[s]]), false, o);
  },
  async del(s, key, o) {
    const os = await store(s, 'readwrite'); os.delete(key); await done(os.transaction);
    notify(s, [key], true, o);
  },
  async delMany(s, keys, o) {
    if (!keys.length) return;
    const os = await store(s, 'readwrite'); for (const k of keys) os.delete(k); await done(os.transaction);
    notify(s, keys, true, o);
  },
  async clear(s) { const os = await store(s, 'readwrite'); os.clear(); return done(os.transaction); },
};
