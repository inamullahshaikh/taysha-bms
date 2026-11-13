from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

from app.config import settings

TZ = ZoneInfo(settings.timezone)


def utcnow() -> datetime:
    return datetime.now(UTC)


def local_now() -> datetime:
    return datetime.now(TZ)


def local_today() -> date:
    return local_now().date()
