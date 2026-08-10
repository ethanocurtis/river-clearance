# River Clearance API

Backend for the River Bridge Clearance app: real email/password accounts
(sessions via an httpOnly cookie), email verification and password reset
over SMTP, per-account vessel sync, and an admin API for editing
`docs/data/bridges.json`/`gauges.json` from the browser instead of
hand-editing files and pushing commits.

Can run two ways:
- **API only** — the frontend stays wherever it already is and just calls
  this over the network.
- **API + the static site together** (see "Serving the whole site from this
  container" below) — this container also serves `docs/`, so the frontend
  and API are same-origin. No CORS, one deployment to manage. This is the
  supported/tested setup.

## What it does

- `POST /api/auth/signup` — create an account (email + password). Sends a
  verification email; the account can't log in until that's clicked. The
  account is created and the response returned before the email finishes
  sending (fire-and-forget) -- a slow/unreachable SMTP server won't hang
  the signup request itself, it just logs a `[signup] Verification email
  failed for ...` line if delivery fails. See "Resend verification email"
  below for recovering an account whose first send didn't go through.
- `GET  /api/auth/verify?token=...` — the emailed verification link. Marks
  the account verified, logs it in, redirects to `/?verified=1` (or
  `/?verify_error=1` on a bad/expired token).
- `POST /api/auth/login` / `POST /api/auth/logout`
- `POST /api/auth/resend-verification` — same anti-enumeration response as
  password reset. Issues a fresh verify token/email for the account (the
  previous one is invalidated), useful if the first signup email never
  arrived (bad SMTP config, spam filter, etc.).
- `GET  /api/auth/me` — current session's user, or 401.
- `POST /api/auth/request-password-reset` — always responds the same
  message whether or not the email exists (doesn't leak registered emails).
  Emails a link to `/?reset_token=...` if it does exist.
- `POST /api/auth/reset-password` — sets a new password from that token,
  invalidates all of that account's existing sessions, and marks the email
  verified (clicking the link proves ownership the same way verifying does).
- `GET /api/vessels` / `PUT /api/vessels` — the logged-in account's saved
  vessels. Requires a session; no more free-text usernames.
- `GET /api/admin/data/:file` / `PUT /api/admin/data/:file` (`:file` is
  `bridges` or `gauges`) — admin-only, reads/writes the actual
  `docs/data/*.json` files directly.
- `GET /healthz`

Passwords are bcrypt-hashed (`bcryptjs`, 12 rounds). Sessions are random
128-bit tokens in a `sessions` table, sent as an httpOnly/secure/SameSite=Lax
cookie. All `/api/auth/*` routes are rate-limited (10 requests/15 min/IP).

## Required setup

Two things this needs to actually work, both in `.env`:

- **`APP_BASE_URL`** — your real public URL, no trailing slash. Verification
  and password-reset links are built from this; without it they're broken.
- **SMTP** (`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`MAIL_FROM`) —
  without these, verification/reset emails are only logged to the console,
  not sent, so nobody can actually verify an account. See "Setting up email"
  below for MXroute specifically.

Optional but useful: **`ADMIN_EMAILS`** — comma-separated emails that get
the admin role automatically on signup. Sign up with one of these to become
the first admin; no separate "create admin" step.

## Setting up email (MXroute or any SMTP provider)

In MXroute's control panel, find the mailbox you want to send from and its
SMTP settings — typically:

```
SMTP_HOST=your-server.mxrouting.net   # the exact host MXroute gives you for that mailbox
SMTP_PORT=465
SMTP_SECURE=true                      # 465 = implicit TLS; if you use 587 instead, set this to false (STARTTLS)
SMTP_USER=you@your-domain.example     # the full mailbox address
SMTP_PASS=your-mailbox-password
MAIL_FROM="River Clearance <you@your-domain.example>"
```

Put these in `.env` (never commit them — `.env` is already gitignored).
Restart the container/service after changing them. Check the logs — on
startup it logs a warning if SMTP isn't configured, and every send attempt
logs an error if it fails (bad credentials, wrong host, etc.).

To test without waiting on a real signup:

```bash
docker compose exec river-clearance-api node -e "
require('./mailer').sendVerificationEmail('you@your-domain.example', 'https://example.com/test').then(r => console.log(r));
"
```

`{ sent: true }` means MXroute accepted it — check the inbox. `{ sent: false }`
means SMTP isn't configured (env vars empty). A thrown error means SMTP *is*
configured but MXroute rejected the attempt — read the error message, it's
usually an auth or host/port mismatch.

## Running it locally

```bash
cd server
npm install
cp .env.example .env    # set APP_BASE_URL=http://localhost:8787 for local testing; SMTP can stay empty (emails just log to console)
npm run dev              # or: npm start
curl http://localhost:8787/healthz
```

## Deploying to your VM

Two options — pick whichever fits how you already run things there.

### Option A: Docker

```bash
cd server
cp .env.example .env
# edit .env: APP_BASE_URL, ADMIN_EMAILS, SMTP_*, ALLOWED_ORIGINS
docker compose up -d --build
curl http://localhost:8787/healthz
```

Data persists in the `river-clearance-data` named volume across restarts/rebuilds.

### Option B: systemd + plain Node

```bash
sudo apt-get update && sudo apt-get install -y nodejs npm build-essential python3
sudo mkdir -p /opt/river-clearance && sudo chown $USER /opt/river-clearance
# copy (or git clone) this repo to /opt/river-clearance
cd /opt/river-clearance/server
npm install --omit=dev
cp .env.example .env    # edit as above
sudo cp river-clearance-api.service /etc/systemd/system/
sudo mkdir -p /var/lib/river-clearance && sudo chown www-data:www-data /var/lib/river-clearance
sudo systemctl daemon-reload
sudo systemctl enable --now river-clearance-api
curl http://localhost:8787/healthz
```

### Putting it behind TLS

Either way, don't expose port 8787 directly to the internet — put a reverse
proxy in front of it with a real cert.

#### Nginx Proxy Manager

Since NPM is itself a Docker container, the cleanest hookup is a shared
Docker network rather than a host-published port:

1. Find NPM's network name: `docker network ls` — look for whatever NPM's
   own compose file calls it.
2. In `server/docker-compose.yml`, uncomment the `networks:` block under
   `river-clearance-api` and the `networks:` block at the bottom of the
   file, replacing `NPM_NETWORK_NAME` with what you found in step 1. You can
   also comment out the `ports:` block at that point — nothing needs to be
   published to the host at all.
3. `docker compose up -d --build`
4. In the NPM web UI → **Proxy Hosts** → **Add Proxy Host**:
   - Domain Names: `your-domain.example`
   - Scheme: `http`
   - Forward Hostname / IP: `river-clearance-api`
   - Forward Port: `8787`
   - SSL tab: request a new Let's Encrypt certificate, enable Force SSL.

If NPM ever can't reach it, `docker network inspect NPM_NETWORK_NAME` should
list both the NPM container and `river-clearance-api`.

#### Plain nginx (no NPM)

See `nginx.conf.example` for a starting point.

### Serving the whole site from this container

This container can serve `docs/` directly — same origin as the API, no CORS
at all. This is the setup `docs/app.js` assumes by default (`API_BASE =
'/api'`, a relative path). The compose file bind-mounts your whole repo
(not just `docs/`) to `/repo`, so this also doubles as the mount `gitSync.js`
needs for admin auto-push (see below) — set `STATIC_DIR` even if you don't
plan to use auto-push, since that's what makes the site available at all.

```bash
cd server
echo "STATIC_DIR=/repo/docs" >> .env
docker compose up -d --build
curl http://localhost:8787/         # should return the site's HTML
```

Point your reverse proxy at this one container for the whole domain — `/`
and `/api/*` alike, no path-based routing rules needed.

Updating the site's content afterward is just `git pull` on the host (the
bind mount picks it up immediately, no rebuild) — only rerun `docker compose
up -d --build` when `server/`'s own code changes.

If you're instead keeping the frontend somewhere separate and only using
this container for the API, leave `STATIC_DIR` unset and set
`docs/app.js`'s `API_BASE` back to an absolute URL:

```js
const API_BASE = 'https://your-api-domain.example/api';
```

## Admin: editing site data from the browser

Log in with an `ADMIN_EMAILS` account and an "Admin: Edit Site Data" section
appears on the site. It's a raw JSON editor (load current content, edit,
save) for `bridges.json`/`gauges.json` — not a form-based table, but no
SSH/manual-edit-and-push needed for a quick fix.

Saves always write directly to `docs/data/*.json` on the VM's filesystem
(via the bind mount) — live on the site immediately. Whether that also
reaches GitHub depends on whether auto-push is configured (below):

- **Configured** — the save also commits and pushes that one file to GitHub
  immediately. The admin panel shows the result ("Saved and pushed to
  GitHub" or, if the push failed, why).
- **Not configured** — saves are file-only, same as before; the VM's copy
  and GitHub's copy will diverge until you manually `git add -A && git
  commit && git push` on the VM.

If you'd rather the admin panel not be able to write into your git working
directory at all, remove the `..:/repo` volume mount in `docker-compose.yml`
and leave `STATIC_DIR`/`DATA_DIR`/`REPO_DIR` unset — the admin data and git
endpoints respond 501 (disabled) instead, everything else (accounts, vessel
sync) keeps working normally, and you'd host `docs/` separately.

### Auto-committing admin edits to GitHub

Requires two things in `.env`:

- **`REPO_DIR=/repo`** — matches the bind mount above. `gitSync.js` runs
  real `git` commands (`add`, `commit`, `push`) against this path, scoped to
  only the one file being saved — it never touches anything else you might
  have modified by hand in the working tree (e.g. `docker-compose.yml`'s
  NPM network block).
- **`GIT_PUSH_TOKEN`** — a GitHub token with write access to this repo. A
  [fine-grained personal access
  token](https://github.com/settings/personal-access-tokens/new) scoped to
  just this one repository, with **Contents: Read and write** permission
  and nothing else, is the least amount of access that works. Generate one,
  copy it once (GitHub won't show it again), and put it in `.env`.

Optional: `GIT_COMMIT_NAME`/`GIT_COMMIT_EMAIL` control the commit author
(defaults to "River Clearance Admin" / `admin@localhost`).

```bash
cd ~/river-clearance/server
cat >> .env << 'EOF'
REPO_DIR=/repo
GIT_PUSH_TOKEN=github_pat_your_token_here
EOF
docker compose up -d --build
docker compose logs --tail 20   # should log "admin edits will auto-commit + push to GitHub"
```

If a push ever fails (most commonly: the VM's branch is behind `origin`
because you pushed other commits since the last `git pull` on the VM), the
file save still succeeds — the admin panel reports the push failure so you
know to `git pull` on the VM and either retry the edit or push manually.
`gitSync.js` never force-pushes or touches any file other than the one being
saved.

## Backing it up

One SQLite file, but note what's in it now: password hashes, emails, and
session tokens, not just vessel air-draft numbers — treat backups
accordingly (don't leave copies somewhere world-readable).

`sqlite3 sync.sqlite3 ".backup backup.sqlite3"` or copy the file while the
WAL is checkpointed (`PRAGMA wal_checkpoint;`).
