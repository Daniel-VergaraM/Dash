// Per-user notification feed + delivery bookkeeping, same persistence pattern as task-meta.js
// but written tmp+rename: the poller rewrites this file every minute, so a crash mid-write
// must never leave half a JSON document behind.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SENT_TTL_MS = 3 * 864e5;
const FEED_MAX = 50;
const DEFAULTS = { enabled: false, digestAt: '08:00', leadMin: 10 };

let dir = null;
let db = {}; // { [userId]: { settings, digestDate, sent: {key: isoTs}, feed: [{id,key,kind,title,body,at,read}] } }

const file = () => path.join(dir, 'notify.json');
// Writes are chained: they share one tmp name, so concurrent ones would race on the rename.
// A failed write rejects its own caller but never breaks the chain.
let chain = Promise.resolve();
function save() {
  const run = async () => {
    const tmp = `${file()}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(db, null, 2));
    await fs.rename(tmp, file());
  };
  const p = chain.then(run);
  chain = p.catch(() => {});
  return p;
}

export async function initNotify(dataDir) {
  dir = dataDir;
  const raw = await fs.readFile(file(), 'utf8').catch(() => null);
  try {
    db = (raw && JSON.parse(raw)) || {};
  } catch {
    // Corrupt file: keep it for inspection and start empty rather than refusing to boot.
    console.warn('[notify] notify.json is not valid JSON; moved to notify.json.bak, starting empty');
    await fs.rename(file(), `${file()}.bak`).catch(() => {});
    db = {};
  }
}

const rec = (uid) => (db[uid] ||= { settings: { ...DEFAULTS }, digestDate: null, sent: {}, feed: [] });

export const getSettings = (uid) => ({ ...DEFAULTS, ...db[uid]?.settings });
export async function setSettings(uid, s) {
  rec(uid).settings = { ...s };
  await save();
  return getSettings(uid);
}

export const feedOf = (uid) => (db[uid]?.feed || []).slice(0, FEED_MAX);
export const unreadOf = (uid) => (db[uid]?.feed || []).filter((n) => !n.read).length;
export const digestDateOf = (uid) => db[uid]?.digestDate || null;
export async function setDigestDate(uid, date) {
  rec(uid).digestDate = date;
  await save();
}

export const sentHas = (uid, key) => !!db[uid]?.sent[key];
export const sentAdd = (uid, key, at = new Date()) => { rec(uid).sent[key] = new Date(at).toISOString(); };
export function pruneSent(uid, now = new Date()) {
  const r = db[uid];
  if (!r) return;
  const cutoff = new Date(now).getTime() - SENT_TTL_MS;
  for (const [k, at] of Object.entries(r.sent)) if (Date.parse(at) < cutoff) delete r.sent[k];
}

// Idempotent on `key`: the key is recorded and persisted before this returns, so a restart
// right after a delivery cannot deliver it twice. Returns true when it was added.
export async function push(uid, item, now = new Date()) {
  const r = rec(uid);
  if (r.sent[item.key]) return false;
  r.feed.unshift({
    id: 'n_' + crypto.randomBytes(5).toString('hex'),
    key: item.key, kind: item.kind, title: item.title, body: item.body,
    at: item.at || new Date(now).toISOString(), read: false,
  });
  r.feed.length = Math.min(r.feed.length, FEED_MAX);
  sentAdd(uid, item.key, now);
  pruneSent(uid, now);
  await save();
  return true;
}

// No ids = everything. Returns the unread count left.
export async function markRead(uid, ids) {
  const r = db[uid];
  if (!r) return 0;
  const all = !Array.isArray(ids) || !ids.length;
  for (const n of r.feed) if (all || ids.includes(n.id)) n.read = true;
  await save();
  return r.feed.filter((n) => !n.read).length;
}
