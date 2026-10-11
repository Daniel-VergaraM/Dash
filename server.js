import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import {
  notePath, parseNote, backlinksOf, rewriteLinks, filterNotes,
  macFromArp, taskWindow, dueDate, startOfDay, searchSources, driveTerm, matches,
  prioFromLinear, linearLink, issuePatch, ymd, inboxScore, inboxOrder,
  localNow, hmToMin, cleanNotify, dueReminders, digestDue, digestItem, parseQuick,
  IMG_MAX_BYTES, IMG_MIME, ASSET_NAME, sniffImage, badDims, stripJpegMeta,
} from './lib.js';
import {
  CAPABILITIES, ROLES, PASSWORD_MIN, initAuth, capsOf, allows, listUsers, getUser, createUser,
  updateUser, deleteUser, signIn, userByMac, startSession, sessionUser, endSession, sessionsOf,
  audit, readAudit, lockedFor, recordFailure, clearFailures,
  addPasskey, removePasskey, passkeysOf, userByPasskey, touchPasskey,
} from './auth.js';
import { initTaskMeta, subtasksOf, setSubtasks, metaOf, setMeta, deleteMeta } from './task-meta.js';
import {
  initNotify, getSettings, setSettings, feedOf, unreadOf, markRead, push,
  digestDateOf, setDigestDate,
} from './notify.js';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const execFileP = promisify(execFile);
const DIR = import.meta.dirname;
const DATA = path.resolve(DIR, process.env.DATA_DIR || 'data');
const NOTES = path.join(DATA, 'notes');
const notesDir = (userId) => path.join(NOTES, userId);
// Pasted images live beside, not inside, the notes: the note index and rename never see them.
const assetDir = (userId) => path.join(DATA, 'assets', userId);
const TOKEN_FILE = path.join(DATA, 'tokens.json');
const PORT = Number(process.env.PORT ?? 3000); // PORT=0 -> ephemeral
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

await fs.mkdir(NOTES, { recursive: true });
await initAuth(DATA, process.env.ACCESS_PASSWORD);

// One-time migration: notes used to be one flat shared folder. If any sit directly under
// data/notes/ and there's exactly one account, they're unambiguously that person's — move
// them into their own folder. With more than one account, don't guess whose they are.
{
  const flat = (await fs.readdir(NOTES)).filter((n) => n.endsWith('.md'));
  if (flat.length) {
    const people = listUsers();
    if (people.length === 1) {
      const dir = notesDir(people[0].id);
      await fs.mkdir(dir, { recursive: true });
      for (const n of flat) await fs.rename(path.join(NOTES, n), path.join(dir, n));
      console.log(`[notes] migrated ${flat.length} note(s) from data/notes/ into ${people[0].name}'s folder`);
    } else {
      console.warn(`[notes] ${flat.length} note(s) sit directly under data/notes/ with ${people.length} accounts present — not migrating automatically; move them into data/notes/<userId>/ by hand.`);
    }
  }
}

await initTaskMeta(DATA);
await initNotify(DATA);

let tokens = JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8').catch(() => '{}'));
const saveTokens = () => fs.writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2));

const fail = (status, msg) => Object.assign(new Error(msg), { status });
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).then(
    (d) => (res.headersSent ? undefined : res.json(d ?? {})),
    (e) => {
      if (e.status) return res.status(e.status).json({ error: e.message });
      // Unexpected errors carry disk paths and OS detail: log it, tell the client nothing.
      console.error('[api]', req.method, req.path, e);
      res.status(500).json({ error: 'server error' });
    },
  );

// Short-lived per-key cache for upstream reads the palette and inbox repeat.
// ponytail: never evicted — keys are per user, so it is bounded by headcount.
const memos = new Map();
const gens = new Map(); // bumped on every drop, so a read that started earlier cannot repopulate
const drop = (key) => { memos.delete(key); gens.set(key, (gens.get(key) || 0) + 1); };
async function memo(key, ttlMs, fn) {
  const hit = memos.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  const gen = gens.get(key) || 0;
  const data = await fn();
  if ((gens.get(key) || 0) === gen) memos.set(key, { at: Date.now(), data });
  return data;
}
// A task write makes the cached task list (and the inbox built from it) stale.
const bust = (uid) => { drop(`tasks:${uid}`); drop(`inbox:${uid}`); };

/* ---------- OAuth (one helper, two providers) ---------- */

const PROVIDERS = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    api: 'https://www.googleapis.com',
    // Adding a scope invalidates nothing, but the STORED token keeps the scopes it was
    // granted — Google must be reconnected once after this line changes or the Tasks calls 403.
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/tasks',
    ].join(' '),
    extra: { access_type: 'offline', prompt: 'consent' },
    id: 'GOOGLE_CLIENT_ID',
    secret: 'GOOGLE_CLIENT_SECRET',
  },
  spotify: {
    authUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
    api: 'https://api.spotify.com',
    // Adding a scope means the stored token no longer covers everything: reconnect Spotify
    // from the sidebar after changing this line, or the new calls come back 403.
    scope: [
      'user-read-currently-playing', 'user-read-playback-state', 'user-modify-playback-state',
      'user-read-recently-played', 'playlist-read-private', 'playlist-read-collaborative',
    ].join(' '),
    extra: {},
    id: 'SPOTIFY_CLIENT_ID',
    secret: 'SPOTIFY_CLIENT_SECRET',
  },
  linear: {
    authUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    api: 'https://api.linear.app',
    scope: 'read,write',
    extra: {},
    id: 'LINEAR_CLIENT_ID',
    secret: 'LINEAR_CLIENT_SECRET',
  },
  github: {
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    api: 'https://api.github.com',
    // OAuth Apps only support classic scopes — no fine-grained equivalent to a PAT exists.
    // `repo` (which also grants write) is the only way to read private repos via OAuth App.
    scope: 'read:user repo',
    extra: {},
    id: 'GITHUB_CLIENT_ID',
    secret: 'GITHUB_CLIENT_SECRET',
  },
};

const redirectUri = (name) => `${BASE_URL}/auth/${name}/callback`;

async function exchange(userId, name, body) {
  const p = PROVIDERS[name];
  const res = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json', // GitHub returns form-encoded without this; harmless elsewhere
    },
    body: new URLSearchParams({
      client_id: process.env[p.id] || '',
      client_secret: process.env[p.secret] || '',
      redirect_uri: redirectUri(name),
      ...body,
    }),
  });
  const j = await res.json();
  if (!res.ok) throw fail(502, `${name} token exchange: ${j.error_description || j.error || res.status}`);
  // A refresh grant usually omits refresh_token — keep the one we already have.
  tokens[userId] ||= {};
  tokens[userId][name] = {
    ...tokens[userId][name],
    ...j,
    // GitHub OAuth Apps don't expire by default (no expires_in in the response) — Infinity
    // makes that explicit rather than relying on Date.now() > NaN always being false.
    expires_at: j.expires_in ? Date.now() + (j.expires_in - 60) * 1000 : Infinity,
  };
  await saveTokens();
}

// Refreshes if needed and hands back a usable token, so the raw and JSON callers share
// exactly one place that knows about expiry.
async function accessToken(userId, name) {
  const t = tokens[userId]?.[name];
  if (!t) throw fail(428, `${name} not connected`);
  if (Date.now() > t.expires_at) {
    if (!t.refresh_token) throw fail(428, `${name} session expired — reconnect`);
    await exchange(userId, name, { grant_type: 'refresh_token', refresh_token: t.refresh_token });
  }
  return tokens[userId][name].access_token;
}

// For bytes rather than JSON: returns the Response so the body can be streamed.
async function apiRaw(userId, name, pathq) {
  const token = await accessToken(userId, name);
  const res = await fetch(PROVIDERS[name].api + pathq, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw fail(res.status, upstreamError(userId, name, res.status, detail, pathq));
  }
  return res;
}

async function api(userId, name, pathq, opts = {}) {
  const token = await accessToken(userId, name);
  // Google Tasks lives on tasks.googleapis.com, not the www.googleapis.com base the other
  // Google calls share, so an absolute URL is passed through untouched.
  const url = pathq.startsWith('https://') ? pathq : PROVIDERS[name].api + pathq;
  const res = await fetch(url, {
    ...opts,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...opts.headers,
    },
  });
  if (res.status === 204) return {};
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw fail(res.status, upstreamError(userId, name, res.status, j, pathq));
  return j;
}

// A bare "403" is useless for telling apart "the token predates this scope" from "Spotify
// will not serve this object". The provider's own message plus the scopes the stored token
// actually carries answers that without guesswork.
function upstreamError(userId, name, status, body, pathq) {
  const said = body.error?.message || body.error_description || body.error || `returned ${status}`;
  let msg = `${name}: ${said}`;
  if (status === 403 || status === 401) {
    const granted = tokens[userId]?.[name]?.scope;
    msg += granted ? ` — token was granted: ${granted}` : ' — the stored token records no scopes';
  }
  console.error(`[${name}] ${status} on ${pathq.split('?')[0]} — ${said}`);
  return msg;
}

/* ---------- identity ---------- */

