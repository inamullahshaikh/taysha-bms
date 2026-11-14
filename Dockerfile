# Single-service image for Railway: the API and the built frontend in one container (see RAILWAY.md).
# A self-hosted server keeps using docker-compose.prod.yml (backend/Dockerfile + Caddy).

FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
# Pango/HarfBuzz + fonts for WeasyPrint PDFs; pg client for manual dumps/restores
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b libharfbuzz-subset0 fonts-dejavu-core postgresql-client \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv==0.13.6

# UV_COMPILE_BYTECODE + compileall: no compiling on every cold start after the service sleeps.
# MALLOC_ARENA_MAX=2: stops glibc from growing a memory arena per thread (threaded Python's memory creep).
ENV UV_PROJECT_ENVIRONMENT=/venv UV_COMPILE_BYTECODE=1 PATH="/venv/bin:$PATH" PYTHONUNBUFFERED=1 \
    MALLOC_ARENA_MAX=2 FRONTEND_DIR=/app/static DOCS_ENABLED=false
WORKDIR /app
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev
COPY backend/ ./
RUN python -m compileall -q app alembic
COPY --from=web /web/dist ./static

# One worker is plenty for a small team and halves memory against two. Railway's edge already logs every request.
# Migrations run once per deploy as the pre-deploy command (alembic upgrade head), not on every start.
CMD ["sh", "-c", "exec uvicorn app.web:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1 --proxy-headers --forwarded-allow-ips='*' --no-access-log"]
