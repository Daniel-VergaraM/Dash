// Authentication + authorisation.
//
// Identity comes from one of two places, both resolving to the same person record:
//   - a 6-digit code, hashed with scrypt (never stored in the clear)
//   - a MAC address seen on the local network segment via `arp -a`
//
// Authorisation is a flat capability list. A person's capabilities are either their
// role's defaults or an explicit per-person override.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

/* ---------- capabilities ---------- */

export const CAPABILITIES = {
  'tasks:read': 'See scheduled tasks',
  'tasks:write': 'Create, complete and delete tasks',
  'calendar:read': 'See the calendar agenda',
  'notes:read': 'Read notes',
  'notes:write': 'Create, edit and delete notes',
  'drive:read': 'Browse and preview Drive files',
  'music:read': 'See what is playing',
  'music:control': 'Control playback',
  'github:read': 'See repositories and activity',
  'connections:manage': 'Connect and disconnect Google / Spotify',
  'users:manage': 'Manage people, codes, devices and permissions',
};

const ALL = Object.keys(CAPABILITIES);

export const ROLES = {
  admin: ALL,
  member: ALL.filter((c) => c !== 'users:manage'),
  guest: ['tasks:read', 'calendar:read', 'notes:read', 'music:read', 'github:read'],
};

// An explicit permissions array overrides the role; otherwise the role's defaults apply.
export function capsOf(user) {
  if (!user || user.disabled) return [];
  const caps = Array.isArray(user.permissions) ? user.permissions : ROLES[user.role];
  return (caps || []).filter((c) => c in CAPABILITIES);
}

export const allows = (user, ...anyOf) => {
  const caps = capsOf(user);
  return anyOf.some((c) => caps.includes(c));
};

/* ---------- validation (trust boundary: all of this is user input) ---------- */

export const validCode = (c) => /^[0-9]{6}$/.test(String(c ?? ''));

