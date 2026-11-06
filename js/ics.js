// Import / export di calendari .ics (Teams, Outlook, Google Calendar…)

import { uid, pad, ymd, toLocalISO, parseLocal, addDays } from './util.js';

const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

const unfold = t => t.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
const unesc = v => v.replace(/\\([\\;,nN])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));
const esc = v => String(v).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

function splitLine(line) {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ':' && !q) {
      const parts = line.slice(0, i).split(';');
      const name = parts.shift().toUpperCase();
      const params = {};
      for (const p of parts) { const j = p.indexOf('='); if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, ''); }
      return { name, params, value: line.slice(i + 1) };
    }
  }
  return null;
}

function parseDt(value) {
  const v = value.trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return { date: new Date(+m[1], m[2] - 1, +m[3]), allDay: true };
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const [, Y, M, D, hh, mm, ss = '0', z] = m;
  return { date: z ? new Date(Date.UTC(+Y, M - 1, +D, +hh, +mm, +ss)) : new Date(+Y, M - 1, +D, +hh, +mm, +ss), allDay: false };
}

function durMinutes(v) {
  const m = v.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const mins = (+m[2] || 0) * 10080 + (+m[3] || 0) * 1440 + (+m[4] || 0) * 60 + (+m[5] || 0) + Math.round((+m[6] || 0) / 60);
  return m[1] === '-' ? -mins : mins;
}

function parseRRule(v) {
  const o = {};
  for (const part of v.split(';')) { const [k, val] = part.split('='); if (k) o[k.toUpperCase()] = val; }
  const freq = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' }[o.FREQ];
  if (!freq) return null;
  const r = { freq, interval: Number(o.INTERVAL) || 1, until: null };
  if (o.UNTIL) { const d = parseDt(o.UNTIL); if (d) r.until = ymd(d.date); }
  if (o.COUNT) r.count = Number(o.COUNT);
  if (o.BYDAY && freq === 'weekly') r.byDay = o.BYDAY.split(',').map(x => WD.indexOf(x.replace(/^[+-]?\d+/, ''))).filter(x => x >= 0);
  return r;
}