// Behind a reverse proxy every request arrives from 127.0.0.1, which would make each visitor
// look like the server's own machine — auto-signing them in as whoever registered that device,
// and pooling every failed code attempt into one rate-limit bucket. TRUST_PROXY tells Express
// which hops may set X-Forwarded-For; without it the header is ignored, because anyone can
// send one. Set it to `loopback` when nginx runs on this host.
const clientIp = (req) => (req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const sidOf = (req) => (req.headers.cookie || '').match(/(?:^|;\s*)sid=([a-f0-9]{48})/)?.[1];

async function macOf(ip) {
  if (ip === '::1' || ip === '127.0.0.1' || ip === '') return 'localhost';
  const { stdout } = await execFileP('arp', ['-a']).catch(() => ({ stdout: '' }));
  return macFromArp(stdout, ip); // ponytail: ARP only sees the local segment; remote clients fall back to the code.
}

// Localhost has no MAC of its own — treat the server's own machine as a named device
// so it can be put on someone's allowlist like any other.
const LOCAL_MAC = '00:00:00:00:00:00';
const deviceMac = async (ip) => {
  const mac = await macOf(ip);
  return mac === 'localhost' ? LOCAL_MAC : mac;
};

async function setSession(res, user, via, ip) {
  const sid = await startSession(user, via, ip);
  const secure = BASE_URL.startsWith('https') ? ' Secure;' : '';
  res.setHeader('set-cookie', `sid=${sid}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=604800`);
}

// Every connection is per-user: tokens are keyed by whoever connected them, so "connected"
// always means "I connected my own account," never a shared/global state.
function connectionState(userId) {
  const t = tokens[userId] || {};
  return {
    connected: { google: !!t.google, spotify: !!t.spotify, linear: !!t.linear, github: !!t.github },
    configured: {
      google: !!process.env.GOOGLE_CLIENT_ID, spotify: !!process.env.SPOTIFY_CLIENT_ID,
      linear: !!process.env.LINEAR_CLIENT_ID, github: !!process.env.GITHUB_CLIENT_ID,
    },
  };
}

const me = (user, session) => ({
  auth: true,
  user: { id: user.id, name: user.name, role: user.role },
  caps: capsOf(user),
  via: session?.via,
  timezone: user.timezone || null,
  ...connectionState(user.id),
});

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
const jsonBody = express.json({ limit: '4mb' });
// Image uploads are raw bytes with their own parser and limit; never try them as JSON.
app.use((req, res, next) => (req.path === '/api/notes/assets' ? next() : jsonBody(req, res, next)));

app.get('/api/me', wrap(async (req, res) => {
  const found = sessionUser(sidOf(req));
  if (found) return me(found.user, found.session);

  const ip = clientIp(req);
  if (process.env.MAC_LOGIN !== 'false') {
    const user = userByMac(await deviceMac(ip));
    if (user) {
      await setSession(res, user, 'device', ip);
      await audit('signin', { userId: user.id, name: user.name, via: 'device', ip });
      return me(user, { via: 'device' });
    }
  }
  return { auth: false };
}));

const throttle = (ip) => {
  const wait = lockedFor(ip);
  if (wait) throw fail(429, `Too many attempts — try again in ${Math.ceil(wait / 60)} min.`);
};

app.post('/api/login', wrap(async (req, res) => {
  const ip = clientIp(req);
  throttle(ip);

  const name = String(req.body?.name ?? '');
  const user = await signIn(name, String(req.body?.password ?? ''));
  if (!user) {
    recordFailure(ip);
    await audit('signin-failed', { ip, name: name.slice(0, 40) });
    // Deliberately does not say which half was wrong — that would confirm who exists.
    throw fail(401, 'Wrong name or password');
  }
  clearFailures(ip);
  await setSession(res, user, 'password', ip);
  await audit('signin', { userId: user.id, name: user.name, via: 'password', ip });
  return me(user, { via: 'password' });
}));

/* ---------- passkeys (WebAuthn) ---------- */

// The RP ID must be exactly the hostname the page is served from, and the origin must match
// the full URL — both come from BASE_URL so dev and the VPS stay consistent.
const RP_ID = new URL(BASE_URL).hostname;
const RP_ORIGIN = new URL(BASE_URL).origin;
const RP_NAME = 'Dash';

// Challenges are single-use and short-lived; losing them on restart is harmless.
const challenges = new Map();
const CHALLENGE_MS = 120_000;

function putChallenge(res, challenge, userId = null) {
  const id = crypto.randomBytes(16).toString('hex');
  challenges.set(id, { challenge, userId, expires: Date.now() + CHALLENGE_MS });
  const secure = BASE_URL.startsWith('https') ? ' Secure;' : '';
  res.setHeader('set-cookie', `wac=${id}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=120`);
}

function takeChallenge(req) {
  const id = (req.headers.cookie || '').match(/(?:^|;\s*)wac=([a-f0-9]{32})/)?.[1];
  const entry = id && challenges.get(id);
  if (id) challenges.delete(id); // single use, whether or not it verifies
  if (!entry || entry.expires < Date.now()) throw fail(400, 'challenge expired — try again');
  return entry;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
}, CHALLENGE_MS).unref();

// --- signing in with a passkey: no name, no password ---

app.post('/api/login/passkey/options', wrap(async (req, res) => {
  throttle(clientIp(req));
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    // No allowCredentials: the browser offers whichever discoverable passkey matches this
    // site, so the person never types a name.
    userVerification: 'preferred',
  });
  putChallenge(res, options.challenge);
  return options;
}));

app.post('/api/login/passkey', wrap(async (req, res) => {
  const ip = clientIp(req);
  throttle(ip);
  const { challenge } = takeChallenge(req);

  const response = req.body?.response;
  const found = response?.id ? userByPasskey(response.id) : null;
  if (!found) {
    recordFailure(ip);
    await audit('signin-failed', { ip, via: 'passkey' });
    throw fail(401, 'Unknown passkey');
  }

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: RP_ORIGIN,
    expectedRPID: RP_ID,
    credential: {
      id: found.passkey.id,
      publicKey: Buffer.from(found.passkey.publicKey, 'base64url'),
      counter: found.passkey.counter,
      transports: found.passkey.transports,
    },
  }).catch((e) => { throw fail(401, e.message); });

  if (!verification.verified) {
    recordFailure(ip);
    await audit('signin-failed', { ip, via: 'passkey' });
    throw fail(401, 'Passkey rejected');
  }

  // A counter that goes backwards means the credential was cloned; the library flags it,
  // and storing the new value is what makes the check work next time.
  await touchPasskey(found.passkey.id, verification.authenticationInfo.newCounter);
  clearFailures(ip);
  await setSession(res, found.user, 'passkey', ip);
  await audit('signin', { userId: found.user.id, name: found.user.name, via: 'passkey', ip });
  return me(found.user, { via: 'passkey' });
}));

app.post('/api/logout', wrap(async (req, res) => {
  await endSession(sidOf(req));
  res.setHeader('set-cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  return { ok: true };
}));

/* ---------- the gate: authentication, then authorisation per route ---------- */

app.use((req, res, next) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/auth')) return next();
  const found = sessionUser(sidOf(req));
  if (!found) return res.status(401).json({ error: 'not authenticated' });
  req.user = found.user;
  req.session = found.session;
  next();
});

// Every protected route names the capability it needs. Holding any one of them is enough.
const can = (...anyOf) => (req, res, next) =>
  allows(req.user, ...anyOf)
    ? next()
    : res.status(403).json({ error: `not allowed — needs ${anyOf.join(' or ')}` });

/* ---------- your own account ---------- */

// Changing your own password needs no capability, but does need the current one — a stolen
// session should not be able to lock the real owner out.
app.post('/api/me/password', wrap(async (req) => {
  const current = String(req.body?.current ?? '');
  if (req.user.passwordHash && !(await signIn(req.user.name, current))) {
    recordFailure(clientIp(req));
    throw fail(401, 'Current password is wrong');
  }
  await updateUser(req.user.id, { password: String(req.body?.next ?? '') });
  await audit('password-changed', { userId: req.user.id, name: req.user.name });
  return { ok: true };
}));

// No capability gate: only ever touches the caller's own record. `null` clears it, falling
// back to the server's own timezone for date math (today's behavior for anyone who never sets one).
app.post('/api/me/timezone', wrap(async (req) => {
  const user = await updateUser(req.user.id, { timezone: req.body?.timezone ?? null });
  return { timezone: user.timezone || null };
}));

/* ---------- passkeys: registering your own ---------- */
// No capability gate: these only ever touch the caller's own credentials.

app.get('/api/passkeys', wrap(async (req) =>
  passkeysOf(req.user.id).map(({ publicKey, ...p }) => p)));

app.post('/api/passkeys/options', wrap(async (req, res) => {
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: Buffer.from(req.user.id, 'utf8'),
    userName: req.user.name,
    userDisplayName: req.user.name,
    // residentKey: the passkey is stored on the device with enough context to be offered
    // without a name — that is what makes the passwordless sign-in button work.
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    // Stops the same authenticator being enrolled twice.
    excludeCredentials: passkeysOf(req.user.id).map((p) => ({ id: p.id, transports: p.transports })),
  });
  putChallenge(res, options.challenge, req.user.id);
  return options;
}));

