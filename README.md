# Dash

Personal dashboard: tasks, Google Calendar, markdown+LaTeX notes, Google Drive, Spotify, GitHub.
One Express server, one HTML page, no database.

```bash
npm install
cp .env.example .env   # fill it in
npm start              # http://localhost:3000
```

## How it stores things

- **Tasks are Google Tasks.** Google is the system of record; there is no local task table.
  Only what its API cannot hold (time of day, duration, priority, project, Linear issue ids,
  subtasks) sits in `data/task-meta.json`, keyed by Google task id.
- **Notes are `.md` files** in `data/notes/<userId>/` — one private folder per person. Edit
  them here or in any editor.
- **Tokens** live in `data/tokens.json`, keyed by user id: each person's Google/Spotify/Linear/
  GitHub connection is their own. Delete the file to disconnect everyone; delete one person's
  entry to disconnect just them.

Nothing else is persisted, so `data/` is the entire backup surface (`DATA_DIR`, default `data`; docker-compose.yml sets `/app/data`, the `dash_data` volume mount).

## Authentication and authorization

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

Authorization is a flat capability list. Every protected route names the capability it needs,
and the same list drives the UI — controls you cannot use are not drawn. **The UI hiding is
cosmetic; the server checks every request regardless.**

| Capability | |
|---|---|
| `tasks:read` / `tasks:write` | see tasks / create, complete and delete them |
| `calendar:read` | see the full agenda (without it, only your tasks are visible) |
| `notes:read` / `notes:write` | read your own notes / edit and delete them |
| `drive:read` | browse and preview your own Drive files |
| `music:read` / `music:control` | see what is playing / control playback |
| `github:read` | your repositories, PRs and activity — admin-only by default |
| `projects:read` / `projects:write` | see / create, edit and delete Linear projects — admin-only by default |
| `users:manage` | the Access panel itself |

Managing your own password, passkeys, and Google/Spotify/Linear/GitHub connections needs no
capability — those routes only ever touch the caller's own credentials and accounts.

Three roles bundle these — **admin** (everything), **member** (everything except managing people
and, by default, GitHub/Linear — grant those to a specific person from Access), **guest**
(read-only, and without GitHub/Linear at all by default) — and any person can instead be given an
explicit custom set that overrides their role.

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

Register `https://dash.dvergaram.is-local.org/auth/google/callback`, `/auth/spotify/callback`,
`/auth/linear/callback`, and `/auth/github/callback` as the redirect URIs in the Google, Spotify,
Linear, and GitHub consoles.

## Connecting the services

Google, Spotify, Linear, and GitHub all use OAuth, and every connection is your own: sign in,
then click the greyed-out provider in the sidebar (or hit `/auth/google`, `/auth/spotify`,
`/auth/linear`, `/auth/github`). Refresh tokens are handled automatically where the provider
issues them (GitHub OAuth Apps don't expire by default, so there's nothing to refresh there).
There is no shared connection — if you haven't connected a service yourself, you see a "Connect"
prompt, never someone else's data.

Google scopes: `calendar` (read/write), `tasks` and `drive.readonly`.

Linear scopes: `read,write`, covering project create/edit/archive. A Linear project always
belongs to at least one team, so creating a project from Dash requires picking one. Projects
are Linear's own entity — Dash proxies CRUD to Linear's GraphQL API rather than storing them
locally; the only local state is which Linear project id (and issue) a task points at.
Edits to a task's title, due date or priority and ticking it done sync to its Linear issue, one way.
Deleting a task leaves the issue alone unless you confirm archiving it; it is archived (reversible
in Linear), never deleted.

**Ctrl/Cmd+K** opens a command palette: jump to a view, add a task, or search tasks, notes,
Drive and GitHub in one box. **Inbox** merges what needs you today — open tasks, issues assigned
to you in Linear and PRs awaiting your review — ranked by due date and priority; an issue not yet
tracked by a task has a *Create task* button that links it instead of filing a new issue.

Spotify scopes now include `playlist-read-private` and `playlist-read-collaborative`.
**A stored token keeps the scopes it was granted**, so after pulling this change you have to
disconnect and reconnect Spotify from the sidebar — otherwise the playlist calls come back 403
and the panel says so. Playback controls, including picking a track, need Premium and an
already-active device (open Spotify somewhere first; this is a remote control, not a player).

Drive opens on My Drive and browses folders in place, with a breadcrumb; the search box looks
across everything instead. Files are shown in the pane beside the list, streamed from the
server, so nothing redirects to Google.

Playlist contents come from `/v1/playlists/{id}/items`. Spotify's February/March 2026 migration
retired `/playlists/{id}/tracks` — it now returns **403 Forbidden** for apps in Development Mode
— and renamed the wrapper field `track` to `item`. That same migration limits playlist contents
to playlists you own or collaborate on: for anyone else's, Spotify returns the metadata with no
`items` field, and the app says so rather than showing an empty list.

