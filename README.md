# Dash

Personal dashboard: tasks, Google Calendar, markdown+LaTeX notes, Google Drive, Spotify, GitHub.
One Express server, one HTML page, no database.

```bash
npm install
cp .env.example .env   # fill it in
npm start              # http://localhost:3000
```

## How it stores things

- **Tasks are calendar events.** A task is a Google Calendar event tagged
  `extendedProperties.private.dash=task`. That is the whole "sync" — no local task table, no
  reconciliation, no drift. Ticking a task sets `done=1` on the same event.
- **Notes are `.md` files** in `data/notes/`. Edit them here or in any editor.
- **Tokens** live in `data/tokens.json`. Delete it to disconnect everything.

Nothing else is persisted, so `data/` is the entire backup surface.

## Authentication and authorisation

People, passwords, passkeys, devices, permissions and sessions live in `data/auth.json`,
managed from the **Access** panel (everyone else's) and the **Account** page (your own).
`ACCESS_PASSWORD` in `.env` is used once, to create the first admin on a cold start; after
that it is ignored. Leave it blank and a random password is printed to the console on first run.

### Getting in

Three routes, all ending at the same session cookie, all identifying *which person* signed in:

- **Name and password** — the password is stored only as a salted scrypt hash and compared in
  constant time. A wrong name is checked against a dummy hash so it takes the same time and
  returns the same message as a wrong password, revealing nothing about who exists. Minimum
  10 characters, no composition rules — length is the only requirement that buys real entropy.
  Five failures from one IP start an escalating lockout (1 min, doubling, capped at an hour).
- **Passkey** (WebAuthn) — fingerprint, face or device PIN, with nothing to type or leak.
  Registered from the Account page; signing in needs no name, because the credential is
  discoverable (`residentKey: required`) and the browser offers the right one for the site.
  Verification uses `@simplewebauthn/server`; the signature counter is stored on every use, so
  a cloned authenticator is detected. Requires HTTPS, or localhost for development.
- **Device MAC** — the server resolves the caller's IP with `arp -a` and matches it against
  that person's registered devices. ARP only sees the local network segment, so this is a
  convenience for LAN devices, not a security boundary. `MAC_LOGIN=false` turns it off, which
  is what the VPS does.

Sessions last 7 days and survive restarts. Suspending or deleting someone ends theirs
immediately. Changing your own password requires the current one, so a stolen session cannot
lock the real owner out.

**Passkeys are bound to the hostname.** The relying-party ID comes from `BASE_URL`, so a
passkey registered against `localhost` will not work on `dash.dvergaram.is-local.org` and vice
versa. Everyone keeps a password as well — an account is never allowed to end up with no way in.

### What people can do

Authorisation is a flat capability list. Every protected route names the capability it needs,
and the same list drives the UI — controls you cannot use are not drawn. **The UI hiding is
cosmetic; the server checks every request regardless.**

| Capability | |
|---|---|
| `tasks:read` / `tasks:write` | see tasks / create, complete and delete them |
| `calendar:read` | see the full agenda (without it, only your tasks are visible) |
| `notes:read` / `notes:write` | read notes / edit and delete them |
| `drive:read` | browse and preview Drive files |
| `music:read` / `music:control` | see what is playing / control playback |
| `github:read` | repositories, PRs and activity |
| `connections:manage` | connect and disconnect Google / Spotify |
| `users:manage` | the Access panel itself |

Managing your own password and passkeys needs no capability — those routes only ever touch
the caller's own credentials.

Three roles bundle these — **admin** (everything), **member** (everything but `users:manage`),
**guest** (read-only) — and any person can instead be given an explicit custom set that
overrides their role.

Two things are structurally impossible: removing the last person who can manage access, and
removing your own `users:manage` while standing in the panel. Sign-ins, failures and every
change to people or connections are appended to `data/audit.log` and shown in the panel.

## Deploying to the VPS

Dash runs as its own compose project, like `pdf-reader` — not inside the `vps/` stack. Caddy
(`dv-site-proxy`) is the only proxy on that host; the `nginx/` config in the vps repo is a
parallel configuration that is not a running service, so nothing was added to it.

```bash
docker compose up -d --build
```

The published port is bound to `172.17.0.1:3000`, the Docker bridge address — so port 3000 is
**not** reachable from the internet and every request has to come through Caddy. The matching
site block lives in `vps/caddy/Caddyfile` under `dash.dvergaram.is-local.org`, and the
subdomain is registered in `vps/subdomains.txt`. Caddy issues and renews the certificate
itself; there is nothing to configure for TLS.

`docker-compose.yml` pins the four settings that deployment depends on — everything else comes
from `.env`:

| | |
|---|---|
| `TRUST_PROXY=loopback, uniquelocal` | Caddy connects from a Docker bridge address, not loopback |
| `HOST=0.0.0.0` | bind inside the container; the port binding is what limits exposure |
| `BASE_URL=https://dash.dvergaram.is-local.org` | OAuth redirect URIs, and a `Secure` session cookie |
| `MAC_LOGIN=false` | ARP cannot see clients arriving over the internet |

**`TRUST_PROXY` is not optional behind a proxy.** Every request would otherwise arrive from the
proxy's address, and the app would read that as the caller — pooling all failed codes into one
lockout bucket, so a single attacker locks everyone out. With it set, Express reads the real
client from `X-Forwarded-For`, trusting the header only from private hops. Left blank the
header is ignored entirely, which is why it must stay blank when nothing sits in front.

Register `https://dash.dvergaram.is-local.org/auth/google/callback` and `/auth/spotify/callback`
as the redirect URIs in the Google and Spotify consoles.

## Connecting the services

`GITHUB_TOKEN` is read from `.env` at startup. Google and Spotify use OAuth: sign in, then
click the greyed-out provider in the sidebar (or hit `/auth/google`, `/auth/spotify`).
Refresh tokens are handled automatically.

Google scopes: `calendar` (read/write, for tasks) and `drive.readonly`.

Spotify scopes now include `playlist-read-private` and `playlist-read-collaborative`.
**A stored token keeps the scopes it was granted**, so after pulling this change you have to
disconnect and reconnect Spotify from the sidebar — otherwise the playlist calls come back 403
and the panel says so. Playback controls, including picking a track, need Premium and an
already-active device (open Spotify somewhere first; this is a remote control, not a player).

Drive opens on My Drive and browses folders in place, with a breadcrumb; the search box looks
across everything instead. Files are shown in the pane beside the list, streamed from the
server, so nothing redirects to Google.

## API

| | |
|---|---|
| `GET /api/events?days=14&tasks=1` | calendar agenda; `tasks=1` filters to tasks |
| `POST /api/tasks` | `{title, start, minutes, notes}` |
| `PATCH /api/tasks/:id` | `{done}` / `{title}` / `{start, minutes}` |
| `DELETE /api/tasks/:id` | |
| `GET /api/notes`, `GET·PUT·DELETE /api/notes/:name` | markdown files |
| `GET /api/drive?folder=&q=` | browse a folder, or search everywhere |
| `GET /api/drive/:id/preview` | streams the file from our own origin |
| `GET /api/spotify`, `POST /api/spotify/:play\|pause\|next\|previous` | |
| `GET /api/spotify/playlists[/:id]` | your playlists and their tracks |
| `PUT /api/spotify/play` | `{uri, context}` — play one track in its playlist |
| `GET /api/github` | repos, open PRs, recent activity |
| `GET·POST·PATCH·DELETE /api/access[/users/:id]` | people, codes, devices, permissions |
| `GET /api/access/device` | the caller's IP and resolved MAC |
| `POST /api/me/password` | `{current, next}` — your own |
| `GET·POST·DELETE /api/passkeys[/:id]` | your own passkeys |
| `POST /api/login/passkey[/options]` | passwordless sign-in |

`npm test` runs the self-check: filename and MAC validation, ARP parsing, scheduling maths,
password hashing, role and capability resolution, passkey storage, and the store end to end
(sessions, suspension, the last-admin guard, rollback on a rejected edit, persistence across
restarts, and migration from the old 6-digit codes).

## Deliberately left out

- No task table, no sync engine — Google Calendar *is* the store.
- No month grid; the calendar is a grouped agenda list. Add a grid if you actually miss it.
- One Google account and one Spotify account for everyone — the connection is shared, the
  permission to use it is per person. Per-person Google accounts would need a token per user.
- Sign-in cost is O(people): scrypt runs once per person until the code matches. Fine below
  ~50 people; prefix codes with a person id if this ever hosts a crowd.
- No password reset flow. An admin sets a new one from the Access panel; with no admin left,
  edit `data/auth.json` directly.
- No second factor on top of a password. A passkey replaces the password rather than adding
  to it — for a personal dashboard that is the right trade.
- The MAC route is off on the VPS and only useful on a LAN — it is a convenience, never a
  security boundary.
- Drive previews stream through the server rather than embedding Google's `/preview` iframe:
  that iframe authenticates with the viewer's own Google cookies, which are third-party inside
  our page and blocked by default in current browsers, so it returned 401. Serving the bytes
  ourselves also means a viewer with `drive:read` needs no Google account at all. Google Docs,
  Sheets and Slides are exported to PDF; there is no `Range` support, so seeking inside a large
  video re-fetches.
- Nothing was added to `vps/nginx/nginx.conf`: it is a parallel config with no running
  container. If nginx ever becomes the live proxy, that block has to be written too.