app.post('/api/passkeys', wrap(async (req) => {
  const { challenge, userId } = takeChallenge(req);
  // The challenge is bound to the person who asked for it, so one session cannot enrol
  // a passkey onto another account.
  if (userId !== req.user.id) throw fail(400, 'challenge does not belong to this session');

  const verification = await verifyRegistrationResponse({
    response: req.body?.response,
    expectedChallenge: challenge,
    expectedOrigin: RP_ORIGIN,
    expectedRPID: RP_ID,
  }).catch((e) => { throw fail(400, e.message); });

  if (!verification.verified) throw fail(400, 'passkey could not be verified');

  const { credential } = verification.registrationInfo;
  const saved = await addPasskey(req.user.id, {
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: credential.transports,
    label: req.body?.label,
  });
  await audit('passkey-added', { userId: req.user.id, name: req.user.name, label: saved.label });
  const { publicKey, ...safe } = saved;
  return safe;
}));

app.delete('/api/passkeys/:id', wrap(async (req) => {
  await removePasskey(req.user.id, req.params.id);
  await audit('passkey-removed', { userId: req.user.id, name: req.user.name });
  return { ok: true };
}));

/* ---------- people, devices, permissions ---------- */

app.get('/api/access', can('users:manage'), wrap(async () => ({
  capabilities: CAPABILITIES,
  roles: ROLES,
  users: listUsers().map((u) => ({ ...u, sessions: sessionsOf(u.id) })),
  audit: await readAudit(60),
})));

app.get('/api/access/device', can('users:manage'), wrap(async (req) => {
  const ip = clientIp(req);
  const mac = await deviceMac(ip);
  return { ip, mac, local: mac === LOCAL_MAC };
}));

app.post('/api/access/users', can('users:manage'), wrap(async (req) => {
  const u = await createUser(req.body || {});
  await audit('user-created', { by: req.user.name, userId: u.id, name: u.name, role: u.role });
  return listUsers().find((x) => x.id === u.id);
}));

app.patch('/api/access/users/:id', can('users:manage'), wrap(async (req) => {
  // Don't let an admin lock themselves out of the panel they are standing in.
  if (req.params.id === req.user.id && (req.body?.role !== undefined || req.body?.permissions !== undefined)) {
    const after = { ...getUser(req.user.id), ...req.body };
    if (!capsOf(after).includes('users:manage')) throw fail(400, 'you cannot remove your own access management');
  }
  const u = await updateUser(req.params.id, req.body || {});
  await audit('user-updated', { by: req.user.name, userId: u.id, fields: Object.keys(req.body || {}) });
  return listUsers().find((x) => x.id === u.id);
}));

app.delete('/api/access/users/:id', can('users:manage'), wrap(async (req) => {
  if (req.params.id === req.user.id) throw fail(400, 'you cannot delete yourself');
  const gone = getUser(req.params.id);
  await deleteUser(req.params.id);
  await audit('user-deleted', { by: req.user.name, userId: req.params.id, name: gone?.name });
  return { ok: true };
}));

/* ---------- provider connections (always your own — no capability gate, like passkeys) ---------- */

app.get('/auth/:name', (req, res) => {
  const p = PROVIDERS[req.params.name];
  if (!p) return res.status(404).send('unknown provider');
  if (!process.env[p.id]) return res.status(428).send(`${p.id} is not set in .env`);
  // Binds the callback to the session that started this flow, so a code an attacker got
  // for their own account can't be replayed into a victim's session (OAuth CSRF).
  const state = crypto.randomBytes(16).toString('hex');
  const secure = BASE_URL.startsWith('https') ? ' Secure;' : '';
  res.setHeader('set-cookie', `oas=${state}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=300`);
  const q = new URLSearchParams({
    client_id: process.env[p.id],
    redirect_uri: redirectUri(req.params.name),
    response_type: 'code',
    scope: p.scope,
    state,
    ...p.extra,
  });
  res.redirect(`${p.authUrl}?${q}`);
});

app.get('/auth/:name/callback', wrap(async (req, res) => {
  if (!PROVIDERS[req.params.name]) throw fail(404, 'unknown provider');
  const cookieState = (req.headers.cookie || '').match(/(?:^|;\s*)oas=([a-f0-9]{32})/)?.[1];
  res.setHeader('set-cookie', 'oas=; HttpOnly; Path=/; Max-Age=0'); // single use either way
  if (!cookieState || cookieState !== req.query.state) throw fail(400, 'state mismatch — try connecting again');
  if (req.query.error) throw fail(400, String(req.query.error));
  await exchange(req.user.id, req.params.name, { grant_type: 'authorization_code', code: String(req.query.code || '') });
  await audit('provider-connected', { by: req.user.name, provider: req.params.name });
  res.redirect('/');
}));

app.post('/api/disconnect/:name', wrap(async (req) => {
  if (tokens[req.user.id]) delete tokens[req.user.id][req.params.name];
  await saveTokens();
  await audit('provider-disconnected', { by: req.user.name, provider: req.params.name });
  return connectionState(req.user.id);
}));

/* ---------- Calendar events (tasks are NOT events any more — see Tasks below) ---------- */

const CAL = () => encodeURIComponent(process.env.CALENDAR_ID || 'primary');
const eventsUrl = (suffix = '') => `/calendar/v3/calendars/${CAL()}/events${suffix}`;
const shape = (e) => ({
  id: e.id,
  title: e.summary || '(no title)',
  notes: e.description || '',
  start: e.start?.dateTime || e.start?.date,
  end: e.end?.dateTime || e.end?.date,
  allDay: !e.start?.dateTime,
  link: e.htmlLink,
  location: e.location || '',
  // Only still read so the one-shot migration can find tasks created before the move
  // to Google Tasks; nothing writes these any more.
  task: e.extendedProperties?.private?.dash === 'task',
  done: e.extendedProperties?.private?.done === '1',
  priority: e.extendedProperties?.private?.priority || null,
  project: e.extendedProperties?.private?.project || null,
});

// Shared by /api/events and the project-scoped task routes below, so the window/paging
// query is built in exactly one place.
async function fetchEventsWindow(userId, days) {
  const from = startOfDay(getUser(userId)?.timezone);
  const clamped = Math.min(Math.max(Number(days) || 14, 1), 90);
  const q = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: new Date(from.getTime() + clamped * 864e5).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
  });
  const r = await api(userId, 'google', eventsUrl(`?${q}`));
  return (r.items || []).map(shape);
}

app.get('/api/events', can('calendar:read', 'tasks:read'), wrap(async (req) => {
  const items = await fetchEventsWindow(req.user.id, req.query.days || 14);
  if (req.query.tasks) return items.filter((i) => i.task);
  // Someone with tasks:read but not calendar:read sees only their tasks, never the diary.
  return allows(req.user, 'calendar:read') ? items : items.filter((i) => i.task);
}));

/* ---------- Tasks (Google Tasks + a Linear issue, NOT calendar events) ---------- */

// Google Tasks lives on a different host from every other Google call, and the default list
// is the one Calendar shows in its Tasks pane.
const TASKS_LIST = () => encodeURIComponent(process.env.TASKS_LIST_ID || '@default');
const tasksUrl = (suffix = '') =>
  `https://tasks.googleapis.com/tasks/v1/lists/${TASKS_LIST()}/tasks${suffix}`;

// Completed tasks stay listed this long so ticking one does not make it vanish mid-glance.
const DONE_GRACE_MS = 7 * 864e5;

// `due` keeps only the date — the API discards the time of day — so the time lives in the
// local meta store and is recombined here.
function shapeTask(t, meta = {}) {
  const day = t.due ? t.due.slice(0, 10) : null;
  const start = day ? (meta.time ? `${day}T${meta.time}:00` : day) : null;
  return {
    id: t.id,
    title: t.title || '(no title)',
    notes: t.notes || '',
    start,
    end: start,
    allDay: !meta.time,
    link: '',
    location: '',
    task: true,
    done: t.status === 'completed',
    completedAt: t.completed || null,
    priority: meta.priority || null,
    project: meta.project || null,
    linearUrl: meta.linearUrl || null,
    linearKey: meta.linearKey || null,
  };
}

// The API wants an RFC 3339 timestamp but only reads the date out of it.
function dueFrom(startInput, tz) {
  if (!startInput) return undefined;
  return dueDate(startInput, tz) + 'T00:00:00.000Z';
}

// The stored HH:MM has to be the wall clock the person typed, which the raw input already
// carries; taskWindow's output is UTC and would drift by the offset.
const timeFrom = (startInput) => {
  const m = String(startInput ?? '').match(/T(\d{2}:\d{2})/);
  return m ? m[1] : null;
};

/* --- Linear: one issue per task, in the selected project --- */

// Issues need a team and a project can span several, so the first one is used.
async function linearIssueFor(userId, projectId, { title, notes, due }) {
  const data = await linear(userId, `query($id: String!) {
    project(id: $id) { id teams(first: 1) { nodes { id } } }
  }`, { id: projectId });

  const teamId = data.project?.teams?.nodes?.[0]?.id;
  if (!teamId) throw fail(400, 'that Linear project has no team to file an issue under');

  const res = await linear(userId, `mutation($input: IssueCreateInput!) {
    issueCreate(input: $input) { success issue { id identifier url } }
  }`, {
    input: {
      title,
      description: notes || undefined,
      teamId,
      projectId,
      dueDate: due ? due.slice(0, 10) : undefined,
    },
  });

  if (!res.issueCreate?.success) throw fail(502, 'Linear rejected the issue');
  return res.issueCreate.issue;
}

