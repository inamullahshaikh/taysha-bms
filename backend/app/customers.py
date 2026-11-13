"""Customers (CRM basics): profile, addresses, tags, notes / communication log."""

from datetime import datetime
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import Boolean, ForeignKey, Integer, Numeric, String, Text, func, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.audit import audit, snapshot
from app.auth.access import require_access
from app.auth.models import User
from app.crud import RecordOut, crud_router, get_or_404
from app.db import DB, Base, Entity
from app.errors import AppError

CustomerType = Literal["retail", "wholesale", "cafe", "corporate", "distributor", "retailer", "other"]
NoteKind = Literal["note", "call", "email", "whatsapp", "meeting", "complaint", "preference"]


class Customer(Entity, Base):
    __tablename__ = "customers"

    name: Mapped[str] = mapped_column(String(200), index=True)
    type: Mapped[str] = mapped_column(String(20), default="retail")
    company_name: Mapped[str | None] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(30), index=True)
    email: Mapped[str | None] = mapped_column(String(254), index=True)
    tags: Mapped[list] = mapped_column(JSONB, default=list)  # vip, wholesale, cafe, corporate, ...
    price_list_id: Mapped[int | None] = mapped_column(ForeignKey("price_lists.id"))  # default prices for them
    payment_terms_days: Mapped[int] = mapped_column(Integer, default=0)  # 0 = pay on order
    credit_limit: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    ntn: Mapped[str | None] = mapped_column(String(50))
    strn: Mapped[str | None] = mapped_column(String(50))
    source: Mapped[str | None] = mapped_column(String(30))  # sales channel / how they found us
    preferences: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    marketing_opt_in: Mapped[bool] = mapped_column(Boolean, default=False)


class CustomerAddress(Entity, Base):
    __tablename__ = "customer_addresses"

    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"), index=True)
    label: Mapped[str] = mapped_column(String(50), default="Main")
    line1: Mapped[str] = mapped_column(String(255))
    line2: Mapped[str | None] = mapped_column(String(255))
    area: Mapped[str | None] = mapped_column(String(100))
    city: Mapped[str] = mapped_column(String(100))
    postal_code: Mapped[str | None] = mapped_column(String(20))
    phone: Mapped[str | None] = mapped_column(String(30))
    is_default_billing: Mapped[bool] = mapped_column(Boolean, default=False)
    is_default_shipping: Mapped[bool] = mapped_column(Boolean, default=False)


class CustomerNote(Entity, Base):
    """Communication history. Never edited; add a new note instead."""

    __tablename__ = "customer_notes"

    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"), index=True)
    kind: Mapped[str] = mapped_column(String(20), default="note")
    body: Mapped[str] = mapped_column(Text)


def clean_phone(v: str | None) -> str | None:
    if not v:
        return None
    return "".join(c for c in v if c.isdigit() or c == "+") or None


# ---------- schemas ----------

class CustomerIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    type: CustomerType = "retail"
    company_name: str | None = None
    phone: str | None = None
    email: EmailStr | None = None
    tags: list[str] = []
    price_list_id: int | None = None
    payment_terms_days: int = Field(0, ge=0)
    credit_limit: Decimal | None = Field(None, ge=0)
    ntn: str | None = None
    strn: str | None = None
    source: str | None = None
    preferences: str | None = None
    notes: str | None = None
    marketing_opt_in: bool = False


class CustomerPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    type: CustomerType | None = None
    company_name: str | None = None
    phone: str | None = None
    email: EmailStr | None = None
    tags: list[str] | None = None
    price_list_id: int | None = None
    payment_terms_days: int | None = Field(None, ge=0)
    credit_limit: Decimal | None = Field(None, ge=0)
    ntn: str | None = None
    strn: str | None = None
    source: str | None = None
    preferences: str | None = None
    notes: str | None = None
    marketing_opt_in: bool | None = None


class CustomerOut(RecordOut, CustomerIn):
    email: str | None = None
    created_at: datetime


class AddressIn(BaseModel):
    label: str = "Main"
    line1: str = Field(min_length=1)
    line2: str | None = None
    area: str | None = None
    city: str = Field(min_length=1)
    postal_code: str | None = None
    phone: str | None = None
    is_default_billing: bool = False
    is_default_shipping: bool = False


