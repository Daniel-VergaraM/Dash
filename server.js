import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { noteName, macFromArp, taskWindow } from './lib.js';
import {
  CAPABILITIES, ROLES, PASSWORD_MIN, initAuth, capsOf, allows, listUsers, getUser, createUser,
  updateUser, deleteUser, signIn, userByMac, startSession, sessionUser, endSession, sessionsOf,
  audit, readAudit, lockedFor, recordFailure, clearFailures,
  addPasskey, removePasskey, passkeysOf, userByPasskey, touchPasskey,
} from './auth.js';
import { initTaskMeta, subtasksOf, setSubtasks, deleteSubtasksFor } from './task-meta.js';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const execFileP = promisify(execFile);
const DIR = import.meta.dirname;
const DATA = path.join(DIR, 'data');
const NOTES = path.join(DATA, 'notes');
const TOKEN_FILE = path.join(DATA, 'tokens.json');
const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

await fs.mkdir(NOTES, { recursive: true });
await initAuth(DATA, process.env.ACCESS_PASSWORD);
await initTaskMeta(DATA);

let tokens = JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8').catch(() => '{}'));
const saveTokens = () => fs.writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2));

const fail = (status, msg) => Object.assign(new Error(msg), { status });
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).then(
    (d) => (res.headersSent ? undefined : res.json(d ?? {})),
    (e) => res.status(e.status || 500).json({ error: e.message }),
  );

/* ---------- OAuth (one helper, two providers) ---------- */

const PROVIDERS = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    api: 'https://www.googleapis.com',
    scope: 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive.readonly',
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
};

const redirectUri = (name) => `${BASE_URL}/auth/${name}/callback`;

async function exchange(name, body) {
  const p = PROVIDERS[name];
  const res = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
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
  tokens[name] = { ...tokens[name], ...j, expires_at: Date.now() + (j.expires_in - 60) * 1000 };
  await saveTokens();
}

// Refreshes if needed and hands back a usable token, so the raw and JSON callers share
// exactly one place that knows about expiry.
async function accessToken(name) {
  const t = tokens[name];
  if (!t) throw fail(428, `${name} not connected`);
  if (Date.now() > t.expires_at) {
    if (!t.refresh_token) throw fail(428, `${name} session expired — reconnect`);
    await exchange(name, { grant_type: 'refresh_token', refresh_token: t.refresh_token });
  }
  return tokens[name].access_token;
}

// For bytes rather than JSON: returns the Response so the body can be streamed.
async function apiRaw(name, pathq) {
  const token = await accessToken(name);
  const res = await fetch(PROVIDERS[name].api + pathq, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw fail(res.status, upstreamError(name, res.status, detail, pathq));
  }
  return res;
}

async function api(name, pathq, opts = {}) {
  const token = await accessToken(name);
  const res = await fetch(PROVIDERS[name].api + pathq, {
    ...opts,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...opts.headers,
    },
  });
  if (res.status === 204) return {};
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw fail(res.status, upstreamError(name, res.status, j, pathq));
  return j;
}

