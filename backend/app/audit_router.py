from datetime import datetime

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import select

from app.audit import AuditLog
from app.auth.access import can, ensure
from app.auth.deps import CurrentUser
from app.auth.features import ENTITY_FEATURE
from app.db import DB

router = APIRouter(prefix="/audit", tags=["audit"])


class AuditOut(BaseModel):
    model_config = {"from_attributes": True}
    id: int
    at: datetime
    user_id: int | None
    action: str
    entity_type: str | None
    entity_id: int | None
    before: dict | None
    after: dict | None
    source: str
    note: str | None


@router.get("", response_model=list[AuditOut])
def list_audit(
    user: CurrentUser,
    db: DB,
    entity_type: str | None = None,
    entity_id: int | None = None,
    user_id: int | None = None,
    action: str | None = None,
    limit: int = Query(100, le=500),
    before_id: int | None = None,
):
    """History of one record (needs view access to that record's feature) or the full log (needs audit view)."""
    feature = ENTITY_FEATURE.get(entity_type or "")
    if not (entity_type and entity_id and feature and can(db, user, feature)):
        ensure(db, user, "audit")
    q = select(AuditLog).order_by(AuditLog.id.desc()).limit(limit)
    if entity_type:
        q = q.where(AuditLog.entity_type == entity_type)
    if entity_id:
        q = q.where(AuditLog.entity_id == entity_id)
    if user_id:
        q = q.where(AuditLog.user_id == user_id)
    if action:
        q = q.where(AuditLog.action == action)
    if before_id:  # keyset paging
        q = q.where(AuditLog.id < before_id)
    return db.scalars(q).all()
