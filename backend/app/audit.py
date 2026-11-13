from datetime import date, datetime
from decimal import Decimal
from enum import Enum

from sqlalchemy import BigInteger, DateTime, Index, String, Text, func, inspect
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.db import Base


class AuditLog(Base):
    """Append-only record of important actions. user_id has no FK on purpose: audit rows outlive anything."""

    __tablename__ = "audit_log"
    __table_args__ = (Index("ix_audit_log_entity", "entity_type", "entity_id"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    user_id: Mapped[int | None] = mapped_column(BigInteger, index=True)
    action: Mapped[str] = mapped_column(String(50), index=True)
    entity_type: Mapped[str | None] = mapped_column(String(50))
    entity_id: Mapped[int | None] = mapped_column(BigInteger)
    before: Mapped[dict | None] = mapped_column(JSONB)
    after: Mapped[dict | None] = mapped_column(JSONB)
    source: Mapped[str] = mapped_column(String(20), default="manual")  # manual | integration | system
    ip: Mapped[str | None] = mapped_column(String(45))
    note: Mapped[str | None] = mapped_column(Text)


SKIP = {"created_at", "updated_at", "created_by_id", "updated_by_id", "password_hash", "totp_secret"}


def jsonable(v):
    if isinstance(v, Decimal):
        return str(v)
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, Enum):
        return v.value
    return v


def snapshot(obj) -> dict:
    return {
        a.key: jsonable(getattr(obj, a.key)) for a in inspect(obj).mapper.column_attrs if a.key not in SKIP
    }


def audit(
    db: Session,
    action: str,
    obj=None,
    *,
    before: dict | None = None,
    after: dict | None = None,
    entity_type: str | None = None,
    entity_id: int | None = None,
    note: str | None = None,
    user_id: int | None = None,
) -> None:
    """Record an action in the current transaction (so it commits or rolls back with the change).

    For updates pass `before=snapshot(obj)` taken before the change; only changed fields are stored.
    """
    if obj is not None:
        db.flush()  # make sure obj has its id
        entity_type = entity_type or obj.__tablename__
        entity_id = entity_id or obj.id
        if after is None and action != "archive":
            after = snapshot(obj)
    if before is not None and after is not None:
        changed = {k for k in after if before.get(k) != after[k]}
        before = {k: before.get(k) for k in changed}
        after = {k: after[k] for k in changed}
    db.add(
        AuditLog(
            user_id=user_id if user_id is not None else db.info.get("user_id"),
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            before=before,
            after=after,
            source=db.info.get("source", "manual"),
            ip=db.info.get("ip"),
            note=note,
        )
    )
