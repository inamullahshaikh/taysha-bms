from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://taysha:taysha@localhost:5433/taysha"
    test_database_url: str = "postgresql+psycopg://taysha:taysha@localhost:5433/taysha_test"

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


settings = Settings()