// A bare "403" is useless for telling apart "the token predates this scope" from "Spotify
// will not serve this object". The provider's own message plus the scopes the stored token
// actually carries answers that without guesswork.
function upstreamError(name, status, body, pathq) {
  const said = body.error?.message || body.error_description || body.error || `returned ${status}`;
  let msg = `${name}: ${said}`;
  if (status === 403 || status === 401) {
    const granted = tokens[name]?.scope;
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

const me = (user, session) => ({
  auth: true,
  user: { id: user.id, name: user.name, role: user.role },
  caps: capsOf(user),
  via: session?.via,
  connected: { google: !!tokens.google, spotify: !!tokens.spotify, github: !!process.env.GITHUB_TOKEN, linear: !!tokens.linear },
  configured: { google: !!process.env.GOOGLE_CLIENT_ID, spotify: !!process.env.SPOTIFY_CLIENT_ID, linear: !!process.env.LINEAR_CLIENT_ID },
});

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
app.use(express.json({ limit: '4mb' }));

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

/* ---------- provider connections ---------- */

const status = () => ({
  connected: { google: !!tokens.google, spotify: !!tokens.spotify, github: !!process.env.GITHUB_TOKEN, linear: !!tokens.linear },
  configured: { google: !!process.env.GOOGLE_CLIENT_ID, spotify: !!process.env.SPOTIFY_CLIENT_ID, linear: !!process.env.LINEAR_CLIENT_ID },
});

app.get('/auth/:name', can('connections:manage'), (req, res) => {
  const p = PROVIDERS[req.params.name];
  if (!p) return res.status(404).send('unknown provider');
  if (!process.env[p.id]) return res.status(428).send(`${p.id} is not set in .env`);
  const q = new URLSearchParams({
    client_id: process.env[p.id],
    redirect_uri: redirectUri(req.params.name),
    response_type: 'code',
    scope: p.scope,
    ...p.extra,
  });
  res.redirect(`${p.authUrl}?${q}`);
});

app.get('/auth/:name/callback', can('connections:manage'), wrap(async (req, res) => {
  if (!PROVIDERS[req.params.name]) throw fail(404, 'unknown provider');
  if (req.query.error) throw fail(400, String(req.query.error));
  await exchange(req.params.name, { grant_type: 'authorization_code', code: String(req.query.code || '') });
  await audit('provider-connected', { by: req.user.name, provider: req.params.name });
  res.redirect('/');
}));

app.post('/api/disconnect/:name', can('connections:manage'), wrap(async (req) => {
  delete tokens[req.params.name];
  await saveTokens();
  await audit('provider-disconnected', { by: req.user.name, provider: req.params.name });
  return status();
}));

/* ---------- Tasks + Calendar (tasks ARE calendar events) ---------- */

const CAL = () => encodeURIComponent(process.env.CALENDAR_ID || 'primary');
const eventsUrl = (suffix = '') => `/calendar/v3/calendars/${CAL()}/events${suffix}`;
const TASK_FLAG = { dash: 'task' };

const shape = (e) => ({
  id: e.id,
  title: e.summary || '(no title)',
  notes: e.description || '',
  start: e.start?.dateTime || e.start?.date,
  end: e.end?.dateTime || e.end?.date,
  allDay: !e.start?.dateTime,
  link: e.htmlLink,
  location: e.location || '',
  task: e.extendedProperties?.private?.dash === 'task',
  done: e.extendedProperties?.private?.done === '1',
  priority: e.extendedProperties?.private?.priority || null,
  project: e.extendedProperties?.private?.project || null,
});

const PRIORITIES = ['low', 'med', 'high'];
const cleanPriority = (raw) => (PRIORITIES.includes(raw) ? raw : undefined);

// Shared by /api/events and the project-scoped task routes below, so the window/paging
// query is built in exactly one place.
async function fetchEventsWindow(days) {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const clamped = Math.min(Math.max(Number(days) || 14, 1), 90);
  const q = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: new Date(from.getTime() + clamped * 864e5).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
  });
  const r = await api('google', eventsUrl(`?${q}`));
  return (r.items || []).map(shape);
}

app.get('/api/events', can('calendar:read', 'tasks:read'), wrap(async (req) => {
  const items = await fetchEventsWindow(req.query.days || 14);
  if (req.query.tasks) return items.filter((i) => i.task);
  // Someone with tasks:read but not calendar:read sees only their tasks, never the diary.
  return allows(req.user, 'calendar:read') ? items : items.filter((i) => i.task);
}));

app.post('/api/tasks', can('tasks:write'), wrap(async (req) => {
  const title = String(req.body?.title || '').trim();
  if (!title) throw fail(400, 'title required');
  const { start, end } = taskWindow(req.body?.start, req.body?.minutes);

  const priv = { ...TASK_FLAG };
  const priority = cleanPriority(req.body?.priority);
  if (priority) priv.priority = priority;
  if (req.body?.project) priv.project = String(req.body.project).slice(0, 64);

  return shape(await api('google', eventsUrl(), {
    method: 'POST',
    body: JSON.stringify({
      summary: title,
      description: String(req.body?.notes || ''),
      start: { dateTime: start },
      end: { dateTime: end },
      extendedProperties: { private: priv },
      reminders: { useDefault: true },
    }),
  }));
}));