class AddressOut(RecordOut, AddressIn):
    customer_id: int


class NoteIn(BaseModel):
    kind: NoteKind = "note"
    body: str = Field(min_length=1)


class NoteOut(RecordOut, NoteIn):
    created_at: datetime
    created_by_id: int | None


# ---------- routes ----------

VIEW, EDIT = require_access("customers", "view"), require_access("customers", "edit")


class CustomerCreate(CustomerIn):
    def model_dump(self, **kw):  # normalise before the generic CRUD saves it
        d = super().model_dump(**kw)
        d["phone"] = clean_phone(d.get("phone"))
        d["email"] = d["email"].lower() if d.get("email") else None
        return d


class CustomerUpdate(CustomerPatch):
    def model_dump(self, **kw):
        d = super().model_dump(**kw)
        if "phone" in d:
            d["phone"] = clean_phone(d["phone"])
        if d.get("email"):
            d["email"] = d["email"].lower()
        return d


base = crud_router(
    Customer, prefix="/customers", feature="customers", create=CustomerCreate, update=CustomerUpdate,
    out=CustomerOut, search=(Customer.name, Customer.phone, Customer.email, Customer.company_name),
    sorts={"name": Customer.name, "created_at": Customer.created_at},
    filters={"type": Customer.type, "tag": Customer.tags, "source": Customer.source}, default_sort=Customer.name,
)
crud_routers = [base]
router = APIRouter(prefix="/customers", tags=["customers"])


@router.get("/{customer_id}/addresses", response_model=list[AddressOut])
def list_addresses(customer_id: int, db: DB, _: User = VIEW):
    return db.scalars(select(CustomerAddress).where(CustomerAddress.customer_id == customer_id,
                                                    CustomerAddress.archived_at.is_(None))
                      .order_by(CustomerAddress.id)).all()


def _clear_defaults(db, customer_id: int, a: AddressIn, keep_id: int | None = None):
    for flag in ("is_default_billing", "is_default_shipping"):
        if getattr(a, flag):
            for other in db.scalars(select(CustomerAddress).where(CustomerAddress.customer_id == customer_id,
                                                                  CustomerAddress.id != (keep_id or 0))):
                setattr(other, flag, False)


@router.post("/{customer_id}/addresses", response_model=AddressOut, status_code=201)
def add_address(customer_id: int, body: AddressIn, db: DB, _: User = EDIT):
    get_or_404(db, Customer, customer_id, "Customer")
    _clear_defaults(db, customer_id, body)
    a = CustomerAddress(customer_id=customer_id, **body.model_dump())
    db.add(a)
    audit(db, "create", a)
    return a


@router.put("/{customer_id}/addresses/{address_id}", response_model=AddressOut)
def update_address(customer_id: int, address_id: int, body: AddressIn, db: DB, _: User = EDIT):
    a = get_or_404(db, CustomerAddress, address_id, "Address")
    if a.customer_id != customer_id:
        raise AppError(404, "not_found", "Address not found")
    before = snapshot(a)
    _clear_defaults(db, customer_id, body, keep_id=a.id)
    for k, v in body.model_dump().items():
        setattr(a, k, v)
    audit(db, "update", a, before=before)
    return a


@router.post("/{customer_id}/addresses/{address_id}/archive", status_code=204)
def archive_address(customer_id: int, address_id: int, db: DB, _: User = EDIT):
    a = get_or_404(db, CustomerAddress, address_id, "Address")
    if a.customer_id != customer_id:
        raise AppError(404, "not_found", "Address not found")
    a.archived_at = func.now()
    audit(db, "archive", a)


@router.get("/{customer_id}/notes", response_model=list[NoteOut])
def list_notes(customer_id: int, db: DB, _: User = VIEW):
    return db.scalars(select(CustomerNote).where(CustomerNote.customer_id == customer_id)
                      .order_by(CustomerNote.id.desc())).all()


@router.post("/{customer_id}/notes", response_model=NoteOut, status_code=201)
def add_note(customer_id: int, body: NoteIn, db: DB, _: User = EDIT):
    get_or_404(db, Customer, customer_id, "Customer")
    n = CustomerNote(customer_id=customer_id, **body.model_dump())
    db.add(n)
    audit(db, "create", n)
    return n
