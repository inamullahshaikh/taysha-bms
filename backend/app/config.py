from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://taysha:taysha@localhost:5433/taysha"
    test_database_url: str = "postgresql+psycopg://taysha:taysha@localhost:5433/taysha_test"

    # Small pool: one web process serves a small team, and every idle Postgres connection costs server memory
    db_pool_size: int = 5
    db_max_overflow: int = 5

    @field_validator("database_url", "test_database_url")
    @classmethod
    def _psycopg(cls, v: str) -> str:
        """Hosts like Railway hand out postgres:// or postgresql:// URLs; use the installed psycopg 3 driver."""
        for prefix in ("postgres://", "postgresql://"):
            if v.startswith(prefix):
                return "postgresql+psycopg://" + v[len(prefix):]
        return v

    # Encrypts stored integration credentials. Set a long random value in production.
    secret_key: str = "dev-only-change-me"

    # Sessions
    cookie_name: str = "taysha_session"
    cookie_secure: bool = True
    session_idle_minutes: int = 12 * 60
    session_absolute_days: int = 7

    # Login throttling
    login_max_failures: int = 5
    login_lockout_minutes: int = 15

    upload_dir: str = "uploads"
    max_upload_mb: int = 20

    backup_dir: str = "backups"
    backup_retention_days: int = 14
    # Off where the host snapshots volumes itself (Railway): saves disk, CPU and the weekly restore test
    backups_enabled: bool = True
    # Daily archive of every uploaded file; each copy repeats files that never change, so it multiplies disk use
    backup_uploads: bool = True

    # Built frontend (index.html + assets). When set, app.web serves it next to the API (single service).
    frontend_dir: str = ""

    timezone: str = "Asia/Karachi"
    currency: str = "PKR"

    # Outgoing email (invoices, statements, alerts)
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = "no-reply@taysha.local"
    smtp_starttls: bool = True

    cors_origins: list[str] = ["http://localhost:5173"]
    docs_enabled: bool = True  # /docs and /openapi.json; off in production


settings = Settings()