export function normalizeMac(raw) {
  const hex = String(raw ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(':');
}

export function cleanName(raw) {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
  return name.length >= 2 ? name : null;
}

export function cleanPermissions(raw) {
  if (raw === null || raw === undefined) return null; // null = inherit from role
  if (!Array.isArray(raw)) return null;
  return [...new Set(raw.filter((c) => c in CAPABILITIES))];
}

/* ---------- code hashing ---------- */

export async function hashCode(code) {
  if (!validCode(code)) throw Object.assign(new Error('code must be exactly 6 digits'), { status: 400 });
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(code), salt, 32);
  return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function verifyCode(code, stored) {
  const [kind, saltHex, keyHex] = String(stored ?? '').split(':');
  if (kind !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = await scrypt(String(code), Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

/* ---------- store ---------- */

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
let dir = null;
let db = { users: [], sessions: {} };

const file = (n) => path.join(dir, n);
const save = () => fs.writeFile(file('auth.json'), JSON.stringify(db, null, 2));

export async function initAuth(dataDir, bootstrapCode) {
  dir = dataDir;
  db = JSON.parse(await fs.readFile(file('auth.json'), 'utf8').catch(() => 'null')) || { users: [], sessions: {} };
  db.users ||= [];
  db.sessions ||= {};
  sweep();

  if (!db.users.length) {
    const code = validCode(bootstrapCode) ? String(bootstrapCode) : String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    await createUser({ name: 'Owner', role: 'admin', code });
    console.log(
      validCode(bootstrapCode)
        ? '[auth] first run: created admin "Owner" with the ACCESS_CODE from .env'
        : `[auth] first run: created admin "Owner" with code ${code} — write it down, it is not stored in the clear`,
    );
  }
  await save();
}

function sweep() {
  const now = Date.now();
  for (const [sid, s] of Object.entries(db.sessions)) if (s.expiresAt < now) delete db.sessions[sid];
}

export const listUsers = () =>
  db.users.map(({ codeHash, ...u }) => ({ ...u, caps: capsOf(u), hasCode: !!codeHash }));

export const getUser = (id) => db.users.find((u) => u.id === id) || null;
const adminCount = () => db.users.filter((u) => !u.disabled && capsOf(u).includes('users:manage')).length;

export async function createUser({ name, role = 'guest', code, macs = [], permissions = null }) {
  const clean = cleanName(name);
  if (!clean) throw Object.assign(new Error('name must be 2-40 characters'), { status: 400 });
  if (!ROLES[role]) throw Object.assign(new Error('unknown role'), { status: 400 });
  const user = {
    id: 'u_' + crypto.randomBytes(6).toString('hex'),
    name: clean,
    role,
    permissions: cleanPermissions(permissions),
    macs: macs.map(normalizeMac).filter(Boolean),
    codeHash: code ? await hashCode(code) : null,
    disabled: false,
    createdAt: Date.now(),
    lastSeen: null,
  };
  if (!user.codeHash && !user.macs.length) {
    throw Object.assign(new Error('a person needs a code, a device MAC, or both'), { status: 400 });
  }
  db.users.push(user);
  await save();
  return user;
}

export async function updateUser(id, patch) {
  const user = getUser(id);
  if (!user) throw Object.assign(new Error('no such person'), { status: 404 });

  // Build the whole change on a copy and validate that, so a rejected edit leaves
  // nothing half-applied. Only the last two lines touch the stored record.
  const next = { ...user };

  if (patch.name !== undefined) {
    const clean = cleanName(patch.name);
    if (!clean) throw Object.assign(new Error('name must be 2-40 characters'), { status: 400 });
    next.name = clean;
  }
  if (patch.role !== undefined) {
    if (!ROLES[patch.role]) throw Object.assign(new Error('unknown role'), { status: 400 });
    next.role = patch.role;
  }
  if (patch.permissions !== undefined) next.permissions = cleanPermissions(patch.permissions);
  if (patch.macs !== undefined) next.macs = patch.macs.map(normalizeMac).filter(Boolean);
  if (patch.code) next.codeHash = await hashCode(patch.code);
  if (patch.clearCode) next.codeHash = null;
  if (patch.disabled !== undefined) next.disabled = !!patch.disabled;

  if (!next.codeHash && !next.macs.length && !next.disabled) {
    throw Object.assign(new Error('a person needs a code, a device MAC, or both'), { status: 400 });
  }
  // Never let the last way into the admin panel be removed.
  const admins = db.users.filter((u) => u.id !== id && !u.disabled && capsOf(u).includes('users:manage')).length
    + (capsOf(next).includes('users:manage') ? 1 : 0);
  if (!admins) throw Object.assign(new Error('that would leave nobody able to manage access'), { status: 400 });

  Object.assign(user, next);
  if (user.disabled) dropSessionsFor(user.id);
  await save();
  return user;
}

export async function deleteUser(id) {
  const i = db.users.findIndex((u) => u.id === id);
  if (i < 0) throw Object.assign(new Error('no such person'), { status: 404 });
  const [gone] = db.users.splice(i, 1);
  if (!adminCount()) {
    db.users.splice(i, 0, gone);
    throw Object.assign(new Error('that would leave nobody able to manage access'), { status: 400 });
  }
  dropSessionsFor(id);
  await save();
}

/* ---------- sign-in ---------- */

// ponytail: scrypt runs once per person, so sign-in cost is O(people). Fine below ~50;
// prefix the code with a person id if this ever hosts a crowd.
export async function userByCode(code) {
  if (!validCode(code)) return null;
  for (const u of db.users) {
    if (u.codeHash && !u.disabled && (await verifyCode(code, u.codeHash))) return u;
  }
  return null;
}

export const userByMac = (mac) =>
  mac ? db.users.find((u) => !u.disabled && u.macs.includes(mac)) || null : null;

export async function startSession(user, via, ip) {
  sweep();
  const sid = crypto.randomBytes(24).toString('hex');
  db.sessions[sid] = { userId: user.id, via, ip, createdAt: Date.now(), expiresAt: Date.now() + SESSION_MS };
  user.lastSeen = Date.now();
  await save();
  return sid;
}

export function sessionUser(sid) {
  const s = sid && db.sessions[sid];
  if (!s) return null;
  if (s.expiresAt < Date.now()) { delete db.sessions[sid]; return null; }
  const user = getUser(s.userId);
  if (!user || user.disabled) return null;
  return { user, session: s };
}

export async function endSession(sid) {
  if (sid && db.sessions[sid]) { delete db.sessions[sid]; await save(); }
}

function dropSessionsFor(userId) {
  for (const [sid, s] of Object.entries(db.sessions)) if (s.userId === userId) delete db.sessions[sid];
}

export const sessionsOf = (userId) =>
  Object.entries(db.sessions)
    .filter(([, s]) => s.userId === userId)
    .map(([sid, s]) => ({ sid: sid.slice(0, 8), via: s.via, ip: s.ip, createdAt: s.createdAt }));

/* ---------- audit ---------- */

export async function audit(event, detail = {}) {
  const line = JSON.stringify({ at: Date.now(), event, ...detail }) + '\n';
  await fs.appendFile(file('audit.log'), line).catch(() => {});
}

export async function readAudit(limit = 100) {
  const raw = await fs.readFile(file('audit.log'), 'utf8').catch(() => '');
  return raw
    .split('\n')
    .filter(Boolean)
    .slice(-limit)
    .reverse()
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/* ---------- rate limiting ---------- */

// Escalating lockout per IP: a 6-digit code is only 10^6 wide, so throttling is the real defence.
const strikes = new Map();

export function lockedFor(ip) {
  const s = strikes.get(ip);
  return s && Date.now() < s.until ? Math.ceil((s.until - Date.now()) / 1000) : 0;
}

export function recordFailure(ip) {
  const s = strikes.get(ip) || { n: 0, until: 0 };
  s.n += 1;
  if (s.n >= 5) s.until = Date.now() + Math.min(2 ** (s.n - 5), 60) * 60_000;
  strikes.set(ip, s);
}

export const clearFailures = (ip) => strikes.delete(ip);
