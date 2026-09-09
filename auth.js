// Authentication + authorisation.
//
// Identity comes from one of three places, all resolving to the same person record:
//   - a name and password, hashed with scrypt (never stored in the clear)
//   - a passkey (WebAuthn), which needs no password at all
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
  'users:manage': 'Manage people, passwords, devices and permissions',
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

export const PASSWORD_MIN = 10;

// Length is the only thing worth enforcing: composition rules push people towards
// predictable substitutions without adding real entropy.
export const validPassword = (p) =>
  typeof p === 'string' && p.length >= PASSWORD_MIN && p.length <= 200;

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

/* ---------- password hashing ---------- */

export async function hashPassword(password) {
  if (!validPassword(password)) {
    throw Object.assign(new Error(`password must be at least ${PASSWORD_MIN} characters`), { status: 400 });
  }
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 32);
  return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [kind, saltHex, keyHex] = String(stored ?? '').split(':');
  if (kind !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = await scrypt(String(password ?? ''), Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

/* ---------- store ---------- */

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
let dir = null;
let db = { users: [], sessions: {} };

const file = (n) => path.join(dir, n);
const save = () => fs.writeFile(file('auth.json'), JSON.stringify(db, null, 2));

export async function initAuth(dataDir, bootstrapPassword) {
  dir = dataDir;
  db = JSON.parse(await fs.readFile(file('auth.json'), 'utf8').catch(() => 'null')) || { users: [], sessions: {} };
  db.users ||= [];
  db.sessions ||= {};

  // Records written before the switch from 6-digit codes stored the hash under `codeHash`.
  // scrypt does not care what the input was, so the old credential keeps working.
  for (const u of db.users) {
    if (u.codeHash !== undefined) {
      u.passwordHash ??= u.codeHash;
      delete u.codeHash;
    }
    u.passkeys ||= [];
  }
  sweep();

  if (!db.users.length) {
    const password = validPassword(bootstrapPassword)
      ? bootstrapPassword
      : crypto.randomBytes(12).toString('base64url');
    await createUser({ name: 'Owner', role: 'admin', password });
    console.log(
      validPassword(bootstrapPassword)
        ? '[auth] first run: created admin "Owner" with the ACCESS_PASSWORD from .env'
        : `[auth] first run: created admin "Owner" with password ${password} — write it down, it is not stored in the clear`,
    );
  }
  await save();
}

function sweep() {
  const now = Date.now();
  for (const [sid, s] of Object.entries(db.sessions)) if (s.expiresAt < now) delete db.sessions[sid];
}

export const listUsers = () =>
  db.users.map(({ passwordHash, passkeys, ...u }) => ({
    ...u,
    caps: capsOf(u),
    hasPassword: !!passwordHash,
    passkeys: (passkeys || []).map(({ publicKey, ...p }) => p),
  }));

export const getUser = (id) => db.users.find((u) => u.id === id) || null;
export const userByName = (name) =>
  db.users.find((u) => u.name.toLowerCase() === String(name ?? '').trim().toLowerCase()) || null;

const adminCount = () => db.users.filter((u) => !u.disabled && capsOf(u).includes('users:manage')).length;
const canSignIn = (u) => !!u.passwordHash || u.macs.length > 0 || u.passkeys.length > 0;

export async function createUser({ name, role = 'guest', password, macs = [], permissions = null }) {
  const clean = cleanName(name);
  if (!clean) throw Object.assign(new Error('name must be 2-40 characters'), { status: 400 });
  if (userByName(clean)) throw Object.assign(new Error('someone already has that name'), { status: 400 });
  if (!ROLES[role]) throw Object.assign(new Error('unknown role'), { status: 400 });
  const user = {
    id: 'u_' + crypto.randomBytes(6).toString('hex'),
    name: clean,
    role,
    permissions: cleanPermissions(permissions),
    macs: macs.map(normalizeMac).filter(Boolean),
    passwordHash: password ? await hashPassword(password) : null,
    passkeys: [],
    disabled: false,
    createdAt: Date.now(),
    lastSeen: null,
  };
  if (!canSignIn(user)) {
    throw Object.assign(new Error('a person needs a password, a device MAC, or both'), { status: 400 });
  }
  db.users.push(user);
  await save();
  return user;
}

export async function updateUser(id, patch) {
  const user = getUser(id);
  if (!user) throw Object.assign(new Error('no such person'), { status: 404 });

  // Build the whole change on a copy and validate that, so a rejected edit leaves
  // nothing half-applied. Only the last lines touch the stored record.
  const next = { ...user };

  if (patch.name !== undefined) {
    const clean = cleanName(patch.name);
    if (!clean) throw Object.assign(new Error('name must be 2-40 characters'), { status: 400 });
    const clash = userByName(clean);
    if (clash && clash.id !== id) throw Object.assign(new Error('someone already has that name'), { status: 400 });
    next.name = clean;
  }
  if (patch.role !== undefined) {
    if (!ROLES[patch.role]) throw Object.assign(new Error('unknown role'), { status: 400 });
    next.role = patch.role;
  }
  if (patch.permissions !== undefined) next.permissions = cleanPermissions(patch.permissions);
  if (patch.macs !== undefined) next.macs = patch.macs.map(normalizeMac).filter(Boolean);
  if (patch.password) next.passwordHash = await hashPassword(patch.password);
  if (patch.clearPassword) next.passwordHash = null;
  if (patch.disabled !== undefined) next.disabled = !!patch.disabled;

  if (!canSignIn(next) && !next.disabled) {
    throw Object.assign(new Error('a person needs a password, a device MAC, or a passkey'), { status: 400 });
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

// The password is checked even when the name is unknown, so a wrong name and a wrong
// password take the same time and neither reveals which one was wrong.
const DUMMY_HASH = 'scrypt:' + '0'.repeat(32) + ':' + '0'.repeat(64);

export async function signIn(name, password) {
  const user = userByName(name);
  const ok = await verifyPassword(password, user?.passwordHash || DUMMY_HASH);
  if (!ok || !user || user.disabled || !user.passwordHash) return null;
  return user;
}

export const userByMac = (mac) =>
  mac ? db.users.find((u) => !u.disabled && u.macs.includes(mac)) || null : null;

/* ---------- passkeys ---------- */

export const passkeysOf = (userId) => (getUser(userId)?.passkeys || []);

export function userByPasskey(credentialId) {
  for (const user of db.users) {
    const passkey = (user.passkeys || []).find((p) => p.id === credentialId);
    if (passkey) return user.disabled ? null : { user, passkey };
  }
  return null;
}

export async function addPasskey(userId, { id, publicKey, counter, transports, label }) {
  const user = getUser(userId);
  if (!user) throw Object.assign(new Error('no such person'), { status: 404 });
  if (user.passkeys.some((p) => p.id === id)) {
    throw Object.assign(new Error('that passkey is already registered'), { status: 400 });
  }
  user.passkeys.push({
    id,
    publicKey, // base64url; the raw bytes are rebuilt on verification
    counter: counter ?? 0,
    transports: transports || [],
    label: cleanName(label) || 'Passkey',
    createdAt: Date.now(),
    lastUsed: null,
  });
  await save();
  return user.passkeys.at(-1);
}

export async function touchPasskey(credentialId, counter) {
  const found = userByPasskey(credentialId);
  if (!found) return;
  found.passkey.counter = counter;
  found.passkey.lastUsed = Date.now();
  found.user.lastSeen = Date.now();
  await save();
}

export async function removePasskey(userId, credentialId) {
  const user = getUser(userId);
  if (!user) throw Object.assign(new Error('no such person'), { status: 404 });

  // Decide on a copy, then commit — a rejected removal must leave the record untouched.
  const remaining = user.passkeys.filter((p) => p.id !== credentialId);
  if (remaining.length === user.passkeys.length) {
    throw Object.assign(new Error('no such passkey'), { status: 404 });
  }
  if (!canSignIn({ ...user, passkeys: remaining })) {
    throw Object.assign(new Error('that is the only way in — set a password first'), { status: 400 });
  }
  user.passkeys = remaining;
  await save();
}

/* ---------- sessions ---------- */

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

// Escalating lockout per IP. Passwords are stronger than the 6-digit codes this replaced,
// but throttling is still what makes guessing hopeless rather than merely slow.
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
