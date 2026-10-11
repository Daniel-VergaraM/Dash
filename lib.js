// Pure helpers, kept out of server.js so test.mjs can import them without booting the server.
import { allows } from './auth.js';

const NOTE_RE = /^[\w][\w .()'-]{0,80}\.md$/;

export function noteName(raw) {
  // Trust boundary: this string becomes a filesystem path.
  const base = String(raw ?? '').split(/[\\/]/).pop();
  if (!NOTE_RE.test(base)) {
    throw Object.assign(new Error('bad note name'), { status: 400 });
  }
  return base;
}

// `arp -a` output differs per OS; find the line for this IP and pull the MAC off it.
export function macFromArp(stdout, ip) {
  const line = stdout
    .split(/\r?\n/)
    .find((l) => l.split(/[\s()]+/).includes(ip));
  const mac = line?.match(/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i)?.[0];
  return mac ? mac.toLowerCase().replace(/-/g, ':') : null;
}

// Converts a UTC-guess Date to the true UTC instant for the same wall-clock reading in `tz`.
// Node has no built-in "parse wall-clock time in an arbitrary IANA zone" primitive; the common
// `toLocaleString` + `new Date(...)` double-conversion trick silently depends on the running
// process's own timezone (a locale string with no explicit zone parses as local time), so it
// only works by accident when the server happens to run with TZ=UTC. This reads the offset
// straight from Intl instead, so it's correct under any process TZ. ponytail: inaccurate only
// within the ~1hr/year DST transition (a repeated or skipped wall-clock hour) — fine for a
// personal scheduling app.
function zonedToUtc(utcGuess, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(utcGuess).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return new Date(utcGuess.getTime() - (asUtc - utcGuess.getTime()));
}

// Midnight, as a UTC instant, on today's date in `tz`. Falls back to the process's own
// timezone (today's exact prior behavior) when no `tz` is given, so this stays a no-op for
// anyone who hasn't configured one yet.
export function startOfDay(tz, now = new Date()) {
  if (!tz) { const d = new Date(now); d.setHours(0, 0, 0, 0); return d; }
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return zonedToUtc(new Date(`${ymd}T00:00:00Z`), tz);
}

// A task is a calendar event; this is the only date maths in the app. `start` is usually a
// naive "YYYY-MM-DDTHH:mm" straight from a <input type="datetime-local">, with no timezone
// of its own — without `tz`, Date() interprets that in whatever zone this process runs in,
// which is the historical behavior and stays exactly as-is when no per-user zone is set. An
// already-absolute string (trailing Z or +HH:mm) is never ambiguous and is used as-is either way.
export function taskWindow(start, minutes, tz) {
  const raw = String(start ?? '');
  const hasOffset = /Z$|[+-]\d{2}:?\d{2}$/.test(raw);
  const s = (!tz || hasOffset)
    ? new Date(raw)
    : zonedToUtc(new Date(/:\d{2}(\.\d+)?$/.test(raw) ? raw + 'Z' : raw + ':00Z'), tz);
  if (Number.isNaN(s.getTime())) throw Object.assign(new Error('bad start time'), { status: 400 });
  const mins = Math.min(Math.max(Number(minutes) || 30, 5), 60 * 24);
  return { start: s.toISOString(), end: new Date(s.getTime() + mins * 60000).toISOString() };
}

/* ---------- command palette search ---------- */

// Which sources a person may search; each maps to the capability that already guards its page.
export function searchSources(user) {
  const need = { tasks: ['tasks:read', 'tasks:write'], notes: ['notes:read'], drive: ['drive:read'], github: ['github:read'] };
  return Object.keys(need).filter((s) => allows(user, ...need[s]));
}

// Same allow-list the Drive page uses; this string is spliced into a Drive query, so quotes
// and backslashes must never survive.
export const driveTerm = (q) => String(q ?? '').trim().split(/[^ 0-9a-zA-Z._-]/).join('');

export const matches = (text, q) => String(text ?? '').toLowerCase().includes(String(q).toLowerCase());

// +-40 chars around the first hit, whitespace collapsed; null when there is no hit.
export function snippet(text, q) {
  const s = String(text ?? '');
  const i = s.toLowerCase().indexOf(String(q).toLowerCase());
  if (i < 0) return null;
  return s.slice(Math.max(0, i - 40), i + String(q).length + 40).replace(/\s+/g, ' ').trim();
}

/* ---------- inbox ---------- */

// Linear: 0 none, 1 urgent, 2 high, 3 medium, 4 low. Dash only has high/med/low.
const LINEAR_PRIO = { high: 2, med: 3, low: 4 };
export const prioToLinear = (p) => LINEAR_PRIO[p] ?? 0;
export const prioFromLinear = (n) => ({ 1: 'high', 2: 'high', 3: 'med', 4: 'low' })[n] ?? null;

// Which fields of a task PATCH go to the linked Linear issue (task -> issue only), or null
// when nothing syncs. `gBody` is the already-built Google patch, whose `due` is the date.
export function issuePatch(body, gBody, meta) {
  if (!meta?.linearId || !(body?.title || body?.start || body?.priority !== undefined)) return null;
  return {
    title: gBody.title,
    dueDate: gBody.due?.slice(0, 10),
    priority: body.priority !== undefined ? prioToLinear(body.priority) : undefined,
  };
}

// An existing issue to mirror, as sent by the client; this goes into task meta and later
// into Linear mutations, so only the shapes Linear actually produces are accepted.
export function linearLink(x) {
  if (!x || typeof x !== 'object') return null;
  const { id, url, key } = x;
  if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) return null;
  if (typeof url !== 'string' || !/^https:\/\/linear\.app\/\S{1,500}$/.test(url)) return null;
  if (typeof key !== 'string' || !/^[A-Za-z0-9]{1,16}-\d{1,9}$/.test(key)) return null;
  return { linearId: id, linearUrl: url, linearKey: key };
}

// YYYY-MM-DD for `now` in `tz` (process zone when unset).
export const ymd = (tz, now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

// Higher = look at it sooner. `today` is YYYY-MM-DD; item is {due, priority, review}.
export function inboxScore({ due, priority, review }, today) {
  let n = { high: 40, med: 20, low: 5 }[priority] || 0;
  if (review) n += 50;
  if (due) {
    const days = Math.round((Date.parse(due.slice(0, 10)) - Date.parse(today)) / 864e5);
    if (days < 0) n += 100;
    else if (days === 0) n += 60;
    else if (days <= 3) n += 30;
  }
  return n;
}

export const inboxOrder = (a, b) =>
  b.score - a.score || (a.due || '9999').localeCompare(b.due || '9999') || a.title.localeCompare(b.title);
