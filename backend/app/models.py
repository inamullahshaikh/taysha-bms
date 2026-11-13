"""Imports every model module so Alembic and the app see the full schema."""

from app import audit  # noqa: F401
from app.auth import models as auth_models  # noqa: F401
from app.auth import access as access_models  # noqa: F401
from app import numbering  # noqa: F401
