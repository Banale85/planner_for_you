// Piccole utility condivise

export const uid = () =>
  (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

export const pad = n => String(n).padStart(2, '0');
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Date: lavoriamo sempre in ora locale con stringhe "YYYY-MM-DDTHH:mm"
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const toLocalISO = d => `${ymd(d)}T${hm(d)}`;
export function parseLocal(s) {
  if (!s) return new Date(NaN);
  const [date, time = '00:00'] = s.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0);
}
export const addDays = (d, n) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
export const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
// Settimana che inizia di lunedì
export const startOfWeek = d => { const s = startOfDay(d); return addDays(s, -((s.getDay() + 6) % 7)); };
export const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

const L = 'it-IT';
export const fmt = {
  monthYear: d => d.toLocaleDateString(L, { month: 'long', year: 'numeric' }),
  dayMonth: d => d.toLocaleDateString(L, { day: 'numeric', month: 'long' }),
  dayMonthShort: d => d.toLocaleDateString(L, { day: 'numeric', month: 'short' }),
  full: d => d.toLocaleDateString(L, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
  wdShort: d => d.toLocaleDateString(L, { weekday: 'short' }),
  wdLong: d => d.toLocaleDateString(L, { weekday: 'long' }),
  date: d => d.toLocaleDateString(L, { day: 'numeric', month: 'short', year: 'numeric' }),
  rel(ts) {
    const d = new Date(ts), now = new Date();
    if (sameDay(d, now)) return 'Oggi, ' + hm(d);
    if (sameDay(d, addDays(startOfDay(now), -1))) return 'Ieri, ' + hm(d);
    return fmt.date(d);
  },
};

export function debounce(fn, ms) {
  let t = null, args;
  const f = (...a) => { args = a; clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, ms); };
  f.flush = () => { if (t) { clearTimeout(t); t = null; fn(...args); } };
  return f;
}

const scripts = {};
export function loadScript(src) {
  if (!scripts[src]) {
    scripts[src] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = () => { delete scripts[src]; rej(new Error('Impossibile caricare una libreria: controlla la connessione.')); };
      document.head.append(s);
    });
  }
  return scripts[src];
}

export function pickFile(accept, multiple = false) {
  return new Promise(res => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = accept; i.multiple = multiple;
    i.style.display = 'none';
    i.addEventListener('change', () => { res([...i.files]); i.remove(); });
    i.addEventListener('cancel', () => { res([]); i.remove(); });
    document.body.append(i);
    i.click();
  });
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

export const safeName = s => (s || 'file').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);

export const blobToDataURL = b => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b);
});
export const dataURLToBlob = async u => (await fetch(u)).blob();
