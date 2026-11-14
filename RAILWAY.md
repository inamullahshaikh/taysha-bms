# Deploying on Railway

Railway bills for memory and CPU every minute a service runs, for traffic leaving Railway (egress), and for
volume disk. This setup keeps all four small: one web service, one cron job that runs for seconds and exits,
and Postgres.

| Service | What it runs | Always on? |
|---|---|---|
| `app` | API under `/api` and the built frontend (root `Dockerfile`) | Yes, or sleeps when idle (Serverless, optional) |
| `jobs` | `python -m app.jobs`: runs whatever background job is due, then exits | No: a cron job every 15 minutes |
| `Postgres` | Railway's Postgres | Yes |

## 1. Create the services

1. **New project → Deploy from GitHub repo** (this repo). Railway builds the root `Dockerfile`. Name it `app`.
2. **Add Postgres:** New → Database → PostgreSQL. Put it in the same region as `app`.
3. **Add the cron service:** New → GitHub repo → this repo again. Name it `jobs`.

## 2. Settings

**app**
- Settings → Deploy → **Pre-deploy command:** `alembic upgrade head` (migrations run once per deploy, not on every start or wake-up)
- **Healthcheck path:** `/api/health`
- **Volume:** right-click the service → Attach volume, mount path `/data` (uploaded files)
- **Networking:** generate a domain, or add your own (e.g. `bms.taysha.pk` with a CNAME)
- Replicas: 1

**jobs**
- Settings → Deploy → **Custom start command:** `python -m app.jobs`
- **Cron schedule:** `*/15 * * * *`
- **Restart policy:** Never (each run is meant to exit)
- No domain, no volume

**Both app and jobs**
- Settings → Build → **Watch paths:** `/backend/**`, `/frontend/**`, `/Dockerfile` (editing docs doesn't redeploy)
- **Resource limits** (if your plan shows them): app 1 vCPU / 1 GB, jobs 1 vCPU / 512 MB. These are ceilings,
  not reservations; they stop a runaway bill. Normal use is about 115 MB for app (up to ~160 MB after it has
  rendered PDFs).

## 3. Variables

Put shared values in **Project Settings → Shared Variables** and reference them from both services.

| Variable | app | jobs | Value |
|---|---|---|---|
| `DATABASE_URL` | ✓ | ✓ | `${{Postgres.DATABASE_URL}}`: the **private** URL. Never use `DATABASE_PUBLIC_URL`: that path is billed as egress. |
| `SECRET_KEY` | ✓ | ✓ | Long random string (`python -c "import secrets; print(secrets.token_urlsafe(48))"`). Never change it later: it decrypts the stored Shopify token. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | ✓ | ✓ | Outgoing email (invoices from app, alerts and scheduled reports from jobs) |
| `UPLOAD_DIR` | ✓ | | `/data/uploads` |
| `BACKUPS_ENABLED` | ✓ | ✓ | `false`: Railway backs up the volumes instead (step 4) |
| `DB_POOL_SIZE` / `DB_MAX_OVERFLOW` | `3` / `2` | `1` / `1` | Few idle connections: less Postgres memory |

Already set by the image: `FRONTEND_DIR`, `DOCS_ENABLED=false`, `MALLOC_ARENA_MAX=2`. Railway sets `PORT`.

## 4. Backups

Turn on **Backups** for the Postgres service and for app's volume (each service's Backups tab, daily schedule).
In-app file backups stay off on Railway (`BACKUPS_ENABLED=false`): they would need a second copy of every upload
on paid disk every day, and the cron job can't reach the app's volume anyway.

## 5. First owner

After the first deploy, open a shell in the app service (`railway ssh`, choose `app`), then run
`python -m app.cli create-owner --name "Your Name" --email you@taysha.pk`.

## 6. Optional: let the app sleep (Serverless)

app → Settings → Deploy → **Serverless**. After 5–10 minutes with no traffic the container stops and you pay
nothing for app until the next visit. The cost is a wait of a few seconds on the first visit after a quiet spell
(the app starts in about 4 s; occasionally Railway answers that first request with a 502: reload once). The
frontend is built for it:
- open tabs check notifications every 5 minutes only while visible, so a forgotten background tab doesn't keep it awake
- data requests retry for about 15 seconds while it wakes

Leave Serverless off for jobs (it exits by itself) and for Postgres.

## 7. Keep an eye on it

Workspace → Usage: set an email alert, and a hard limit if you want a ceiling.

## Config as code

The service settings above live in [.railway/railway.ts](.railway/railway.ts) (Singapore region, Dockerfile
builds, pre-deploy migrations, health check, the jobs cron, watch paths, the `/data` volume, limits). Variables are
not in it: they stay in Railway so secrets never reach the repo. After editing it, from the repo root:

```sh
npm install                 # once: the railway/iac package the file imports
railway config plan         # preview
railway config apply        # apply
```

On Windows the package's CLI version check runs `$_`, which is the npm wrapper script, not the CLI itself. Point it
at the real executable first, in PowerShell:
`$env:_ = "$env:APPDATA\npm\node_modules\@railway\cli\bin\railway.exe"`.

## What keeps the bill low

**Fewer and smaller always-on services**
- One web service for API and frontend: no separate web server or Caddy container. Railway's edge does HTTPS.
- Background jobs run as a cron job for a few seconds every 15 minutes, instead of a scheduler container that
  sits in memory all day.
- One web worker (was 2) and `MALLOC_ARENA_MAX=2`: about 115 MB idle.
- Heavy libraries (PDF, Excel, barcodes, Shopify client) load only when first used: startup memory 133 → 112 MB.
- Small database connection pool; no idle connections held open by background threads.

**Fast, cheap wake-ups**
- Migrations run in the pre-deploy step, not on every start.
- Python bytecode is compiled into the image.
- Start to first response: about 4 s (was 6 s).

**Less traffic out (egress)**
- API responses are gzipped: lists and the dashboard shrink 5–20× (journal 31 KB → 1.5 KB).
- Frontend files are brotli-compressed at build time (1.46 MB → 425 KB) and cached for a year
  (fingerprinted file names). Repeat visits download only `index.html`.
- Chart and page code load only when a page needs them.
- Uploaded files are cached by browsers (a stored file version never changes).
- The logo is a 13 KB WebP (was a 60 KB PNG).
- Database traffic stays on Railway's private network.

**Less disk**
- Phone photos (receipts, proof of delivery) are shrunk in the browser before upload: about 10× smaller.
- Railway snapshots volumes instead of daily full copies of every upload.
- Daily housekeeping removes expired sessions, read notifications older than 90 days and old Shopify payloads.

**Less CPU per request**
- Database queries across all read endpoints: 2,733 → 1,292. Lists no longer run a query per row:
  journal (200 rows) 204 → 5, expenses 112 → 5, production orders 169 → 22, dashboard 191 → 68, accounting
  reports ~30 → 4–7 each. Missing indexes added (most busy paths already had them).
- Lists are paged on the server (50 rows). The frontend reuses fetched data for a minute (lookups for 30, the
  dashboard for 2) instead of refetching on every visit.
- Record searches wait for a pause in typing.
- Notifications are checked every 5 minutes instead of every minute.
