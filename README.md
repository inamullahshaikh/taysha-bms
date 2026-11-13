# Taysha BMS

Internal business management system for Taysha. Plans: [FEATURES_AND_TODO.md](FEATURES_AND_TODO.md), [BACKEND_PLAN.md](BACKEND_PLAN.md), [FRONTEND_PLAN.md](FRONTEND_PLAN.md).

## Backend (FastAPI + PostgreSQL)

Everything runs in Docker.

```sh
docker compose up -d                 # API on http://localhost:8010 (docs at /docs), Postgres on localhost:5433
docker compose run --rm api pytest   # run tests
docker compose run --rm api python -m app.cli create-owner   # first owner account
```

After changing `backend/pyproject.toml`: `cd backend && uv lock`, then `docker compose build api`.

New migration: `docker compose run --rm api alembic revision --autogenerate -m "message"`.

Background jobs (overdue invoices, daily backup, weekly restore test) run in the `scheduler` container.
Run one now: `docker compose run --rm api python -m app.jobs --run backup`.

## Deploying (production / staging)

1. On the server: install Docker, clone the repo, point the domain's DNS at the server.
2. `cp .env.example .env` and fill it in (long random `POSTGRES_PASSWORD`, `DOMAIN`, SMTP).
3. Build the frontend into `frontend/dist` (see frontend README).
4. `docker compose -f docker-compose.prod.yml --env-file .env up -d --build`
5. `docker compose -f docker-compose.prod.yml exec api python -m app.cli create-owner --name "..." --email ...`

Caddy gets HTTPS certificates automatically. The API is served at `https://DOMAIN/api`, the app at `https://DOMAIN`.
Migrations run on every API start. Staging: same command with `-p taysha-staging --env-file .env.staging`
on a second domain.

### Backups

- A dump of the database and a copy of uploaded files are written daily to the `backups` volume, kept 14 days.
- Every week the newest dump is restored into a scratch database and checked; see `GET /settings/jobs`.
- **Copy the backups off the server** (they're on the same disk as the database). For example with rclone:
  `rclone sync /var/lib/docker/volumes/<project>_backups/_data remote:taysha-backups` from a daily cron.

Restore (replaces the live database; uploads are in the matching `uploads-*.tar.gz`):
```sh
docker compose -f docker-compose.prod.yml stop api scheduler
docker compose -f docker-compose.prod.yml run --rm api python -m app.backup restore /data/backups/taysha-YYYYMMDD-HHMMSS.dump --yes
docker compose -f docker-compose.prod.yml start api scheduler
```