export function parseICS(text) {
  const raw = [];
  let cur = null, inAlarm = false;
  for (const l of unfold(text).split('\n')) {
    const line = l.trimEnd();
    if (!line) continue;
    if (line === 'BEGIN:VEVENT') { cur = { attendees: [], exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur) raw.push(cur); cur = null; continue; }
    if (!cur) continue;
    if (line === 'BEGIN:VALARM') { inAlarm = true; continue; }
    if (line === 'END:VALARM') { inAlarm = false; continue; }
    const p = splitLine(line);
    if (!p) continue;
    if (inAlarm) { if (p.name === 'TRIGGER') { const m = durMinutes(p.value); if (m != null) cur.reminder = Math.abs(m); } continue; }
    switch (p.name) {
      case 'UID': cur.uid = p.value; break;
      case 'SUMMARY': cur.title = unesc(p.value); break;
      case 'DESCRIPTION': cur.description = unesc(p.value); break;
      case 'LOCATION': cur.location = unesc(p.value); break;
      case 'DTSTART': cur.dtstart = parseDt(p.value); break;
      case 'DTEND': cur.dtend = parseDt(p.value); break;
      case 'DURATION': cur.duration = durMinutes(p.value); break;
      case 'RRULE': cur.rrule = parseRRule(p.value); break;
      case 'EXDATE': for (const v of p.value.split(',')) { const d = parseDt(v); if (d) cur.exdates.push(ymd(d.date)); } break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseDt(p.value); break;
      case 'ATTENDEE': { const mail = p.value.replace(/^mailto:/i, ''); cur.attendees.push(mail.includes('@') ? mail : (p.params.CN || mail)); break; }
      case 'X-MICROSOFT-SKYPETEAMSMEETINGURL': cur.meetingUrl = p.value; break;
      case 'TRANSP': if (p.value === 'TRANSPARENT') cur.showAs = 'free'; break;
      case 'X-MICROSOFT-CDO-BUSYSTATUS': cur.showAs = { FREE: 'free', TENTATIVE: 'tentative', OOF: 'oof', BUSY: 'busy' }[p.value] || cur.showAs; break;
      case 'STATUS': if (p.value === 'CANCELLED') cur.cancelled = true; break;
    }
  }

  const events = [];
  for (const c of raw) {
    if (!c.dtstart) continue;
    const allDay = c.dtstart.allDay, s = c.dtstart.date;
    let e = c.dtend ? c.dtend.date : (c.duration != null ? new Date(s.getTime() + c.duration * 60000) : (allDay ? addDays(s, 1) : new Date(s.getTime() + 30 * 60000)));
    if (!(e > s)) e = allDay ? addDays(s, 1) : new Date(s.getTime() + 30 * 60000);
    const desc = c.description || '';
    const meet = c.meetingUrl
      || (desc.match(/https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s<>"]+/) || [])[0]
      || (desc.match(/https:\/\/[\w.-]*(?:zoom\.us|meet\.google\.com|webex\.com)\/[^\s<>"]*/) || [])[0] || '';
    const ev = {
      id: uid(), uid: c.uid || uid(), title: c.title || '(Senza titolo)',
      start: toLocalISO(s), end: toLocalISO(e), allDay,
      location: c.location || '', attendees: c.attendees.join(', '), meetingUrl: meet,
      notes: desc.replace(/_{8,}/g, '').replace(/\n{3,}/g, '\n\n').trim(),
      category: null, showAs: c.showAs || 'busy',
      reminder: c.reminder != null ? c.reminder : 15,
      rrule: c.rrule || null, exdates: c.exdates,
      ink: { strokes: [], texts: [], images: [] }, imported: true, createdAt: Date.now(),
    };
    if (c.recurrenceId) {
      ev._rid = ymd(c.recurrenceId.date); ev._master = c.uid; ev.uid = (c.uid || '') + '#' + ev._rid; ev.rrule = null;
      if (c.cancelled) ev._skip = true;
    } else if (c.cancelled) continue;
    events.push(ev);
  }
  // Le occorrenze modificate sostituiscono quella originale della serie
  for (const ev of events) {
    if (!ev._master) continue;
    const m = events.find(x => x.uid === ev._master && !x._master);
    if (m && !m.exdates.includes(ev._rid)) m.exdates.push(ev._rid);
  }
  return events.filter(e => !e._skip).map(e => { delete e._master; delete e._rid; delete e._skip; return e; });
}

const fmtDT = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
const fmtD = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
function fold(line) {
  const out = [];
  while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74); }
  out.push(line);
  return out.join('\r\n');
}

export function toICS(events) {
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Planner for You//IT', 'CALSCALE:GREGORIAN'];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  for (const ev of events) {
    const s = parseLocal(ev.start), e = parseLocal(ev.end);
    L.push('BEGIN:VEVENT', 'UID:' + (ev.uid || ev.id), 'DTSTAMP:' + stamp);
    if (ev.allDay) L.push('DTSTART;VALUE=DATE:' + fmtD(s), 'DTEND;VALUE=DATE:' + fmtD(e));
    else L.push('DTSTART:' + fmtDT(s), 'DTEND:' + fmtDT(e));
    L.push('SUMMARY:' + esc(ev.title || ''));
    if (ev.location) L.push('LOCATION:' + esc(ev.location));
    const desc = [ev.notes, ev.meetingUrl && 'Riunione online: ' + ev.meetingUrl].filter(Boolean).join('\n\n');
    if (desc) L.push('DESCRIPTION:' + esc(desc));
    if (ev.meetingUrl) L.push('URL:' + ev.meetingUrl);
    if (ev.showAs === 'free') L.push('TRANSP:TRANSPARENT');
    if (ev.rrule) {
      const r = ev.rrule;
      let rule;
      if (r.freq === 'weekdays') rule = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
      else {
        rule = 'FREQ=' + r.freq.toUpperCase();
        if (r.interval > 1) rule += ';INTERVAL=' + r.interval;
        if (r.byDay && r.byDay.length) rule += ';BYDAY=' + r.byDay.map(i => WD[i]).join(',');
      }
      if (r.until) rule += ';UNTIL=' + r.until.replace(/-/g, '') + (ev.allDay ? '' : 'T235959');
      else if (r.count) rule += ';COUNT=' + r.count;
      L.push('RRULE:' + rule);
      for (const x of ev.exdates || []) {
        L.push(ev.allDay ? 'EXDATE;VALUE=DATE:' + x.replace(/-/g, '') : 'EXDATE:' + x.replace(/-/g, '') + 'T' + pad(s.getHours()) + pad(s.getMinutes()) + '00');
      }
    }
    for (const a of (ev.attendees || '').split(',').map(x => x.trim()).filter(x => x.includes('@'))) L.push('ATTENDEE:mailto:' + a);
    if (ev.reminder != null) L.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Promemoria', 'TRIGGER:-PT' + ev.reminder + 'M', 'END:VALARM');
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n');
}
