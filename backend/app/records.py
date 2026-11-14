"""Company documents (contracts, licenses, certificates, policies, designs...) with expiry reminders.

The files are attachments on the record (entity_type=document_records), so uploads are versioned. Confidential
records and their files need the separate "confidential_documents" access.
"""

from datetime import date, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import Boolean, Date, ForeignKey, Integer, String, Text, func, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.attachments import Attachment
from app.audit import audit, snapshot
from app.auth.access import can, require_access
from app.auth.models import User
from app.clock import local_today
from app.crud import RecordOut, get_or_404
from app.db import DB, Base, Entity
from app.errors import AppError
from app.listing import ListParams, Page, apply_filters, paginate

Category = Literal["contract", "agreement", "license", "certificate", "policy", "procedure", "recipe", "design",
                   "invoice", "insurance", "legal", "other"]
LINKS = ("department_id", "product_id", "supplier_id", "customer_id", "campaign_id", "project_id")


class DocumentRecord(Entity, Base):
    __tablename__ = "document_records"
    title: Mapped[str] = mapped_column(String(200), index=True)
    category: Mapped[str] = mapped_column(String(30), index=True)
    reference_number: Mapped[str | None] = mapped_column(String(100))
    issued_by: Mapped[str | None] = mapped_column(String(150))
    issue_date: Mapped[date | None] = mapped_column(Date)
    expiry_date: Mapped[date | None] = mapped_column(Date, index=True)
    reminder_days: Mapped[int] = mapped_column(Integer, default=30)
    confidential: Mapped[bool] = mapped_column(Boolean, default=False)
    tags: Mapped[list] = mapped_column(JSONB, default=list)
    notes: Mapped[str | None] = mapped_column(Text)
    department_id: Mapped[int | None] = mapped_column(ForeignKey("departments.id"))
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"), index=True)
    supplier_id: Mapped[int | None] = mapped_column(ForeignKey("suppliers.id"), index=True)
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("customers.id"), index=True)
    campaign_id: Mapped[int | None] = mapped_column(ForeignKey("campaigns.id"))
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"))


class DocIn(BaseModel):
    title: str = Field(min_length=1)
    category: Category
    reference_number: str | None = None
    issued_by: str | None = None
    issue_date: date | None = None
    expiry_date: date | None = None
    reminder_days: int = Field(30, ge=0, le=365)
    confidential: bool = False
    tags: list[str] = []
    notes: str | None = None
    department_id: int | None = None
    product_id: int | None = None
    supplier_id: int | None = None
    customer_id: int | None = None
    campaign_id: int | None = None
    project_id: int | None = None


class DocPatch(BaseModel):
    title: str | None = None
    category: Category | None = None
    reference_number: str | None = None
    issued_by: str | None = None
    issue_date: date | None = None
    expiry_date: date | None = None
    reminder_days: int | None = Field(None, ge=0, le=365)
    confidential: bool | None = None
    tags: list[str] | None = None
    notes: str | None = None
    department_id: int | None = None
    product_id: int | None = None
    supplier_id: int | None = None
    customer_id: int | None = None
    campaign_id: int | None = None
    project_id: int | None = None


class DocOut(RecordOut, DocIn):
    created_at: datetime
    created_by_id: int | None
    file_count: int = 0
    expires_in_days: int | None = None


router = APIRouter(prefix="/document-records", tags=["documents"])
VIEW, CREATE, EDIT, ARCHIVE = (require_access("documents", a) for a in ("view", "create", "edit", "archive"))


def visible(db: Session, user: User, d: DocumentRecord) -> None:
    if d.confidential and not can(db, user, "confidential_documents", "view"):
        raise AppError(404, "not_found", "Document not found")  # don't reveal that it exists


def doc_out(db: Session, d: DocumentRecord) -> DocOut:
    o = DocOut.model_validate(d)
    o.file_count = db.scalar(select(func.count()).select_from(Attachment).where(
        Attachment.entity_type == "document_records", Attachment.entity_id == d.id, Attachment.archived_at.is_(None)))
    o.expires_in_days = (d.expiry_date - local_today()).days if d.expiry_date else None
    return o


