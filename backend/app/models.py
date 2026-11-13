"""Imports every model module so Alembic and the app see the full schema."""

from app import attachments, audit, company, numbering  # noqa: F401
from app.auth import access, models  # noqa: F401
from app.products import models as product_models  # noqa: F401