// One mutation with only the fields that changed. `dueDate: null` and `priority: 0` clear them.
async function linearUpdateIssue(userId, issueId, fields) {
  const input = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  if (!Object.keys(input).length) return;
  const res = await linear(userId, `mutation($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success }
  }`, { id: issueId, input });
  if (!res.issueUpdate?.success) throw fail(502, 'Linear rejected the update');
}

// Archive is reversible from Linear; issueDelete is never used here.
async function linearArchiveIssue(userId, issueId) {
  const res = await linear(userId, `mutation($id: String!) { issueArchive(id: $id) { success } }`, { id: issueId });
  if (!res.issueArchive?.success) throw fail(502, 'Linear rejected the archive');
}

async function linearSetIssueDone(userId, issueId, done) {
  // Linear has no boolean "done": an issue moves to a workflow state, and which state counts
  // as finished is defined per team, so the team's states have to be read first.
  const data = await linear(userId, `query($id: String!) {
    issue(id: $id) { id team { id states(first: 50) { nodes { id type position } } } }
  }`, { id: issueId });

  const states = data.issue?.team?.states?.nodes || [];
  const want = done ? 'completed' : 'unstarted';
  const target = states.filter((s) => s.type === want).sort((a, b) => a.position - b.position)[0]
    || states.find((s) => s.type === (done ? 'canceled' : 'backlog'));
  if (!target) return;

  await linear(userId, `mutation($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) { success }
  }`, { id: issueId, stateId: target.id });
}

/* --- routes --- */

async function listTasks(uid) {
  const q = new URLSearchParams({ maxResults: '100', showCompleted: 'true', showHidden: 'true' });
  const r = await api(uid, 'google', tasksUrl(`?${q}`));
  const cutoff = Date.now() - DONE_GRACE_MS;

  return (r.items || [])
    // An incomplete task stays listed however old its due date is — that is what "shown
    // until completed" means. Only finished ones age out.
    .filter((t) => t.status !== 'completed' || (t.completed && Date.parse(t.completed) > cutoff))
    .map((t) => shapeTask(t, metaOf(t.id)))
    .sort((a, b) => Number(a.done) - Number(b.done) || (a.start || '9999').localeCompare(b.start || '9999'));
}

app.get('/api/tasks', can('tasks:read', 'tasks:write'), wrap((req) => listTasks(req.user.id)));

// Shared by POST /api/tasks and quick capture, so both write a task the same way. `body` is
// the POST /api/tasks payload; the Google task is created first and a Linear failure is
// reported as a warning rather than undoing it.
async function createTask(user, body) {
  const title = String(body?.title || '').trim();
  if (!title) throw fail(400, 'title required');
  const notes = String(body?.notes || '');
  const due = dueFrom(body?.start, user.timezone);

  const created = await api(user.id, 'google', tasksUrl(), {
    method: 'POST',
    body: JSON.stringify({ title, notes, due, status: 'needsAction' }),
  });

  const meta = {
    time: timeFrom(body?.start),
    minutes: body?.minutes,
    priority: body?.priority,
    project: body?.project || null,
  };

  // The Google task already exists, so a Linear failure must not lose it: the issue is
  // best-effort and its error rides back with the created task.
  let warning = null;
  // Linking an existing issue (from the inbox) never files a new one.
  const link = allows(user, 'projects:read') ? linearLink(body?.linearIssue) : null;
  if (link) Object.assign(meta, link);
  else if (body?.project) {
    try {
      const issue = await linearIssueFor(user.id, String(body.project), { title, notes, due });
      Object.assign(meta, { linearId: issue.id, linearUrl: issue.url, linearKey: issue.identifier });
    } catch (e) {
      warning = `Task created, but Linear did not: ${e.message}`;
    }
  }

  const saved = await setMeta(created.id, meta);
  bust(user.id);
  return { ...shapeTask(created, saved), warning };
}
app.post('/api/tasks', can('tasks:write'), wrap((req) => createTask(req.user, req.body)));

/* --- quick capture: "mañana 3pm revisar PR !dash p1" --- */

const QUICK_MAX = 300;

// Linear projects are the only lookup; they are cached briefly so typing does not hit Linear
// per keystroke. Without projects:read, or with Linear unreachable, the list is just empty.
async function quickParse(user, text) {
  const s = String(text ?? '');
  if (s.length > QUICK_MAX) throw fail(400, `text is limited to ${QUICK_MAX} characters`);
  // A failed load is cached too (15 s), so previews do not hammer Linear while it is down.
  const loaded = allows(user, 'projects:read')
    ? await memo(`projects:${user.id}`, 15_000, async () => {
      try {
        const d = await linear(user.id, 'query { projects(first: 100, includeArchived: false) { nodes { id name } } }');
        return { projects: d.projects.nodes, failed: false };
      } catch { return { projects: [], failed: true }; }
    })
    : { projects: [], failed: false };
  return parseQuick(s, { now: new Date(), tz: user.timezone, projects: loaded.projects, projectsFailed: loaded.failed });
}

app.get('/api/quick/parse', can('tasks:write'), wrap((req) => quickParse(req.user, req.query.text)));

// The server parses again on create, so what is stored never depends on the client's preview.
app.post('/api/tasks/quick', can('tasks:write'), wrap(async (req) => {
  const parsed = await quickParse(req.user, req.body?.text);
  if (!parsed.title) throw fail(400, 'title required');
  const task = await createTask(req.user, {
    title: parsed.title, start: parsed.due, minutes: parsed.duration,
    priority: parsed.priority, project: parsed.project?.id,
  });
  return { task, parsed };
}));

app.patch('/api/tasks/:id', can('tasks:write'), wrap(async (req) => {
  const id = encodeURIComponent(req.params.id);
  const body = {};

  if (req.body?.title) body.title = String(req.body.title);
  if (req.body?.notes !== undefined) body.notes = String(req.body.notes);
  if (req.body?.start) body.due = dueFrom(req.body.start, req.user.timezone);
  if (req.body?.done !== undefined) {
    body.status = req.body.done ? 'completed' : 'needsAction';
    // Reopening needs `completed` cleared too, or the task keeps its completion timestamp.
    if (!req.body.done) body.completed = null;
  }

  const updated = Object.keys(body).length
    ? await api(req.user.id, 'google', tasksUrl(`/${id}`), { method: 'PATCH', body: JSON.stringify(body) })
    : await api(req.user.id, 'google', tasksUrl(`/${id}`));

  const patch = {};
  if (req.body?.start) patch.time = timeFrom(req.body.start);
  if (req.body?.minutes !== undefined) patch.minutes = req.body.minutes;
  if (req.body?.priority !== undefined) patch.priority = req.body.priority || null;
  if (req.body?.project !== undefined) patch.project = req.body.project || null;
  const meta = Object.keys(patch).length ? await setMeta(req.params.id, patch) : metaOf(req.params.id);

  const warnings = [];
  if (req.body?.done !== undefined && meta.linearId) {
    try { await linearSetIssueDone(req.user.id, meta.linearId, !!req.body.done); }
    catch (e) { warnings.push(`Task updated, but its Linear issue did not: ${e.message}`); }
  }
  // Task -> issue only; edits made in Linear are not pulled back.
  const fields = issuePatch(req.body, body, meta);
  if (fields) {
    try {
      await linearUpdateIssue(req.user.id, meta.linearId, fields);
    } catch (e) { warnings.push(`Task updated, but its Linear issue did not sync: ${e.message}`); }
  }

  bust(req.user.id);
  return { ...shapeTask(updated, meta), warning: warnings.join(' ') || null };
}));

app.delete('/api/tasks/:id', can('tasks:write'), wrap(async (req) => {
  const { linearId } = metaOf(req.params.id); // read before deleteMeta drops it
  await api(req.user.id, 'google', tasksUrl(`/${encodeURIComponent(req.params.id)}`), { method: 'DELETE' });
  await deleteMeta(req.params.id);
  bust(req.user.id);
  // The Linear issue is left alone unless the caller opts in with ?linear=archive, and even
  // then it is archived (reversible), never deleted: tidying your own list is not a call
  // this app should make on a shared tracker by default.
  let warning = null;
  if (linearId && req.query.linear === 'archive') {
    try { await linearArchiveIssue(req.user.id, linearId); }
    catch (e) { warning = `Task deleted, but its Linear issue was not archived: ${e.message}`; }
  }
  return { ok: true, warning };
}));

// How many pre-migration tasks are still sitting in the calendar. Drives the one-time
// prompt in the Tasks view; returns 0 forever once they have been moved.
app.get('/api/tasks/legacy', can('tasks:read', 'tasks:write'), wrap(async (req) => ({
  count: (await fetchEventsWindow(req.user.id, 90)).filter((e) => e.task && !e.done).length,
})));

// One-shot rescue for tasks created before this became Google Tasks: they were calendar
// events tagged dash=task and would otherwise be stranded in the diary.
app.post('/api/tasks/migrate', can('tasks:write'), wrap(async (req) => {
  const legacy = (await fetchEventsWindow(req.user.id, 90)).filter((e) => e.task && !e.done);
  let moved = 0;
  for (const e of legacy) {
    const created = await api(req.user.id, 'google', tasksUrl(), {
      method: 'POST',
      body: JSON.stringify({
        title: e.title,
        notes: e.notes,
        due: e.start ? e.start.slice(0, 10) + 'T00:00:00.000Z' : undefined,
        status: 'needsAction',
      }),
    });
    await setMeta(created.id, { time: timeFrom(e.start), priority: e.priority, project: e.project });
    await api(req.user.id, 'google', eventsUrl(`/${encodeURIComponent(e.id)}`), { method: 'DELETE' });
    await deleteMeta(e.id);
    moved += 1;
  }
  bust(req.user.id);
  await audit('tasks-migrated', { by: req.user.name, moved });
  return { moved };
}));