@router.get("", response_model=Page[DocOut])
def list_docs(db: DB, p: Annotated[ListParams, Depends()], category: Category | None = None, tag: str | None = None,
              expiring_within_days: int | None = None, expired: bool = False, department_id: int | None = None,
              product_id: int | None = None, supplier_id: int | None = None, customer_id: int | None = None,
              campaign_id: int | None = None, project_id: int | None = None, date_from: date | None = None,
              date_to: date | None = None, user: User = VIEW):
    q = apply_filters(select(DocumentRecord), DocumentRecord, p,
                      (DocumentRecord.title, DocumentRecord.reference_number, DocumentRecord.notes),
                      {"title": DocumentRecord.title, "expiry_date": DocumentRecord.expiry_date,
                       "created_at": DocumentRecord.created_at})
    if not can(db, user, "confidential_documents", "view"):
        q = q.where(DocumentRecord.confidential.is_(False))
    if category:
        q = q.where(DocumentRecord.category == category)
    if tag:
        q = q.where(DocumentRecord.tags.contains([tag]))
    links = {"department_id": department_id, "product_id": product_id, "supplier_id": supplier_id,
             "customer_id": customer_id, "campaign_id": campaign_id, "project_id": project_id}
    for k, v in links.items():
        if v is not None:
            q = q.where(getattr(DocumentRecord, k) == v)
    t = local_today()
    if expiring_within_days is not None:
        q = q.where(DocumentRecord.expiry_date.between(t, t + timedelta(days=expiring_within_days)))
    if expired:
        q = q.where(DocumentRecord.expiry_date < t)
    if date_from:
        q = q.where(func.date(DocumentRecord.created_at) >= date_from)
    if date_to:
        q = q.where(func.date(DocumentRecord.created_at) <= date_to)
    page = paginate(db, q, p)
    page["items"] = [doc_out(db, d) for d in page["items"]]
    return page


@router.get("/{doc_id}", response_model=DocOut)
def read_doc(doc_id: int, db: DB, user: User = VIEW):
    d = get_or_404(db, DocumentRecord, doc_id, "Document")
    visible(db, user, d)
    return doc_out(db, d)


@router.post("", response_model=DocOut, status_code=201)
def create_doc(body: DocIn, db: DB, user: User = CREATE):
    if body.confidential and not can(db, user, "confidential_documents", "view"):
        raise AppError(403, "forbidden", "You can't create confidential documents")
    d = DocumentRecord(**body.model_dump())
    db.add(d)
    audit(db, "create", d)
    return doc_out(db, d)


@router.patch("/{doc_id}", response_model=DocOut)
def update_doc(doc_id: int, body: DocPatch, db: DB, user: User = EDIT):
    d = get_or_404(db, DocumentRecord, doc_id, "Document")
    visible(db, user, d)
    if body.confidential and not can(db, user, "confidential_documents", "view"):
        raise AppError(403, "forbidden", "You can't mark documents confidential")
    before = snapshot(d)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(d, k, v)
    audit(db, "update", d, before=before)
    return doc_out(db, d)


@router.post("/{doc_id}/archive", response_model=DocOut)
def archive_doc(doc_id: int, db: DB, user: User = ARCHIVE):
    d = get_or_404(db, DocumentRecord, doc_id, "Document")
    visible(db, user, d)
    d.archived_at = func.now()
    audit(db, "archive", d)
    db.flush()
    db.refresh(d)
    return doc_out(db, d)


def expiring(db: Session) -> list[DocumentRecord]:
    """Documents inside their reminder window (or already expired), for the alerts job."""
    t = local_today()
    return db.scalars(select(DocumentRecord).where(
        DocumentRecord.archived_at.is_(None), DocumentRecord.expiry_date.is_not(None),
        DocumentRecord.expiry_date <= t + func.make_interval(0, 0, 0, DocumentRecord.reminder_days))).all()


routers = [router]
