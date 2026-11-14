"""Files attached to any record (entity_type = table name, entity_id = row id)."""

import hashlib
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import BigInteger, Index, Integer, String, func, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.audit import audit
from app.auth.access import ensure
from app.auth.deps import CurrentUser
from app.auth.features import ENTITY_FEATURE
from app.auth.models import User
from app.config import settings
from app.db import DB, Base, Entity
from app.errors import AppError, not_found

ALLOWED_TYPES = {
    "application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif", "text/plain", "text/csv",
    "application/vnd.ms-excel", "application/msword",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


class Attachment(Entity, Base):
    __tablename__ = "attachments"
    __table_args__ = (Index("ix_attachments_entity", "entity_type", "entity_id"),)

    entity_type: Mapped[str] = mapped_column(String(50))
    entity_id: Mapped[int] = mapped_column(BigInteger)
    category: Mapped[str | None] = mapped_column(String(50))  # e.g. receipt, image, contract
    filename: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(100))
    size: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64))
    storage_key: Mapped[str] = mapped_column(String(255))
    version: Mapped[int] = mapped_column(Integer, default=1)


class AttachmentOut(BaseModel):
    model_config = {"from_attributes": True}
    id: int
    entity_type: str
    entity_id: int
    category: str | None
    filename: str
    content_type: str
    size: int
    version: int
    created_at: datetime
    created_by_id: int | None
    archived_at: datetime | None


def check_parent(db: Session, user: User, entity_type: str, entity_id: int, action: str) -> None:
    feature = ENTITY_FEATURE.get(entity_type)
    table = Base.metadata.tables.get(entity_type)
    if feature is None or table is None:
        raise AppError(422, "invalid_entity", f"Files can't be attached to {entity_type}")
    row = db.execute(select(*[c for c in (table.c.id, table.c.get("created_by_id")) if c is not None])
                     .where(table.c.id == entity_id)).first()
    if row is None:
        ensure(db, user, feature, action)
        raise not_found("Linked record")
    own = len(row) > 1 and row[1] == user.id  # people may attach files to records they created (e.g. receipts)
    if not own:
        ensure(db, user, feature, action)
    conf = table.c.get("confidential")
    if conf is not None and db.scalar(select(conf).where(table.c.id == entity_id)):
        ensure(db, user, "confidential_documents", "view")


# ponytail: local disk storage (a mounted volume). Add an S3 backend if the app moves to several servers.
# A file written before a rolled-back transaction stays on disk as an orphan; harmless, sweep later if needed.
def store(data: bytes) -> str:
    key = f"{datetime.now():%Y/%m}/{uuid.uuid4().hex}"
    path = Path(settings.upload_dir) / key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return key


def read_file(key: str) -> bytes:
    return (Path(settings.upload_dir) / key).read_bytes()


def save_upload(db: Session, user: User, entity_type: str, entity_id: int, file: UploadFile,
                category: str | None = None) -> Attachment:
    """Shared by the endpoint below and modules that take files directly (e.g. expense receipts)."""
    check_parent(db, user, entity_type, entity_id, "edit")
    if file.content_type not in ALLOWED_TYPES:
        raise AppError(422, "file_type", f"File type {file.content_type} is not allowed", {"file": "type"})
    limit = settings.max_upload_mb * 1024 * 1024
    data = file.file.read(limit + 1)
    if len(data) > limit:
        raise AppError(413, "file_too_large", f"Files must be under {settings.max_upload_mb} MB", {"file": "size"})
    if not data:
        raise AppError(422, "empty_file", "The file is empty", {"file": "empty"})
    name = Path(file.filename or "file").name[:255]
    version = 1 + (db.scalar(select(func.max(Attachment.version)).where(
        Attachment.entity_type == entity_type, Attachment.entity_id == entity_id,
        Attachment.filename == name)) or 0)
    a = Attachment(entity_type=entity_type, entity_id=entity_id, category=category, filename=name,
                   content_type=file.content_type, size=len(data), sha256=hashlib.sha256(data).hexdigest(),
                   storage_key=store(data), version=version)
    db.add(a)
    audit(db, "attach", entity_type=entity_type, entity_id=entity_id, after={"file": name, "version": version})
    db.flush()
    return a


router = APIRouter(prefix="/attachments", tags=["attachments"])


@router.post("", response_model=AttachmentOut, status_code=201)
def upload(entity_type: str, entity_id: int, file: UploadFile, user: CurrentUser, db: DB,
           category: str | None = None):
    return save_upload(db, user, entity_type, entity_id, file, category)


@router.get("", response_model=list[AttachmentOut])
def list_attachments(entity_type: str, entity_id: int, user: CurrentUser, db: DB,
                     include_archived: bool = False):
    check_parent(db, user, entity_type, entity_id, "view")
    q = select(Attachment).where(Attachment.entity_type == entity_type, Attachment.entity_id == entity_id)
    if not include_archived:
        q = q.where(Attachment.archived_at.is_(None))
    return db.scalars(q.order_by(Attachment.id.desc())).all()


def get_attachment(db: Session, user: User, attachment_id: int, action: str) -> Attachment:
    a = db.get(Attachment, attachment_id)
    if a is None:
        raise not_found("File")
    check_parent(db, user, a.entity_type, a.entity_id, action)
    return a


@router.get("/{attachment_id}/download")
def download(attachment_id: int, user: CurrentUser, db: DB):
    a = get_attachment(db, user, attachment_id, "view")
    path = Path(settings.upload_dir) / a.storage_key
    if not path.exists():
        raise not_found("File content")
    # a stored version never changes (a new upload is a new attachment), so the browser may keep it
    return FileResponse(path, media_type=a.content_type, filename=a.filename,
                        headers={"Cache-Control": "private, max-age=31536000, immutable"})


@router.post("/{attachment_id}/archive", response_model=AttachmentOut)
def archive(attachment_id: int, user: CurrentUser, db: DB):
    a = get_attachment(db, user, attachment_id, "edit")
    a.archived_at = func.now()
    audit(db, "detach", entity_type=a.entity_type, entity_id=a.entity_id, after={"file": a.filename})
    db.flush()
    db.refresh(a)
    return a

routers = [router]
