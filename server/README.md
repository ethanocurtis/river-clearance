# River Clearance Sync API

A tiny backend so a vessel's saved air draft/margin follows a username
across devices. **This is not real authentication** — a username has no
password, so it's whatever the app's front page already told you it would
be: a placeholder until this site has real hosting and real accounts. Don't
put anything in a username or vessel name you wouldn't want another visitor
who happens to type the same username to see.

Not deployed anywhere yet — this exists so it's ready the moment you move
the site off GitHub Pages. Until `docs/app.js`'s `SYNC_API_BASE` points at a
real URL, the frontend's sync UI stays hidden and the static site works
exactly as it does today.

## What it does

One table, one JSON blob per username:

- `GET  /api/sync/:username` — fetch that username's saved vessels (`404` if none saved yet — normal for a first-time username, not an error to alarm over)
- `PUT  /api/sync/:username` — replace that username's saved vessels wholesale
- `DELETE /api/sync/:username` — forget that username's data
- `GET  /healthz` — for your process manager / uptime checks

Usernames: `[a-z0-9_-]{3,32}`, case-insensitive (stored lowercase).

## Running it locally

```bash
cd server
npm install
cp .env.example .env    # defaults are fine for local testing
npm run dev              # or: npm start
curl http://localhost:8787/healthz
```

## Deploying to your VM

Two options — pick whichever fits how you already run things there.

### Option A: Docker

```bash
cd server
cp .env.example .env
# edit ALLOWED_ORIGINS in .env to your real frontend origin(s) once you know them
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
cp .env.example .env    # edit DB_PATH/ALLOWED_ORIGINS as needed
sudo cp river-clearance-api.service /etc/systemd/system/
sudo mkdir -p /var/lib/river-clearance && sudo chown www-data:www-data /var/lib/river-clearance
sudo systemctl daemon-reload
sudo systemctl enable --now river-clearance-api
curl http://localhost:8787/healthz
```

### Putting it behind TLS

Either way, don't expose port 8787 directly to the internet — put nginx (or
your reverse proxy of choice) in front of it with a real cert. See
`nginx.conf.example` for a starting point; it also shows how to serve the
static `docs/` site from the same domain, which is worth doing once you're
off GitHub Pages anyway (avoids CORS entirely).

### Pointing the frontend at it

Once it's live at, say, `https://your-domain.example/api`, set that in
`docs/app.js`:

```js
const SYNC_API_BASE = 'https://your-domain.example/api';
```

Redeploy the static site (bump the cache-busting `?v=` as usual) and the
"Sync vessels" panel appears in the Vessels section.

## Backing it up

It's one SQLite file. `sqlite3 sync.sqlite3 ".backup backup.sqlite3"` or just
copy the file while the WAL is checkpointed (`PRAGMA wal_checkpoint;`) —
low-stakes data, low-effort backup is fine here.