/* ---------- Projects (Linear — NOT a local store, NOT Calendar-backed) ---------- */

// Linear's whole API is one GraphQL endpoint; errors come back as HTTP 200 with an
// `errors` array, which api()'s res.ok check does not catch, so that's checked here.
async function linear(userId, query, variables) {
  const j = await api(userId, 'linear', '/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) });
  if (j.errors?.length) throw fail(400, j.errors.map((e) => e.message).join('; '));
  return j.data;
}

const PROJECT_FIELDS = `
  id name description color icon url progress targetDate startDate createdAt archivedAt
  status { id name type color }
  lead { name }
`;

app.get('/api/projects', can('projects:read'), wrap(async (req) => {
  const data = await linear(req.user.id, `query { projects(first: 100, includeArchived: false, orderBy: updatedAt) { nodes { ${PROJECT_FIELDS} } } }`);
  const projects = data.projects.nodes;
  // Stats need a Calendar read, so they're opt-in (?stats=1) and only computed for
  // someone who actually holds tasks:read — projects:read alone doesn't imply it.
  if (!req.query.stats || !allows(req.user, 'tasks:read')) return projects;

  const counts = {};
  for (const t of await fetchEventsWindow(req.user.id, 90).catch(() => [])) {
    if (!t.task || !t.project) continue;
    counts[t.project] ||= { total: 0, done: 0 };
    counts[t.project].total++;
    if (t.done) counts[t.project].done++;
  }
  return projects.map((p) => ({ ...p, stats: counts[p.id] || { total: 0, done: 0 } }));
}));

app.post('/api/projects', can('projects:write'), wrap(async (req) => {
  const name = String(req.body?.name || '').trim();
  if (!name) throw fail(400, 'name required');
  const teamIds = Array.isArray(req.body?.teamIds) ? req.body.teamIds.filter(Boolean) : [];
  if (!teamIds.length) throw fail(400, 'at least one team is required');

  const input = { name, teamIds };
  if (req.body?.color) input.color = String(req.body.color);
  if (req.body?.description) input.description = String(req.body.description).slice(0, 5000);
  if (req.body?.statusId) input.statusId = String(req.body.statusId);
  if (req.body?.targetDate) input.targetDate = String(req.body.targetDate);

  const data = await linear(
    req.user.id,
    `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { ${PROJECT_FIELDS} } } }`,
    { input },
  );
  if (!data.projectCreate.success) throw fail(502, 'Linear rejected the project');
  return data.projectCreate.project;
}));

app.patch('/api/projects/:id', can('projects:write'), wrap(async (req) => {
  const input = {};
  for (const k of ['name', 'color', 'description', 'statusId', 'targetDate']) {
    if (req.body?.[k] !== undefined) input[k] = req.body[k];
  }
  const data = await linear(
    req.user.id,
    `mutation($id: String!, $input: ProjectUpdateInput!) { projectUpdate(id: $id, input: $input) { success project { ${PROJECT_FIELDS} } } }`,
    { id: req.params.id, input },
  );
  if (!data.projectUpdate.success) throw fail(502, 'Linear rejected the update');
  return data.projectUpdate.project;
}));

app.delete('/api/projects/:id', can('projects:write'), wrap(async (req) => {
  const data = await linear(req.user.id, `mutation($id: String!) { projectDelete(id: $id) { success } }`, { id: req.params.id });
  if (!data.projectDelete.success) throw fail(502, 'Linear rejected the delete');
  return { ok: true };
}));

app.get('/api/projects/:id/tasks', can('tasks:read'), wrap(async (req) => {
  const items = await fetchEventsWindow(req.user.id, req.query.days || 90);
  return items.filter((i) => i.task && i.project === req.params.id);
}));

app.get('/api/linear/teams', can('projects:read'), wrap(async (req) => {
  const data = await linear(req.user.id, `query { teams(first: 100) { nodes { id name } } }`);
  return data.teams.nodes;
}));

app.get('/api/linear/statuses', can('projects:read'), wrap(async (req) => {
  const data = await linear(req.user.id, `query { projectStatuses(first: 50) { nodes { id name type color } } }`);
  return data.projectStatuses.nodes;
}));

/* ---------- Subtasks (local store, keyed by Calendar event id) ---------- */

app.get('/api/tasks/:id/subtasks', can('tasks:read', 'tasks:write'), wrap(async (req) =>
  subtasksOf(req.params.id)));

app.put('/api/tasks/:id/subtasks', can('tasks:write'), wrap(async (req) =>
  setSubtasks(req.params.id, req.body?.subtasks)));

/* ---------- Drive ---------- */

const FOLDER = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'files(id,name,mimeType,modifiedTime,webViewLink,iconLink,size)';

// Two modes: browsing one folder (the default, starting at My Drive) or searching everywhere.
app.get('/api/drive', can('drive:read'), wrap(async (req) => {
  const term = driveTerm(req.query.q);
  const folder = String(req.query.folder || 'root').split(/[^0-9a-zA-Z_-]/).join('');

  const q = new URLSearchParams(term
    ? {
        q: `name contains '${term}' and trashed = false`,
        orderBy: 'modifiedTime desc',
        pageSize: '100',
        fields: FILE_FIELDS,
      }
    : {
        q: `'${folder}' in parents and trashed = false`,
        // Folders first, then alphabetical — how a file browser is expected to behave.
        orderBy: 'folder,name',
        pageSize: '200',
        fields: FILE_FIELDS,
      });

  const files = (await api(req.user.id, 'google', `/drive/v3/files?${q}`)).files || [];
  return {
    files: files.map((f) => ({ ...f, folder: f.mimeType === FOLDER })),
    folder: term ? null : folder,
    searching: !!term,
  };
}));

// Google's own /preview iframe authenticates with the viewer's Google session cookies, which
// are third-party inside our page and blocked by default in current browsers — hence the 401s.
// Serving the bytes ourselves, with the OAuth token we already hold, makes the preview
// same-origin and independent of whether the viewer is signed into Google at all.
const GOOGLE_EXPORT = {
  'application/vnd.google-apps.document': 'application/pdf',
  'application/vnd.google-apps.spreadsheet': 'application/pdf',
  'application/vnd.google-apps.presentation': 'application/pdf',
  'application/vnd.google-apps.drawing': 'image/png',
};

app.get('/api/drive/:id/preview', can('drive:read'), wrap(async (req, res) => {
  const id = encodeURIComponent(req.params.id);
  const meta = await api(req.user.id, 'google', `/drive/v3/files/${id}?fields=name,mimeType`);

  // Google-native docs have no bytes to download; they have to be exported to a real format.
  const exportAs = GOOGLE_EXPORT[meta.mimeType];
  const upstream = exportAs
    ? await apiRaw(req.user.id, 'google', `/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exportAs)}`)
    : await apiRaw(req.user.id, 'google', `/drive/v3/files/${id}?alt=media`);

  res.setHeader('content-type', exportAs || meta.mimeType || 'application/octet-stream');
  // inline, never attachment: this is a preview pane, not a download. The filename is quoted
  // and stripped of quotes and newlines so it cannot break out of the header.
  const safeName = String(meta.name || 'file').replace(/["\r\n]/g, '');
  res.setHeader('content-disposition', `inline; filename="${safeName}"`);
  const len = upstream.headers.get('content-length');
  if (len) res.setHeader('content-length', len);

  // ponytail: streams straight through, no Range support — seeking inside a large video
  // will re-fetch. Add Range passthrough if that ever matters.
  await pipeline(Readable.fromWeb(upstream.body), res);
}));

/* ---------- Notes (markdown + latex, plain files on disk — private per person) ---------- */

// A note's identity is its path relative to the person's notes dir ("proj/ideas.md").
// notePath() has already vetted the string; the resolve check is the second lock.
function noteFile(uid, rel) {
  const dir = path.resolve(notesDir(uid));
  const abs = path.resolve(dir, rel);
  if (!abs.startsWith(dir + path.sep)) throw fail(400, 'bad note name');
  return abs;
}

// In-memory index per person: rel -> {mtimeMs, size, body, tags, links}. Every request
// re-validates it with readdir+stat and re-reads only files whose mtime or size moved, so
// edits made outside the app (sync, git) show up without a watcher.
// ponytail: whole bodies held in RAM and a full stat walk per request — fine to ~2000 notes;
// beyond that use fs.watch or a persisted index.
const noteIdx = new Map();
const NOTE_DEPTH = 3; // folders, same ceiling as notePath

async function noteIndex(uid) {
  const root = notesDir(uid);
  await fs.mkdir(root, { recursive: true });
  if (!noteIdx.has(uid)) noteIdx.set(uid, new Map());
  const idx = noteIdx.get(uid);
  const seen = new Set();
  const walk = async (rel, depth) => {
    const ents = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
    await Promise.all(ents.map(async (e) => {
      if (e.isSymbolicLink()) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (depth < NOTE_DEPTH) await walk(r, depth + 1); return; }
      if (!e.isFile()) return;
      try { notePath(r); } catch { return; } // names the API could never address
      const st = await fs.stat(path.join(root, r)).catch(() => null);
      if (!st) return;
      seen.add(r);
      const old = idx.get(r);
      if (old && old.mtimeMs === st.mtimeMs && old.size === st.size) return;
      const body = await fs.readFile(path.join(root, r), 'utf8').catch(() => '');
      idx.set(r, { mtimeMs: st.mtimeMs, size: st.size, body, ...parseNote(body) });
    }));
  };
  await walk('', 0);
  for (const k of idx.keys()) if (!seen.has(k)) idx.delete(k);
  return [...idx].map(([rel, v]) => ({ rel, ...v }));
}

// After a write, refresh just that entry instead of waiting for the next walk.
async function indexNote(uid, rel, body) {
  const st = await fs.stat(noteFile(uid, rel));
  noteIdx.get(uid)?.set(rel, { mtimeMs: st.mtimeMs, size: st.size, body, ...parseNote(body) });
}

// Folders exist only while they hold notes; remove emptied ones, innermost first.
async function pruneFolders(uid, rel) {
  const root = path.resolve(notesDir(uid));
  let dir = path.dirname(noteFile(uid, rel));
  while (dir.startsWith(root + path.sep)) {
    if (!(await fs.rmdir(dir).then(() => true, () => false))) break;
    dir = path.dirname(dir);
  }
}

app.get('/api/notes', can('notes:read'), wrap(async (req) => {
  const { q = '', tag = '', folder = '' } = req.query;
  const filtered = !!(q || tag || folder);
  return filterNotes(await noteIndex(req.user.id), { q: String(q), tag: String(tag), folder: String(folder) }, filtered ? 200 : Infinity);
}));

// Registered before the wildcard so "rename" can never be read as a note path.
app.post('/api/notes/rename', can('notes:write'), wrap(async (req) => {
  const uid = req.user.id;
  const from = notePath(req.body?.from);
  const to = notePath(req.body?.to);
  const src = noteFile(uid, from);
  const dst = noteFile(uid, to);
  if (from === to) return { name: to, rewritten: 0 };
  const entries = await noteIndex(uid);
  if (!entries.some((e) => e.rel === from)) throw fail(404, 'note not found');
  if (await fs.stat(dst).then(() => true, () => false)) throw fail(409, 'a note or folder with that name already exists');
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.rename(src, dst);
  noteIdx.get(uid)?.delete(from);

  // Links in every note (the moved one included) that pointed at `from` follow it.
  const paths = entries.map((e) => e.rel);
  let rewritten = 0;
  for (const e of entries) {
    if (!e.body.includes('[[')) continue;
    const { body, n } = rewriteLinks(e.body, from, to, paths, e.rel);
    if (!n) continue;
    const at = e.rel === from ? to : e.rel;
    await fs.writeFile(noteFile(uid, at), body, 'utf8');
    await indexNote(uid, at, body);
    rewritten++;
  }
  if (!noteIdx.get(uid)?.has(to)) await indexNote(uid, to, entries.find((e) => e.rel === from).body);
  await pruneFolders(uid, from);
  return { name: to, rewritten };
}));

// Image management. Registered before the wildcards below so "assets" is never read as a note
// path. Everything stays inside assets/<uid>, matches ASSET_NAME exactly and skips symlinks.
const ASSET_REF = /\/notes\/assets\/([a-f0-9]{32}\.(?:png|jpe?g|gif|webp))/g;
const PRUNE_MIN_AGE_MS = 10 * 60_000; // a just-pasted image may not be autosaved into its note yet

async function assetFiles(uid) {
  const dir = assetDir(uid);
  const out = [];
  for (const name of await fs.readdir(dir).catch(() => [])) {
    if (!ASSET_NAME.test(name)) continue;
    const st = await fs.lstat(path.join(dir, name)).catch(() => null);
    if (st?.isFile()) out.push({ name, bytes: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}

// name -> [note, ...] for every image a note body links to.
async function assetUse(uid) {
  const used = new Map();
  for (const e of await noteIndex(uid)) {
    for (const m of e.body.matchAll(ASSET_REF)) {
      const l = used.get(m[1]) || used.set(m[1], []).get(m[1]);
      if (!l.includes(e.rel)) l.push(e.rel);
    }
  }
  return used;
}

app.get('/api/notes/assets', can('notes:write'), wrap(async (req) => {
  const [files, used] = await Promise.all([assetFiles(req.user.id), assetUse(req.user.id)]);
  return {
    files: files.map((f) => ({ name: f.name, bytes: f.bytes, modified: new Date(f.mtimeMs).toISOString(), usedBy: used.get(f.name) || [] })),
    totalBytes: files.reduce((n, f) => n + f.bytes, 0),
    count: files.length,
    limits: { files: ASSET_MAX_FILES, bytes: ASSET_MAX_BYTES },
  };
}));

app.post('/api/notes/assets/prune', can('notes:write'), sameOrigin, wrap((req) =>
  oneAtATime(req.user.id, async () => {
    const uid = req.user.id;
    const used = await assetUse(uid);
    const cutoff = Date.now() - PRUNE_MIN_AGE_MS;
    let removed = 0, freedBytes = 0;
    for (const f of await assetFiles(uid)) {
      if (used.has(f.name) || f.mtimeMs > cutoff) continue;
      if (await fs.rm(path.join(assetDir(uid), f.name), { force: true }).then(() => true, () => false)) { removed++; freedBytes += f.bytes; }
    }
    return { removed, freedBytes };
  })));

app.delete('/api/notes/assets/:name', can('notes:write'), sameOrigin, wrap((req) =>
  oneAtATime(req.user.id, async () => {
    const name = req.params.name;
    if (!ASSET_NAME.test(name)) throw fail(404, 'not found');
    const abs = path.join(assetDir(req.user.id), name);
    const st = await fs.lstat(abs).catch(() => null);
    if (!st?.isFile()) throw fail(404, 'not found');
    const wasUsedBy = (await assetUse(req.user.id)).get(name) || [];
    await fs.rm(abs, { force: true });
    return { ok: true, wasUsedBy };
  })));

app.get('/api/notes/*', can('notes:read'), wrap(async (req) => {
  const name = notePath(req.params[0]);
  const body = await fs.readFile(noteFile(req.user.id, name), 'utf8').catch(() => '');
  const entries = await noteIndex(req.user.id);
  return { name, body, tags: parseNote(body).tags, backlinks: backlinksOf(entries, name) };
}));

app.put('/api/notes/*', can('notes:write'), wrap(async (req) => {
  const name = notePath(req.params[0]);
  const abs = noteFile(req.user.id, name);
  const body = String(req.body?.body ?? '');
  if ((await fs.stat(abs).catch(() => null))?.isDirectory()) throw fail(409, 'a folder with that name already exists');
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, 'utf8');
  await indexNote(req.user.id, name, body);
  return { name, saved: Date.now() };
}));

app.delete('/api/notes/*', can('notes:write'), wrap(async (req) => {
  const name = notePath(req.params[0]);
  await fs.rm(noteFile(req.user.id, name), { force: true });
  noteIdx.get(req.user.id)?.delete(name);
  await pruneFolders(req.user.id, name);
  return { ok: true };
}));

/* ---------- Note images (pasted uploads, private per person) ---------- */

// Per person: enough for a long-lived notebook, small enough that one account cannot fill the disk.
const ASSET_MAX_FILES = 200;
const ASSET_MAX_BYTES = 200 * 1024 * 1024;
const UPLOADS_PER_MIN = 30;

// Belt and braces on top of SameSite=Lax: a browser says where a request came from, and a
// mutating one from another site is refused. Clients that send neither header (curl, tests) pass.
function sameOrigin(req, res, next) {
  const site = req.headers['sec-fetch-site'];
  const origin = req.headers.origin;
  const hostOk = (() => { try { return !origin || origin === RP_ORIGIN || new URL(origin).host === req.headers.host; } catch { return false; } })();
  if ((site && site !== 'same-origin' && site !== 'none') || !hostOk) {
    return res.status(403).json({ error: 'cross-site upload refused' });
  }
  next();
}

// ponytail: in-memory sliding window, reset on restart; keys are per person so it is bounded
// by headcount. Counts failed attempts too, so probing with junk is throttled as well.
const uploadLog = new Map();
function uploadGate(req, res, next) {
  const now = Date.now();
  const recent = (uploadLog.get(req.user.id) || []).filter((t) => now - t < 60_000);
  if (recent.length >= UPLOADS_PER_MIN) {
    uploadLog.set(req.user.id, recent);
    return res.status(429).json({ error: 'too many uploads — wait a minute' });
  }
  recent.push(now);
  uploadLog.set(req.user.id, recent);
  next();
}

// Quota check and write must not interleave for one person, or two parallel pastes both pass it.
const uploadChain = new Map();
const oneAtATime = (uid, fn) => {
  const run = (uploadChain.get(uid) || Promise.resolve()).then(fn);
  uploadChain.set(uid, run.catch(() => {}));
  return run;
};

app.post('/api/notes/assets', can('notes:write'), sameOrigin, uploadGate,
  express.raw({ type: 'image/*', limit: IMG_MAX_BYTES }),
  wrap(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      // Only a real image/<subtype> with no body is "empty"; "image/*" or a missing type is the wrong header.
      throw /^image\/[a-z0-9][a-z0-9.+-]*$/i.test((req.headers['content-type'] || '').split(';')[0].trim())
        ? fail(400, 'empty upload') : fail(415, 'send the raw image with an image/png, image/jpeg, image/gif or image/webp Content-Type');
    }
    // Declared type is a hint; the bytes decide. Anything that is not exactly one of four
    // raster formats (SVG, HTML, BMP, AVIF, polyglots with a bad trailer) is refused.
    const info = sniffImage(req.body);
    if (!info) throw fail(415, 'only png, jpeg, gif and webp images are accepted');
    const why = badDims(info);
    if (why) throw fail(400, why);
    let bytes = req.body;
    if (info.ext === 'jpg') {
      bytes = stripJpegMeta(bytes);
      if (!bytes) throw fail(400, 'corrupt jpeg');
    }

    const dir = assetDir(req.user.id);
    return oneAtATime(req.user.id, async () => {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      let files = 0, total = 0;
      for (const n of await fs.readdir(dir).catch(() => [])) {
        if (!ASSET_NAME.test(n)) continue;
        const st = await fs.stat(path.join(dir, n)).catch(() => null);
        if (st) { files++; total += st.size; }
      }
      if (files >= ASSET_MAX_FILES || total + bytes.length > ASSET_MAX_BYTES) {
        throw fail(507, `image storage is full (${ASSET_MAX_FILES} files / ${ASSET_MAX_BYTES >> 20} MB) — free space with "Clean unused images" in Notes`);
      }
      const id = crypto.randomBytes(16).toString('hex');
      const name = `${id}.${info.ext}`;
      const tmp = path.join(dir, `.${id}.tmp`);
      try {
        await fs.writeFile(tmp, bytes, { flag: 'wx', mode: 0o600 });
        await fs.rename(tmp, path.join(dir, name));
      } catch (e) {
        await fs.rm(tmp, { force: true });
        throw e;
      }
      res.status(201);
      return { id, name, url: `/notes/assets/${name}`, bytes: bytes.length, type: info.type };
    });
  }));

// Outside /api so <img> can load it, which means the gate above does not cover it: the session
// is checked here. The name is matched against an exact shape before it touches the disk, and
// is only ever resolved inside the caller's own folder, so another person's id is simply a 404.
app.get('/notes/assets/:name', (req, res) => {
  const found = sessionUser(sidOf(req));
  if (!found) return res.status(401).json({ error: 'not authenticated' });
  if (!allows(found.user, 'notes:read')) return res.status(403).json({ error: 'not allowed — needs notes:read' });
  const name = req.params.name;
  const dir = path.resolve(assetDir(found.user.id));
  const abs = path.resolve(dir, name);
  const miss = () => res.status(404).json({ error: 'not found' });
  if (req.path.endsWith('/')) return miss(); // one canonical URL per image
  if (!ASSET_NAME.test(name) || !abs.startsWith(dir + path.sep)) return miss();
  fs.lstat(abs).then(async (st) => {
    if (!st.isFile() || st.isSymbolicLink()) return miss();
    const body = await fs.readFile(abs);
    res.set({
      // Fixed by extension, never by content: the file can only ever be served as an image.
      'Content-Type': IMG_MIME[name.split('.')[1]],
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'none'; sandbox",
      'Content-Disposition': 'inline',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      // Ids are never reused, so the bytes behind one never change.
      'Cache-Control': 'private, max-age=31536000, immutable',
      ETag: `"${name.split('.')[0]}"`,
    });
    res.send(body); // also answers If-None-Match with 304, and HEAD without a body
  }).catch(miss);
});

/* ---------- Spotify ---------- */

app.get('/api/spotify', can('music:read'), wrap(async (req) => {
  if (!tokens[req.user.id]?.spotify) throw fail(428, 'spotify not connected'); // the catches below must not hide this
  const [now, recent] = await Promise.all([
    api(req.user.id, 'spotify', '/v1/me/player/currently-playing').catch(() => ({})),
    api(req.user.id, 'spotify', '/v1/me/player/recently-played?limit=12').catch(() => ({ items: [] })),
  ]);
  return { now, recent: recent.items || [] };
}));

app.get('/api/spotify/playlists', can('music:read'), wrap(async (req) => {
  // Knowing who we are is what tells an owned playlist from a followed one. If this call is
  // refused we simply cannot mark ownership, which is a worse hint but not an error.
  const [r, self] = await Promise.all([
    api(req.user.id, 'spotify', '/v1/me/playlists?limit=50'),
    api(req.user.id, 'spotify', '/v1/me').catch(() => ({})),
  ]);
  return (r.items || []).map((p) => ({
    id: p.id,
    uri: p.uri,
    name: p.name,
    owner: p.owner?.display_name || '',
    // Development Mode only serves the contents of playlists you own or collaborate on.
    mine: self.id ? p.owner?.id === self.id : null,
    collaborative: !!p.collaborative,
    tracks: p.tracks?.total ?? 0,
    image: p.images?.at(-1)?.url || '',
  }));
}));

// Spotify's February/March 2026 migration replaced /playlists/{id}/tracks with
// /playlists/{id}/items and renamed the wrapper field `track` to `item`. The old path now
// returns 403 for apps in Development Mode.
//
// The name, image and uri already came back with the playlist list, so this only fetches
// the contents.
app.get('/api/spotify/playlists/:id', can('music:read'), wrap(async (req) => {
  const id = encodeURIComponent(req.params.id);

  // In Development Mode this endpoint only serves playlists the user owns or collaborates on.
  // Spotify signals the refusal two different ways depending on the playlist: a 403, or a 200
  // with the `items` field simply absent. Both mean "not yours", which is a permission answer
  // rather than a failure, and reads very differently to the person looking at it.
  const page = await api(req.user.id, 'spotify', `/v1/playlists/${id}/items?limit=100`)
    .catch((e) => { if (e.status === 403) return {}; throw e; });

  if (!page.items) return { id: req.params.id, tracks: [], readable: false };

  return {
    id: req.params.id,
    readable: true,
    // `item` is the new name; the old `track` is kept as a fallback while the rename lands.
    // Local files and removed entries arrive null or without a uri to play.
    tracks: page.items.map((i) => i.item ?? i.track).filter((t) => t?.uri).map((t) => ({
      uri: t.uri,
      name: t.name,
      artists: (t.artists || []).map((a) => a.name).join(', '),
      album: t.album?.name || '',
      image: t.album?.images?.at(-1)?.url || '',
      ms: t.duration_ms,
    })),
  };
}));

// Playing a track inside its playlist context (rather than on its own) is what lets the
// queue continue with the rest of the playlist afterwards.
app.put('/api/spotify/play', can('music:control'), wrap(async (req) => {
  const uri = String(req.body?.uri || '');
  const context = String(req.body?.context || '');
  if (!/^spotify:track:[A-Za-z0-9]+$/.test(uri)) throw fail(400, 'bad track uri');

  const body = /^spotify:playlist:[A-Za-z0-9]+$/.test(context)
    ? { context_uri: context, offset: { uri } }
    : { uris: [uri] };

  await api(req.user.id, 'spotify', '/v1/me/player/play', { method: 'PUT', body: JSON.stringify(body) });
  return { ok: true };
}));

const CONTROLS = {
  play: ['PUT', '/v1/me/player/play'],
  pause: ['PUT', '/v1/me/player/pause'],
  next: ['POST', '/v1/me/player/next'],
  previous: ['POST', '/v1/me/player/previous'],
};

app.post('/api/spotify/:cmd', can('music:control'), wrap(async (req) => {
  const c = CONTROLS[req.params.cmd];
  if (!c) throw fail(400, 'unknown command');
  await api(req.user.id, 'spotify', c[1], { method: c[0] });
  return { ok: true };
}));

/* ---------- GitHub (per-user OAuth App connection) ---------- */

const EVENT_TYPES = ['PushEvent', 'PullRequestEvent', 'IssuesEvent', 'CreateEvent', 'ReleaseEvent'];

async function githubSummary(uid) {
  const user = await api(uid, 'github', '/user');
  const [repos, events, prs] = await Promise.all([
    api(uid, 'github', '/user/repos?sort=pushed&per_page=10&affiliation=owner,collaborator'),
    api(uid, 'github', `/users/${user.login}/events?per_page=30`),
    api(uid, 'github', `/search/issues?q=${encodeURIComponent(`is:open is:pr author:${user.login}`)}&per_page=10`),
  ]);
  return {
    user: { login: user.login, avatar: user.avatar_url, url: user.html_url },
    repos: repos.map((r) => ({
      name: r.full_name, url: r.html_url, desc: r.description, lang: r.language,
      stars: r.stargazers_count, pushed: r.pushed_at, private: r.private,
    })),
    events: events
      .filter((e) => EVENT_TYPES.includes(e.type))
      .slice(0, 12)
      .map((e) => ({
        type: e.type.replace('Event', ''),
        repo: e.repo.name,
        at: e.created_at,
        detail: e.payload.commits?.[0]?.message || e.payload.pull_request?.title
          || e.payload.issue?.title || e.payload.ref || '',
      })),
    prs: (prs.items || []).map((p) => ({
      title: p.title, url: p.html_url, at: p.updated_at,
      repo: p.repository_url.split('/').slice(-2).join('/'),
    })),
  };
}

app.get('/api/github', can('github:read'), wrap((req) => githubSummary(req.user.id)));
const githubCached = (uid) => memo(`github:${uid}`, 120_000, () => githubSummary(uid));

/* ---------- Search (command palette) ---------- */

const top = (a) => a.slice(0, 8);

app.get('/api/search', wrap(async (req) => {
  const q = String(req.query.q || '').trim();
  const out = { tasks: [], notes: [], files: [], repos: [], prs: [] };
  if (q.length < 2) return out;
  const uid = req.user.id;

  const sources = {
    tasks: async () => {
      const all = await memo(`tasks:${uid}`, 60_000, () => listTasks(uid));
      out.tasks = top(all.filter((t) => matches(t.title, q)).map((t) => ({ id: t.id, title: t.title, start: t.start, done: t.done })));
    },
    notes: async () => {
      const entries = await noteIndex(uid);
      const bodyOf = new Map(entries.map((e) => [e.rel, e.body]));
      const term = q.replace(/^#/, '');
      // Only a hint ever leaves the server, never the whole note.
      out.notes = top(filterNotes(entries, { q }).map((r) => ({
        name: r.name,
        snippet: r.snippet
          ?? (r.tags.find((t) => matches(t, term)) ? `#${r.tags.find((t) => matches(t, term))}` : null)
          ?? bodyOf.get(r.name).slice(0, 80).replace(/\s+/g, ' ').trim(),
      })));
    },
    drive: async () => {
      const term = driveTerm(q);
      if (!term) return;
      const p = new URLSearchParams({
        q: `name contains '${term}' and trashed = false`,
        pageSize: '8',
        fields: 'files(id,name,mimeType,webViewLink)',
      });
      const r = await api(uid, 'google', `/drive/v3/files?${p}`);
      out.files = top((r.files || []).map((f) => ({ id: f.id, name: f.name, webViewLink: f.webViewLink, folder: f.mimeType === FOLDER })));
    },
    github: async () => {
      const gh = await githubCached(uid);
      out.repos = top(gh.repos.filter((r) => matches(r.name, q) || matches(r.desc, q)).map((r) => ({ name: r.name, url: r.url })));
      out.prs = top(gh.prs.filter((p) => matches(p.title, q) || matches(p.repo, q)).map((p) => ({ title: p.title, url: p.url, repo: p.repo })));
    },
  };

  // A source that is unconnected, refused or down just contributes nothing.
  await Promise.allSettled(searchSources(req.user).map((s) => sources[s]()));
  return out;
}));

/* ---------- Inbox (what needs attention, across tasks / Linear / GitHub) ---------- */

async function buildInbox(user) {
  const uid = user.id;
  const today = ymd(user.timezone);
  const items = [];
  const warnings = [];
  const linked = new Set(); // Linear issues already represented by a task
  const add = (it, review = false) => items.push({ ...it, score: inboxScore({ ...it, review }, today) });

  // Sources run in parallel; Tasks fills `linked` itself, and the Linear/GitHub results are
  // only folded in afterwards, so dedupe sees every task regardless of timing.
  const jobs = [
    ['Google Tasks', async () => {
      for (const t of await listTasks(uid)) {
        const lid = metaOf(t.id).linearId;
        if (lid) linked.add(lid);
        if (t.done) continue;
        add({
          kind: 'task', id: t.id, title: t.title, url: t.linearUrl || null, due: t.start ? t.start.slice(0, 10) : null,
          priority: t.priority, source: 'google', meta: t.linearKey || 'Task',
        });
      }
    }],
  ];
  if (allows(user, 'projects:read')) {
    jobs.push(['Linear', async () => {
      const d = await linear(uid, `query { viewer { assignedIssues(first: 50, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
        nodes { id identifier title url priority dueDate project { name } state { name } } } } }`);
      return d.viewer.assignedIssues.nodes;
    }]);
  }
  if (allows(user, 'github:read')) {
    jobs.push(['GitHub', async () => {
      const gh = await githubCached(uid);
      const rr = await api(uid, 'github', `/search/issues?q=${encodeURIComponent(`is:open is:pr review-requested:${gh.user.login}`)}&per_page=20`);
      return { gh, rr: rr.items || [] };
    }]);
  }

  const settled = await Promise.allSettled(jobs.map(([, fn]) => fn()));
  settled.forEach((r, i) => {
    const name = jobs[i][0];
    if (r.status === 'rejected') { warnings.push(`${name}: ${r.reason?.message || 'failed'}`); return; }
    if (name === 'Linear') {
      for (const n of r.value) {
        if (linked.has(n.id)) continue;
        add({
          kind: 'issue', id: n.id, key: n.identifier, title: n.title, url: n.url, due: n.dueDate || null,
          priority: prioFromLinear(n.priority), source: 'linear',
          meta: [n.identifier, n.project?.name, n.state?.name].filter(Boolean).join(' · '),
        });
      }
    } else if (name === 'GitHub') {
      const seen = new Set();
      for (const p of r.value.rr) {
        seen.add(p.html_url);
        add({
          kind: 'pr', id: p.html_url, title: p.title, url: p.html_url, due: null, priority: null,
          source: 'github', meta: `${p.repository_url.split('/').slice(-2).join('/')} · review requested`,
        }, true);
      }
      for (const p of r.value.gh.prs) {
        if (seen.has(p.url)) continue;
        add({ kind: 'pr', id: p.url, title: p.title, url: p.url, due: null, priority: null, source: 'github', meta: `${p.repo} · yours` });
      }
    }
  });

  return { items: items.sort(inboxOrder), warnings };
}

app.get('/api/inbox', can('tasks:read', 'tasks:write'), wrap(async (req) => {
  const key = `inbox:${req.user.id}`;
  if (req.query.refresh) drop(key);
  return memo(key, 60_000, () => buildInbox(req.user));
}));

/* ---------- Notifications (in-app feed; the browser polls, nothing is pushed) ---------- */

const NOTIFY_CAPS = ['calendar:read', 'tasks:read', 'tasks:write'];

app.get('/api/notifications', can(...NOTIFY_CAPS), wrap((req) => ({
  settings: getSettings(req.user.id),
  unread: unreadOf(req.user.id),
  items: feedOf(req.user.id),
})));

app.post('/api/notifications/read', can(...NOTIFY_CAPS), wrap(async (req) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((i) => typeof i === 'string') : [];
  return { unread: await markRead(req.user.id, ids) };
}));

app.put('/api/notifications/settings', can(...NOTIFY_CAPS), wrap((req) =>
  setSettings(req.user.id, cleanNotify(req.body))));

// "Delivering" a notification means adding it to the feed. One pass per minute walks the
// people who opted in and have Google connected; each is isolated so one bad token cannot
// starve the rest, and a failing person is skipped for 5 minutes (428 = simply not
// connected, which is not worth retrying or logging).
const failUntil = new Map();
let ticking = false;

async function notifyUser(u, now) {
  const uid = u.id;
  const s = getSettings(uid);
  const tz = u.timezone || undefined;
  const events = allows(u, 'calendar:read')
    ? await memo(`events:2:${uid}`, 120_000, () => fetchEventsWindow(uid, 2)) : [];
  const tasks = allows(u, 'tasks:read', 'tasks:write')
    ? await memo(`tasks:${uid}`, 120_000, () => listTasks(uid)) : [];

  for (const r of dueReminders({ events, tasks, now, leadMin: s.leadMin, tz })) await push(uid, r, now);

  const lastDigestDate = digestDateOf(uid);
  if (digestDue({ settings: s, now, tz, lastDigestDate })) {
    const inbox = await memo(`inbox:${uid}`, 60_000, () => buildInbox(u));
    await push(uid, digestItem({ events, inboxItems: inbox.items, tz, now }), now);
    await setDigestDate(uid, localNow(tz, now).date);
  } else {
    // Past the 6 h window (server was down, or just enabled late): skip today, do not
    // send a "morning" digest in the evening.
    const at = hmToMin(s.digestAt);
    const l = localNow(tz, now);
    if (at !== null && l.date !== lastDigestDate && l.min >= at + 360) await setDigestDate(uid, l.date);
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = new Date();
    for (const u of listUsers()) {
      if (!getSettings(u.id).enabled || !tokens[u.id]?.google || !allows(u, ...NOTIFY_CAPS)) continue;
      if ((failUntil.get(u.id) || 0) > now.getTime()) continue;
      try {
        await notifyUser(u, now);
      } catch (e) {
        if (e.status === 428) continue;
        failUntil.set(u.id, now.getTime() + 5 * 60_000);
        console.warn(`[notify] ${u.name}: ${e.message}`);
      }
    }
  } finally {
    ticking = false;
  }
}

app.use(express.static(path.join(DIR, 'public')));

// Last: body-parser failures (413 too large, 400 malformed) as JSON like every other error,
// and never a stack trace or a disk path.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error('[http]', err.message);
  res.status(status).json({ error: status === 413 ? 'upload too large (images: 5 MB max)' : status < 500 ? err.message : 'server error' });
});

// Behind a proxy, bind to loopback (HOST=127.0.0.1) so the port cannot be reached directly —
// otherwise :3000 is a way in that skips nginx and its rate limit entirely.
const HOST = process.env.HOST || '0.0.0.0';
const srv = app.listen(PORT, HOST, () => console.log(`dash listening on ${HOST}:${srv.address().port} (${BASE_URL})`));
setTimeout(tick, 15_000).unref();
setInterval(tick, 60_000).unref();
