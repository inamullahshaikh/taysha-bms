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
