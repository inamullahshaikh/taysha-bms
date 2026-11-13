FROM python:3.12-slim

# Pango/HarfBuzz for WeasyPrint PDFs, fonts for rendering, pg client for backups
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b libharfbuzz-subset0 fonts-dejavu-core postgresql-client \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv==0.13.6
ENV UV_PROJECT_ENVIRONMENT=/venv PATH="/venv/bin:$PATH" PYTHONUNBUFFERED=1

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen
COPY . .

CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