## API

| | |
|---|---|
| `GET /api/events?days=14&tasks=1` | calendar agenda; `tasks=1` filters to tasks |
| `POST /api/tasks` | `{title, start, minutes, notes, priority, project, linearIssue}`; `linearIssue: {id, url, key}` links an existing issue instead of filing one |
| `PATCH /api/tasks/:id` | `{done}` / `{title}` / `{start, minutes}` / `{priority}` / `{project}` |
| `DELETE /api/tasks/:id` | `?linear=archive` also archives the linked Linear issue |
| `GET /api/inbox[?refresh=1]` | tasks, assigned Linear issues and review-requested PRs, ranked |
| `GET /api/search?q=` | command-palette search across the sources you may read |
| `GET·PUT /api/tasks/:id/subtasks` | checklist per task; `PUT` replaces the whole list |
| `GET /api/projects?stats=1` | Linear projects; `stats=1` adds `{total, done}` from your tasks |
| `POST /api/projects` | `{name, teamIds, color, description, statusId, targetDate}` — proxies to Linear |
| `PATCH·DELETE /api/projects/:id` | edit / soft-delete (trash) a Linear project |
| `GET /api/projects/:id/tasks` | this app's tasks tagged with that Linear project |
| `GET /api/linear/teams`, `GET /api/linear/statuses` | pickers for the project create/edit form |
| `GET /api/notes?q=&tag=&folder=` | your markdown files; `q` searches names and bodies by relevance |
| `GET·PUT·DELETE /api/notes/<folder/>name` | one note; `GET` also returns `tags` and `backlinks` |
| `POST /api/notes/rename` | `{from, to}` — moves a note and rewrites `[[links]]` to it; `404`/`409` on missing/taken |
| `GET /api/notifications` | `{settings, unread, items}` — the in-app feed (reminders and the daily digest) |
| `POST /api/notifications/read` | `{ids?}` — mark some, or with none all, as read |
| `PUT /api/notifications/settings` | `{enabled, digestAt, leadMin}` |
| `GET /api/drive?folder=&q=` | browse a folder, or search everywhere, in your own Drive |
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

## Quick capture

Press `c` (when not typing), or pick **Quick add** in the Ctrl+K palette, and type one line. A live preview shows what was understood; Enter creates the task. Needs `tasks:write`.

```
mañana 3pm revisar PR !dash p1 30m
```

- **Date**: `hoy/today`, `mañana/tomorrow`, `pasado mañana`, a weekday (`viernes`, `next friday`: always strictly in the future), `en 3 días` / `in 2 weeks`, `2026-12-31`, `25/12` or `25-12` (next year if already passed; `29/2` rolls to the next leap year). An impossible date (`31/2`) stays in the title with a warning.
- **Time**: `3pm`, `3:30pm`, `15:00`, `15h`, `a las 15`, `at 3pm`. A time without a date means today, or tomorrow if it already passed in your timezone. No time means an all-day task.
- **Project**: `!name`, matched by prefix against your Linear projects (shortest match wins); an unknown one is dropped with a warning.
- **Priority**: `p1` high, `p2` medium, `p3` low. **Duration**: `30m`, `1h`, `45min`, `1.5h` (5 min to 24 h); a whole number from 9 to 23 followed by `h` (`15h`) is a time of day, not a duration (`horas`/`hours` always mean duration).
- Spanish or English, any case, accents optional, tokens anywhere; the rest is the title. `"quoted text"` is kept literally. Only the first of each token counts.

`GET /api/quick/parse?text=` returns the interpretation without writing anything; `POST /api/tasks/quick` with `{ "text": "..." }` parses on the server and creates the task, answering `{ task, parsed }`. Text is limited to 300 characters.

## Notifications and notes

**Notifications.** The bell in the sidebar lists reminders (a few minutes before a timed event or
task) and an optional daily digest. Alerts are in-app, plus the browser Notification API once you
press "Enable browser alerts" in Account; there is no push, so they only fire while a tab is open
(it polls every minute while visible). Lead time, digest time and the on/off switch live in
Account. Needs `calendar:read`, `tasks:read` or `tasks:write`.

**Notes.** Notes are plain `.md` files and may live in folders: name a note `folder/name`. Tags
are `#tags` in the text or `tags:` in YAML frontmatter, and filter the list. `[[other note]]`
(also `[[note|alias]]`, `[[note#section]]`) links notes and feeds each note's Backlinks panel.
The search box matches names and bodies. Rename / move rewrites the `[[links]]` that pointed at
the old name.

## Deliberately left out

- No task table, no sync engine — Google Calendar *is* the store.
- No month grid; the calendar is a grouped agenda list. Add a grid if you actually miss it.
- No shared connections. Google, Spotify, Linear, and GitHub are each person's own account —
  this used to be one shared account per service for everyone, deliberately reversed so every
  person's calendar, notes, playback, and repos are actually theirs.
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