app.patch('/api/tasks/:id', can('tasks:write'), wrap(async (req) => {
  const id = encodeURIComponent(req.params.id);
  const body = {};

  const touchesPrivate = req.body?.done !== undefined
    || req.body?.priority !== undefined
    || req.body?.project !== undefined;

  if (touchesPrivate) {
    // Google's PATCH replaces extendedProperties.private wholesale rather than merging
    // keys — every field that should survive has to be read first and re-sent whole.
    // ponytail: one extra round-trip per private-field write, no lock against a
    // concurrent writer racing this read; acceptable at single-operator scale, same
    // risk profile as auth.json's non-atomic save().
    const current = await api('google', eventsUrl(`/${id}`));
    const priv = { ...TASK_FLAG, ...current.extendedProperties?.private };

    if (req.body.done !== undefined) priv.done = req.body.done ? '1' : '0';
    if (req.body.priority !== undefined) {
      const p = cleanPriority(req.body.priority);
      if (p) priv.priority = p; else delete priv.priority;
    }
    if (req.body.project !== undefined) {
      if (req.body.project) priv.project = String(req.body.project).slice(0, 64);
      else delete priv.project;
    }
    body.extendedProperties = { private: priv };
  }

  if (req.body?.title) body.summary = String(req.body.title);
  if (req.body?.start) {
    const { start, end } = taskWindow(req.body.start, req.body.minutes);
    Object.assign(body, { start: { dateTime: start }, end: { dateTime: end } });
  }

  return shape(await api('google', eventsUrl(`/${id}`), { method: 'PATCH', body: JSON.stringify(body) }));
}));

app.delete('/api/tasks/:id', can('tasks:write'), wrap(async (req) => {
  await api('google', eventsUrl(`/${encodeURIComponent(req.params.id)}`), { method: 'DELETE' });
  await deleteSubtasksFor(req.params.id);
  return { ok: true };
}));

/* ---------- Projects (Linear — NOT a local store, NOT Calendar-backed) ---------- */

