import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { noteName, macFromArp, taskWindow } from './lib.js';
import {
  CAPABILITIES, ROLES, initAuth, capsOf, allows, listUsers, getUser, createUser, updateUser,
  deleteUser, userByCode, userByMac, startSession, sessionUser, endSession, sessionsOf,
  audit, readAudit, lockedFor, recordFailure, clearFailures, validCode,
} from './auth.js';

const execFileP = promisify(execFile);
const DIR = import.meta.dirname;
const DATA = path.join(DIR, 'data');
const NOTES = path.join(DATA, 'notes');
const TOKEN_FILE = path.join(DATA, 'tokens.json');
const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

await fs.mkdir(NOTES, { recursive: true });
await initAuth(DATA, process.env.ACCESS_CODE);

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
    scope:
      'user-read-currently-playing user-read-playback-state user-modify-playback-state user-read-recently-played',
    extra: {},
    id: 'SPOTIFY_CLIENT_ID',
    secret: 'SPOTIFY_CLIENT_SECRET',
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

async function api(name, pathq, opts = {}) {
  const t = tokens[name];
  if (!t) throw fail(428, `${name} not connected`);
  if (Date.now() > t.expires_at) {
    if (!t.refresh_token) throw fail(428, `${name} session expired — reconnect`);
    await exchange(name, { grant_type: 'refresh_token', refresh_token: t.refresh_token });
  }
  const res = await fetch(PROVIDERS[name].api + pathq, {
    ...opts,
    headers: {
      authorization: `Bearer ${tokens[name].access_token}`,
      'content-type': 'application/json',
      ...opts.headers,
    },
  });
  if (res.status === 204) return {};
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw fail(res.status, j.error?.message || j.error || `${name} returned ${res.status}`);
  return j;
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
  connected: { google: !!tokens.google, spotify: !!tokens.spotify, github: !!process.env.GITHUB_TOKEN },
  configured: { google: !!process.env.GOOGLE_CLIENT_ID, spotify: !!process.env.SPOTIFY_CLIENT_ID },
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

app.post('/api/login', wrap(async (req, res) => {
  const ip = clientIp(req);
  const wait = lockedFor(ip);
  if (wait) throw fail(429, `Too many attempts — try again in ${Math.ceil(wait / 60)} min.`);

  const code = String(req.body?.code ?? '');
  const user = validCode(code) ? await userByCode(code) : null;
  if (!user) {
    recordFailure(ip);
    await audit('signin-failed', { ip });
    throw fail(401, 'Wrong code');
  }
  clearFailures(ip);
  await setSession(res, user, 'code', ip);
  await audit('signin', { userId: user.id, name: user.name, via: 'code', ip });
  return me(user, { via: 'code' });
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
  connected: { google: !!tokens.google, spotify: !!tokens.spotify, github: !!process.env.GITHUB_TOKEN },
  configured: { google: !!process.env.GOOGLE_CLIENT_ID, spotify: !!process.env.SPOTIFY_CLIENT_ID },
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
});

app.get('/api/events', can('calendar:read', 'tasks:read'), wrap(async (req) => {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90);
  const q = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: new Date(from.getTime() + days * 864e5).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
  });
  const r = await api('google', eventsUrl(`?${q}`));
  const items = (r.items || []).map(shape);
  if (req.query.tasks) return items.filter((i) => i.task);
  // Someone with tasks:read but not calendar:read sees only their tasks, never the diary.
  return allows(req.user, 'calendar:read') ? items : items.filter((i) => i.task);
}));

app.post('/api/tasks', can('tasks:write'), wrap(async (req) => {
  const title = String(req.body?.title || '').trim();
  if (!title) throw fail(400, 'title required');
  const { start, end } = taskWindow(req.body?.start, req.body?.minutes);
  return shape(await api('google', eventsUrl(), {
    method: 'POST',
    body: JSON.stringify({
      summary: title,
      description: String(req.body?.notes || ''),
      start: { dateTime: start },
      end: { dateTime: end },
      extendedProperties: { private: TASK_FLAG },
      reminders: { useDefault: true },
    }),
  }));
}));

app.patch('/api/tasks/:id', can('tasks:write'), wrap(async (req) => {
  const body = {};
  if (req.body?.done !== undefined) {
    body.extendedProperties = { private: { ...TASK_FLAG, done: req.body.done ? '1' : '0' } };
  }
  if (req.body?.title) body.summary = String(req.body.title);
  if (req.body?.start) {
    const { start, end } = taskWindow(req.body.start, req.body.minutes);
    Object.assign(body, { start: { dateTime: start }, end: { dateTime: end } });
  }
  return shape(await api('google', eventsUrl(`/${encodeURIComponent(req.params.id)}`), {
    method: 'PATCH',
    body: JSON.stringify(body),
  }));
}));

app.delete('/api/tasks/:id', can('tasks:write'), wrap(async (req) => {
  await api('google', eventsUrl(`/${encodeURIComponent(req.params.id)}`), { method: 'DELETE' });
  return { ok: true };
}));

/* ---------- Drive ---------- */

app.get('/api/drive', can('drive:read'), wrap(async (req) => {
  const term = String(req.query.q || '').trim().split(/[^ 0-9a-zA-Z._-]/).join('');
  const q = new URLSearchParams({
    q: term ? `name contains '${term}' and trashed = false` : 'trashed = false',
    pageSize: '50',
    orderBy: 'modifiedTime desc',
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink,iconLink,size)',
  });
  return (await api('google', `/drive/v3/files?${q}`)).files || [];
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
