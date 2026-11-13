from alembic import context
from sqlalchemy import create_engine

import app.models  # noqa: F401  registers every model on Base.metadata
from app.config import settings
from app.db import Base

url = context.config.get_main_option("sqlalchemy.url") or settings.database_url

with create_engine(url).connect() as connection:
    context.configure(connection=connection, target_metadata=Base.metadata, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()