// Linear's whole API is one GraphQL endpoint; errors come back as HTTP 200 with an
// `errors` array, which api()'s res.ok check does not catch, so that's checked here.
async function linear(query, variables) {
  const j = await api('linear', '/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) });
  if (j.errors?.length) throw fail(400, j.errors.map((e) => e.message).join('; '));
  return j.data;
}

const PROJECT_FIELDS = `
  id name description color icon url progress targetDate startDate createdAt archivedAt
  status { id name type color }
  lead { name }
`;

app.get('/api/projects', can('projects:read'), wrap(async (req) => {
  const data = await linear(`query { projects(first: 100, includeArchived: false, orderBy: updatedAt) { nodes { ${PROJECT_FIELDS} } } }`);
  const projects = data.projects.nodes;
  // Stats need a Calendar read, so they're opt-in (?stats=1) and only computed for
  // someone who actually holds tasks:read — projects:read alone doesn't imply it.
  if (!req.query.stats || !allows(req.user, 'tasks:read')) return projects;

  const counts = {};
  for (const t of await fetchEventsWindow(90).catch(() => [])) {
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
    `mutation($id: String!, $input: ProjectUpdateInput!) { projectUpdate(id: $id, input: $input) { success project { ${PROJECT_FIELDS} } } }`,
    { id: req.params.id, input },
  );
  if (!data.projectUpdate.success) throw fail(502, 'Linear rejected the update');
  return data.projectUpdate.project;
}));

app.delete('/api/projects/:id', can('projects:write'), wrap(async (req) => {
  const data = await linear(`mutation($id: String!) { projectDelete(id: $id) { success } }`, { id: req.params.id });
  if (!data.projectDelete.success) throw fail(502, 'Linear rejected the delete');
  return { ok: true };
}));

app.get('/api/projects/:id/tasks', can('tasks:read'), wrap(async (req) => {
  const items = await fetchEventsWindow(req.query.days || 90);
  return items.filter((i) => i.task && i.project === req.params.id);
}));

app.get('/api/linear/teams', can('projects:read'), wrap(async () => {
  const data = await linear(`query { teams(first: 100) { nodes { id name } } }`);
  return data.teams.nodes;
}));

app.get('/api/linear/statuses', can('projects:read'), wrap(async () => {
  const data = await linear(`query { projectStatuses(first: 50) { nodes { id name type color } } }`);
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
  const term = String(req.query.q || '').trim().split(/[^ 0-9a-zA-Z._-]/).join('');
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

  const files = (await api('google', `/drive/v3/files?${q}`)).files || [];
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
  const meta = await api('google', `/drive/v3/files/${id}?fields=name,mimeType`);

  // Google-native docs have no bytes to download; they have to be exported to a real format.
  const exportAs = GOOGLE_EXPORT[meta.mimeType];
  const upstream = exportAs
    ? await apiRaw('google', `/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exportAs)}`)
    : await apiRaw('google', `/drive/v3/files/${id}?alt=media`);

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

/* ---------- Notes (markdown + latex, plain files on disk) ---------- */

app.get('/api/notes', can('notes:read'), wrap(async () => {
  const names = (await fs.readdir(NOTES)).filter((n) => n.endsWith('.md'));
  const stats = await Promise.all(names.map(async (name) => ({
    name,
    modified: (await fs.stat(path.join(NOTES, name))).mtimeMs,
  })));
  return stats.sort((a, b) => b.modified - a.modified);
}));

app.get('/api/notes/:name', can('notes:read'), wrap(async (req) => ({
  name: noteName(req.params.name),
  body: await fs.readFile(path.join(NOTES, noteName(req.params.name)), 'utf8').catch(() => ''),
})));

app.put('/api/notes/:name', can('notes:write'), wrap(async (req) => {
  const name = noteName(req.params.name);
  await fs.writeFile(path.join(NOTES, name), String(req.body?.body ?? ''), 'utf8');
  return { name, saved: Date.now() };
}));

app.delete('/api/notes/:name', can('notes:write'), wrap(async (req) => {
  await fs.rm(path.join(NOTES, noteName(req.params.name)), { force: true });
  return { ok: true };
}));

/* ---------- Spotify ---------- */

app.get('/api/spotify', can('music:read'), wrap(async () => {
  if (!tokens.spotify) throw fail(428, 'spotify not connected'); // the catches below must not hide this
  const [now, recent] = await Promise.all([
    api('spotify', '/v1/me/player/currently-playing').catch(() => ({})),
    api('spotify', '/v1/me/player/recently-played?limit=12').catch(() => ({ items: [] })),
  ]);
  return { now, recent: recent.items || [] };
}));

app.get('/api/spotify/playlists', can('music:read'), wrap(async () => {
  // Knowing who we are is what tells an owned playlist from a followed one. If this call is
  // refused we simply cannot mark ownership, which is a worse hint but not an error.
  const [r, self] = await Promise.all([
    api('spotify', '/v1/me/playlists?limit=50'),
    api('spotify', '/v1/me').catch(() => ({})),
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
  const page = await api('spotify', `/v1/playlists/${id}/items?limit=100`)
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

  await api('spotify', '/v1/me/player/play', { method: 'PUT', body: JSON.stringify(body) });
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
  await api('spotify', c[1], { method: c[0] });
  return { ok: true };
}));

/* ---------- GitHub (PAT — no OAuth dance needed for a personal dashboard) ---------- */

async function gh(p) {
  if (!process.env.GITHUB_TOKEN) throw fail(428, 'GITHUB_TOKEN not set in .env');
  const res = await fetch('https://api.github.com' + p, {
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dash',
    },
  });
  const j = await res.json();
  if (!res.ok) throw fail(res.status, j.message || `github ${res.status}`);
  return j;
}

const EVENT_TYPES = ['PushEvent', 'PullRequestEvent', 'IssuesEvent', 'CreateEvent', 'ReleaseEvent'];

app.get('/api/github', can('github:read'), wrap(async () => {
  const user = await gh('/user');
  const [repos, events, prs] = await Promise.all([
    gh('/user/repos?sort=pushed&per_page=10&affiliation=owner,collaborator'),
    gh(`/users/${user.login}/events?per_page=30`),
    gh(`/search/issues?q=${encodeURIComponent(`is:open is:pr author:${user.login}`)}&per_page=10`),
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
}));

app.use(express.static(path.join(DIR, 'public')));

// Behind a proxy, bind to loopback (HOST=127.0.0.1) so the port cannot be reached directly —
// otherwise :3000 is a way in that skips nginx and its rate limit entirely.
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => console.log(`dash listening on ${HOST}:${PORT} (${BASE_URL})`));
