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

// The calendar date Google Tasks should file a task under, in the user's own zone. A naive
// "YYYY-MM-DDTHH:mm" already is that zone's wall clock, so its date part is the answer; an
// absolute instant (Z / +HH:mm) is converted to the zone's date. Date-only passes through.
export function dueDate(start, tz) {
  const raw = String(start ?? '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) throw Object.assign(new Error('bad start time'), { status: 400 });
  const { start: iso } = taskWindow(raw, 30, tz);
  return /Z$|[+-]\d{2}:?\d{2}$/.test(raw) ? localNow(tz, new Date(iso)).date : raw.slice(0, 10);
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

/* ---------- notes: folders, tags, links ---------- */

const FOLDER_RE = /^[\w][\w .()'-]{0,60}$/;
const MAX_FOLDERS = 3;

// Trust boundary for nested notes: "folder/sub/name.md" becomes a path under the user's
// notes dir. Every segment must start with a word character, which already rules out "",
// "." and ".." as well as dotfiles.
export function notePath(raw) {
  const s = String(raw ?? '');
  const parts = s.split('/');
  const leaf = parts.pop();
  if (s.includes('\\') || parts.length > MAX_FOLDERS || !NOTE_RE.test(leaf) || !parts.every((p) => FOLDER_RE.test(p))) {
    throw Object.assign(new Error('bad note name'), { status: 400 });
  }
  return s;
}

const stripCode = (s) => s.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
const FRONT_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const TAG_RE = /(^|\s)#([A-Za-z][\w/-]{0,39})/gm;
// `\|` is the table-cell escape for `|`; the backslash is not part of the target and is kept
// (inside the alias group) when links are rewritten.
const LINK_RE = /\[\[([^[\]|#\\\n]+)((?:#[^[\]|\\\n]*)?)((?:\\?\|[^[\]\n]*)?)\]\]/g;

// Minimal frontmatter reader: only `tags:` is understood (inline list, comma list, or a
// "- a" block). ponytail: not YAML; quoted commas and nested structures are not handled.
function frontTags(front) {
  const out = [];
  const lines = front.split(/\r?\n/);
  const i = lines.findIndex((l) => /^tags\s*:/i.test(l));
  if (i < 0) return out;
  const rest = lines[i].replace(/^tags\s*:/i, '').trim().replace(/^\[|\]$/g, '');
  if (rest) out.push(...rest.split(','));
  else {
    for (const l of lines.slice(i + 1)) {
      const m = /^\s*-\s*(.+)$/.exec(l);
      if (!m) break;
      out.push(m[1]);
    }
  }
  return out.map((t) => t.trim().replace(/^["']|["']$/g, '').replace(/^#/, ''));
}

// Tags come from `#tag` in the prose (code and math removed first, so "# Title", "$x_#$" and
// "`#!/bin`" do not count) plus the frontmatter; links are every [[target]].
export function parseNote(body) {
  const text = String(body ?? '');
  const front = FRONT_RE.exec(text);
  const prose = stripCode(front ? text.slice(front[0].length) : text)
    .replace(/\$\$[\s\S]*?\$\$/g, ' ').replace(/\$[^$\n]*\$/g, ' ');
  const tags = new Set(front ? frontTags(front[1]) : []);
  for (const m of prose.matchAll(TAG_RE)) tags.add(m[2]);
  const links = new Set();
  for (const m of text.matchAll(LINK_RE)) links.add(m[1].trim().replace(/\.md$/i, ''));
  return {
    tags: [...new Set([...tags].map((t) => t.toLowerCase().slice(0, 40)).filter(Boolean))],
    links: [...links],
  };
}

const dirOf = (rel) => rel.slice(0, rel.lastIndexOf('/') + 1);
const baseOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/i, '');

// Builds a (target, fromRel) -> rel|null lookup once, so backlinks over many notes do not
// rescan the path list per link. Exact path (sans .md) wins; otherwise the first note whose
// basename matches case-insensitively, alphabetical, preferring the linking note's folder.
function resolver(paths) {
  const exact = new Map(paths.map((p) => [p.slice(0, -3).toLowerCase(), p]));
  const exactCase = new Set(paths.map((p) => p.slice(0, -3)));
  const byBase = new Map();
  for (const p of [...paths].sort()) {
    const b = baseOf(p).toLowerCase();
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(p);
  }
  return (target, from = '') => {
    const t = String(target).trim().replace(/\.md$/i, '');
    if (exactCase.has(t)) return `${t}.md`;
    if (t.includes('/')) return exact.get(t.toLowerCase()) ?? null;
    const c = byBase.get(t.toLowerCase());
    if (!c) return null;
    return c.find((p) => dirOf(p) === dirOf(from)) ?? c[0];
  };
}

export const resolveLink = (target, paths, from = '') => resolver(paths)(target, from);

// entries: [{rel, links}]. Computed on demand from the index, never persisted.
export function backlinksOf(entries, rel) {
  const resolve = resolver(entries.map((e) => e.rel));
  return entries
    .filter((e) => e.rel !== rel && e.links.some((l) => resolve(l, e.rel) === rel))
    .map((e) => e.rel);
}

// Rewrites the links in `body` that point at oldRel so they point at newRel. Alias and
// #section survive. A bare [[basename]] is left alone unless the basename itself changed
// (a pure folder move keeps it valid); a [[full/path]] link always follows the move.
// `allPaths` is the path list BEFORE the rename; `from` is the note that holds `body`.
export function rewriteLinks(body, oldRel, newRel, allPaths, from = '') {
  const resolve = resolver(allPaths);
  let n = 0;
  const out = String(body).replace(LINK_RE, (all, target, sec, alias) => {
    if (resolve(target, from) !== oldRel) return all;
    const t = target.trim();
    const next = t.includes('/') ? newRel.slice(0, -3) : baseOf(newRel);
    if (next === t.replace(/\.md$/i, '')) return all;
    n++;
    return `[[${next}${/\.md$/i.test(t) ? '.md' : ''}${sec}${alias}]]`;
  });
  return { body: out, n };
}

// entries: [{rel, mtimeMs, tags, body}] -> metadata rows, newest first (name hits, then
// body/tag hits when searching). `q` starting with "#" is a tag filter. Capped at 200.
export function filterNotes(entries, { q = '', tag = '', folder = '' } = {}, limit = 200) {
  let query = String(q).trim();
  let want = String(tag).trim().replace(/^#/, '').toLowerCase();
  if (query.startsWith('#')) { want = query.slice(1).toLowerCase(); query = ''; }
  const dir = String(folder).replace(/^\/+|\/+$/g, '');
  const rows = [];
  for (const e of entries) {
    if (dir && !e.rel.startsWith(`${dir}/`)) continue;
    if (want && !e.tags.some((t) => t === want || t.startsWith(`${want}/`))) continue;
    let rank = 0;
    let snip = null;
    if (query) {
      if (matches(e.rel, query)) snip = snippet(e.body, query);
      else if (matches(e.body, query)) { rank = 1; snip = snippet(e.body, query); }
      else if (e.tags.some((t) => matches(t, query))) rank = 2;
      else continue;
    }
    rows.push({
      rank,
      name: e.rel,
      folder: dirOf(e.rel).slice(0, -1),
      modified: e.mtimeMs,
      tags: e.tags,
      ...(snip ? { snippet: snip } : {}),
    });
  }
  rows.sort((a, b) => a.rank - b.rank || b.modified - a.modified);
  return rows.slice(0, limit).map(({ rank, ...r }) => r);
}

/* ---------- reminders + daily digest ---------- */

const pad2 = (n) => String(n).padStart(2, '0');

// Wall-clock date and minute-of-day for `now` in `tz` (process zone when unset).
export function localNow(tz, now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz || undefined, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute };
}

const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const hmToMin = (s) => { const m = HM_RE.exec(s); return m ? +m[1] * 60 + +m[2] : null; };

// Whatever the client sent, only these three fields in these ranges are ever stored.
export function cleanNotify(raw) {
  const n = Math.round(Number(raw?.leadMin));
  return {
    enabled: raw?.enabled === true,
    digestAt: typeof raw?.digestAt === 'string' && HM_RE.test(raw.digestAt) ? raw.digestAt : null,
    leadMin: Number.isFinite(n) && raw?.leadMin !== null && raw?.leadMin !== '' ? Math.min(Math.max(n, 5), 120) : 10,
  };
}

// Timed events and timed tasks starting within the next `leadMin` minutes that were not
// announced yet. Keyed by id + start, so moving an item re-announces it. Tasks without a
// time of day have no point-in-time reminder; they appear in the digest instead. `tz`
// places the naive "YYYY-MM-DDTHH:mm" task starts.
export function dueReminders({ events = [], tasks = [], now = new Date(), leadMin = 10, sent = {}, tz }) {
  const t0 = new Date(now).getTime();
  const out = [];
  for (const [kind, list] of [['ev', events], ['tk', tasks]]) {
    for (const x of list) {
      if (x.allDay || x.done || !x.start || (kind === 'ev' && x.task)) continue;
      let at;
      try { at = Date.parse(taskWindow(x.start, 5, tz).start); } catch { continue; }
      const d = at - t0;
      const key = `${kind}:${x.id}:${x.start}`;
      if (!(d > 0 && d <= leadMin * 60000) || sent[key]) continue;
      out.push({
        key, kind: 'reminder', title: x.title,
        body: `Starts in ${Math.max(1, Math.round(d / 60000))} min`,
        at: new Date(t0).toISOString(),
      });
    }
  }
  return out;
}

// True once per local day, inside [digestAt, digestAt + 6h). Outside that window the caller
// just records the day as done: a server that was down at 08:00 should not send the morning
// digest at 16:00.
export function digestDue({ settings, now = new Date(), tz, lastDigestDate }) {
  const at = hmToMin(settings?.digestAt);
  if (!settings?.enabled || at === null) return false;
  const l = localNow(tz, now);
  return l.date !== lastDigestDate && l.min >= at && l.min < at + 360;
}

// Agenda for today, then what is overdue / due today, then the rest of the top inbox.
export function digestItem({ events = [], inboxItems = [], tz, now = new Date() }) {
  const today = ymd(tz, now);
  const hm = (iso) => { const l = localNow(tz, new Date(iso)); return `${pad2(Math.floor(l.min / 60))}:${pad2(l.min % 60)}`; };
  const agenda = events
    .filter((e) => !e.task && !e.done && e.start && (e.allDay ? e.start.slice(0, 10) : localNow(tz, new Date(e.start)).date) === today)
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((e) => `${e.allDay ? 'All day' : hm(e.start)}  ${e.title}`);
  const dated = inboxItems.filter((i) => i.due);
  const overdue = dated.filter((i) => i.due.slice(0, 10) < today);
  const dueToday = dated.filter((i) => i.due.slice(0, 10) === today);
  const listed = new Set([...overdue, ...dueToday]);
  const rest = inboxItems.slice(0, 8).filter((i) => !listed.has(i));
  const sec = (h, a) => (a.length ? [h, ...a.map((s) => `- ${s}`)] : []);
  const lines = [
    ...sec('Today', agenda),
    ...sec('Overdue', overdue.map((i) => i.title)),
    ...sec('Due today', dueToday.map((i) => i.title)),
    ...sec('Inbox', rest.map((i) => i.title)),
  ];
  return {
    key: `digest:${today}`,
    kind: 'digest',
    title: `Your day, ${today}`,
    body: lines.join('\n') || 'Nothing scheduled today.',
  };
}

/* ---------- quick capture ---------- */

// Lowercase, accents stripped: "Mañana" -> "manana", so every keyword is matched once.
const plain = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const DAYS = new Map(Object.entries({
  domingo: 0, sunday: 0, sun: 0, lunes: 1, monday: 1, mon: 1, martes: 2, tuesday: 2, tue: 2,
  miercoles: 3, wednesday: 3, wed: 3, jueves: 4, thursday: 4, thu: 4, viernes: 5, friday: 5, fri: 5,
  sabado: 6, saturday: 6, sat: 6,
}));

const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const realDate = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

// "15h" / "9h": a whole number 9..23 followed by h reads as an hour of the day, not a duration.
// Durations stay "2h", "8h" or any decimal ("1.5h"); "horas"/"hours" are always durations.
const HOUR_H = /^(\d{1,2})h$/;
const isHourH = (k) => { const m = HOUR_H.exec(k); return !!m && +m[1] >= 9 && +m[1] <= 23; };

// Minutes since midnight for "3pm", "3:30pm", "15:00", "15h"; `bare` also allows a lone "15"
// (only after "a las"/"at", where the context makes it unambiguous). null when it is not a clock.
function clock(k, bare) {
  if (isHourH(k)) return parseInt(k, 10) * 60;
  const m = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(k);
  if (!m) return null;
  let h = +m[1];
  const mi = m[2] ? +m[2] : 0;
  if (mi > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3] === 'pm' ? 12 : 0);
  } else if (h > 23 || !(bare || m[2])) return null;
  return h * 60 + mi;
}

// Natural-language task line -> task fields. Tokens are recognised anywhere, in Spanish or
// English, ignoring case and accents; whatever is not a token becomes the title, and text in
// "quotes" is kept verbatim. `due` uses the same shapes POST /api/tasks takes as `start`.
// Only the first date / time / priority / project / duration counts; repeats stay in the title.
// ponytail: whole-word tokens only, so "1/2" in a title reads as a date; quote it to keep it.
// `projectsFailed`: the project list could not be loaded, so "!name" is reported as that.
export function parseQuick(text, { now = new Date(), tz, projects = [], projectsFailed = false } = {}) {
  // An unclosed quote is a literal token of its own: not a delimiter, not glued to the next word.
  const toks = [...String(text ?? '').matchAll(/"([^"]*)"|(")|[^\s"]+/g)].map((m) => (
    m[1] !== undefined ? { raw: m[1], lit: true } : m[2] ? { raw: '"', lit: true }
      : { raw: m[0], k: plain(m[0]).replace(/[,.;:]+$/, '') }));
  const at = (i) => (toks[i] && !toks[i].lit ? toks[i].k : '');
  const today = localNow(tz, now);
  const title = [];
  const warnings = [];
  let day = null, mins = null, priority = null, duration = null, projectTok = null;

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.lit) { if (t.raw.trim()) title.push(t.raw); continue; }
    const k = t.k;
    const nx = at(i + 1);
    let m;

    if (priority === null && (m = /^p([123])$/.exec(k))) { priority = ['high', 'med', 'low'][m[1] - 1]; continue; }
    if (projectTok === null && (m = /^!([\p{L}\p{N}][\p{L}\p{N}_-]*)$/u.exec(k))) { projectTok = m[1]; continue; }
    if (duration === null && !isHourH(k) && (m = /^(\d+(?:[.,]\d+)?)(m|min|mins|h|hr|hrs|hora|horas|hour|hours)$/.exec(k))) {
      const v = Math.round(parseFloat(m[1].replace(',', '.')) * (m[2][0] === 'h' ? 60 : 1));
      if (v >= 5 && v <= 1440) { duration = v; continue; }
    }

    if (mins === null) {
      let c = clock(k, false);
      if (c !== null) { mins = c; continue; }
      const prefix = (k === 'a' && (nx === 'las' || nx === 'la')) ? 2 : k === 'at' ? 1 : 0;
      if (prefix) {
        const kt = at(i + prefix);
        c = clock(kt, true);
        const sfx = at(i + prefix + 1);
        // "at 3 pm" / "a las 3 pm": the meridiem is its own word.
        if (c !== null && !/(am|pm)$/.test(kt) && (sfx === 'am' || sfx === 'pm')) {
          c = clock(kt + sfx, true);
          if (c !== null) { mins = c; i += prefix + 1; continue; }
        } else if (c !== null) { mins = c; i += prefix; continue; }
      }
    }

    if (day === null) {
      if (k === 'hoy' || k === 'today') { day = today.date; continue; }
      if (k === 'manana' || k === 'tomorrow') { day = addDays(today.date, 1); continue; }
      if (k === 'pasado' && nx === 'manana') { day = addDays(today.date, 2); i += 1; continue; }

      const lead = /^(este|proximo|next|this)$/.test(k) && DAYS.has(nx);
      const w = DAYS.get(lead ? nx : k);
      if (w !== undefined) {
        // Strictly future: on a Friday, "viernes" means next week's.
        const cur = new Date(`${today.date}T00:00:00Z`).getUTCDay();
        day = addDays(today.date, ((w - cur + 7) % 7) || 7);
        if (lead) i += 1;
        continue;
      }

      const unit = at(i + 2);
      if ((k === 'en' || k === 'in') && /^\d{1,3}$/.test(nx) && /^(dias?|days?|semanas?|weeks?)$/.test(unit)) {
        day = addDays(today.date, +nx * (/^(s|w)/.test(unit) ? 7 : 1));
        i += 2;
        continue;
      }

      if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k)) && realDate(+m[1], +m[2], +m[3])) { day = k; continue; }
      if ((m = /^(\d{1,2})[/-](\d{1,2})$/.exec(k))) {
        const [d, mo] = [+m[1], +m[2]];
        const pad = (n) => String(n).padStart(2, '0');
        // First occurrence from today on; 29/2 rolls to the next leap year (at most 8 years out).
        const y0 = +today.date.slice(0, 4);
        let found = null;
        for (let y = y0; y <= y0 + 8 && !found; y++) {
          const s = `${y}-${pad(mo)}-${pad(d)}`;
          if (realDate(y, mo, d) && s >= today.date) found = s;
        }
        if (found) { day = found; continue; }
        warnings.push(`Fecha no válida: "${t.raw}"`);
      }
    }

    title.push(t.raw);
  }

  // A time with no date means the next time that clock reads that: today unless it has passed.
  if (day === null && mins !== null) day = mins > today.min ? today.date : addDays(today.date, 1);
  const due = day === null ? null
    : mins === null ? day : `${day}T${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;

  let project = null;
  if (projectTok !== null) {
    const squash = (s) => plain(s).replace(/[\s_-]+/g, '');
    const q = squash(projectTok);
    const hits = projects.map((p) => ({ p, n: squash(p.name) })).filter((x) => x.n.startsWith(q))
      .sort((a, b) => (b.n === q) - (a.n === q) || a.n.length - b.n.length);
    if (projectsFailed) warnings.push('No se pudieron cargar los proyectos de Linear');
    else if (!hits.length) warnings.push(`No Linear project matches "!${projectTok}"`);
    else {
      project = { id: hits[0].p.id, name: hits[0].p.name };
      if (hits.length > 1 && hits[0].n !== q) warnings.push(`"!${projectTok}" matches ${hits.length} projects; using "${project.name}"`);
    }
  }

  const out = title.join(' ').replace(/\s+/g, ' ').trim();
  if (!out) warnings.push('Title is empty');
  return { title: out, due, hasTime: due !== null && mins !== null, priority, project, duration, warnings };
}
