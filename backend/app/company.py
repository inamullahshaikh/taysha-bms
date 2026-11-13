"""Company profile and master data: branches, departments, tax rates, units, financial periods, numbering."""

from datetime import date
from decimal import Decimal

from fastapi import APIRouter, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import Boolean, Date, ForeignKey, Index, Numeric, String, Text, select, update
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.attachments import ALLOWED_TYPES, read_file, store
from app.audit import audit, snapshot
from app.auth.access import require_access
from app.auth.models import User
from app.crud import RecordOut, crud_router, get_or_404
from app.db import DB, Base, Entity
from app.errors import AppError
from app.numbering import DOC_TYPES, NumberSequence, format_number, get_sequence
from app.clock import local_today

VIEW = require_access("settings", "view")
EDIT = require_access("settings", "edit")


# ---------- models ----------

class Company(Entity, Base):
    """Single row (id=1)."""

    __tablename__ = "company"

    name: Mapped[str] = mapped_column(String(200))
    legal_name: Mapped[str | None] = mapped_column(String(200))
    address: Mapped[str | None] = mapped_column(Text)
    phone: Mapped[str | None] = mapped_column(String(50))
    email: Mapped[str | None] = mapped_column(String(254))
    website: Mapped[str | None] = mapped_column(String(200))
    ntn: Mapped[str | None] = mapped_column(String(50))  # national tax number
    strn: Mapped[str | None] = mapped_column(String(50))  # sales tax registration number
    bank_details: Mapped[str | None] = mapped_column(Text)
    invoice_terms: Mapped[str | None] = mapped_column(Text)  # printed at the bottom of invoices
    logo_key: Mapped[str | None] = mapped_column(String(255))
    logo_content_type: Mapped[str | None] = mapped_column(String(100))
    brand_color: Mapped[str | None] = mapped_column(String(7))  # e.g. #8B4513
    expense_approval_limit: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))  # above this: owner approves
    purchase_approval_limit: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    default_warehouse_id: Mapped[int | None] = mapped_column(ForeignKey("warehouses.id", use_alter=True))


class Branch(Entity, Base):
    __tablename__ = "branches"
    code: Mapped[str] = mapped_column(String(20), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    address: Mapped[str | None] = mapped_column(Text)
    phone: Mapped[str | None] = mapped_column(String(50))


class Department(Entity, Base):
    __tablename__ = "departments"
    name: Mapped[str] = mapped_column(String(120), unique=True)


class TaxRate(Entity, Base):
    __tablename__ = "tax_rates"
    __table_args__ = (Index("uq_tax_rates_default", "is_default", unique=True, postgresql_where="is_default"),)
    name: Mapped[str] = mapped_column(String(80), unique=True)
    rate: Mapped[Decimal] = mapped_column(Numeric(5, 2))  # percent
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)


class Unit(Entity, Base):
    """Global units. factor converts to the dimension's base unit (g, ml, pcs). Product-specific packs
    (carton = 12 pcs) live on the product."""

    __tablename__ = "units"
    code: Mapped[str] = mapped_column(String(20), unique=True)
    name: Mapped[str] = mapped_column(String(60))
    dimension: Mapped[str] = mapped_column(String(20))  # mass | volume | count
    factor: Mapped[Decimal] = mapped_column(Numeric(18, 6))


class FinancialPeriod(Entity, Base):
    __tablename__ = "financial_periods"
    name: Mapped[str] = mapped_column(String(60), unique=True)
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date] = mapped_column(Date)
    is_closed: Mapped[bool] = mapped_column(Boolean, default=False)


def get_company(db: Session) -> Company:
    c = db.get(Company, 1)
    if c is None:  # seeded by migration; recreated defensively
        c = Company(id=1, name="Taysha")
        db.add(c)
        db.flush()
    return c


def convert(db: Session, qty: Decimal, from_code: str, to_code: str) -> Decimal:
    """Convert between global units of the same dimension (kg -> g, l -> ml)."""
    if from_code == to_code:
        return qty
    units = {u.code: u for u in db.scalars(select(Unit).where(Unit.code.in_([from_code, to_code])))}
    a, b = units.get(from_code), units.get(to_code)
    if a is None or b is None or a.dimension != b.dimension:
        raise AppError(422, "unit_mismatch", f"Can't convert {from_code} to {to_code}")
    return qty * a.factor / b.factor


# ---------- schemas ----------

class CompanyIn(BaseModel):
    name: str | None = None
    legal_name: str | None = None
    address: str | None = None
    phone: str | None = None
    email: str | None = None
    website: str | None = None
    ntn: str | None = None
    strn: str | None = None
    bank_details: str | None = None
    invoice_terms: str | None = None
    brand_color: str | None = Field(None, pattern=r"^#[0-9A-Fa-f]{6}$")
    expense_approval_limit: Decimal | None = Field(None, ge=0)
    purchase_approval_limit: Decimal | None = Field(None, ge=0)
    default_warehouse_id: int | None = None


class CompanyOut(CompanyIn):
    model_config = {"from_attributes": True}
    name: str
    has_logo: bool = False


class BranchIn(BaseModel):
    code: str = Field(min_length=1, max_length=20)
    name: str = Field(min_length=1)
    address: str | None = None
    phone: str | None = None


class BranchPatch(BaseModel):
    code: str | None = None
    name: str | None = None
    address: str | None = None
    phone: str | None = None


class BranchOut(RecordOut, BranchIn):
    pass


class DepartmentIn(BaseModel):
    name: str = Field(min_length=1)


class DepartmentOut(RecordOut, DepartmentIn):
    pass


class TaxRateIn(BaseModel):
    name: str = Field(min_length=1)
    rate: Decimal = Field(ge=0, le=100)


class TaxRatePatch(BaseModel):
    name: str | None = None
    rate: Decimal | None = Field(None, ge=0, le=100)


class TaxRateOut(RecordOut, TaxRateIn):
    is_default: bool


class UnitIn(BaseModel):
    code: str = Field(min_length=1, max_length=20)
    name: str
    dimension: str = Field(pattern="^(mass|volume|count)$")
    factor: Decimal = Field(gt=0)


class UnitPatch(BaseModel):
    name: str | None = None
    factor: Decimal | None = Field(None, gt=0)


class UnitOut(RecordOut, UnitIn):
    pass


class PeriodIn(BaseModel):
    name: str
    start_date: date
    end_date: date

    @model_validator(mode="after")
    def _order(self):
        if self.end_date < self.start_date:
            raise ValueError("end_date must be on or after start_date")
        return self


class PeriodPatch(BaseModel):
    name: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    is_closed: bool | None = None


class PeriodOut(RecordOut, PeriodIn):
    is_closed: bool


class SequenceOut(BaseModel):
    doc_type: str
    label: str
    prefix: str
    padding: int
    yearly_reset: bool
    next_value: int
    preview: str


class SequencePatch(BaseModel):
    prefix: str | None = Field(None, max_length=20)
    padding: int | None = Field(None, ge=1, le=10)
    yearly_reset: bool | None = None
    next_value: int | None = Field(None, ge=1)


# ---------- routes ----------

router = APIRouter(prefix="/settings", tags=["settings"])


def company_out(c: Company) -> CompanyOut:
    out = CompanyOut.model_validate(c)
    out.has_logo = c.logo_key is not None
    return out


@router.get("/company", response_model=CompanyOut)
def read_company(db: DB, _: User = VIEW):
    return company_out(get_company(db))


@router.get("/company/public", response_model=CompanyOut)
def read_company_public(db: DB):
    """Name/logo/colour for the login screen; no sensitive fields beyond what's printed on invoices."""
    return company_out(get_company(db))


@router.patch("/company", response_model=CompanyOut)
def update_company(body: CompanyIn, db: DB, _: User = EDIT):
    c = get_company(db)
    before = snapshot(c)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(c, k, v)
    audit(db, "update", c, before=before)
    return company_out(c)


@router.put("/company/logo", response_model=CompanyOut)
def upload_logo(file: UploadFile, db: DB, _: User = EDIT):
    if file.content_type not in ALLOWED_TYPES or not file.content_type.startswith("image/"):
        raise AppError(422, "file_type", "Logo must be an image", {"file": "type"})
    data = file.file.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024:
        raise AppError(413, "file_too_large", "Logo must be under 2 MB", {"file": "size"})
    c = get_company(db)
    c.logo_key, c.logo_content_type = store(data), file.content_type
    audit(db, "update", entity_type="company", entity_id=1, after={"logo": "changed"})
    return company_out(c)


@router.get("/company/logo")
def get_logo(db: DB):
    c = get_company(db)
    if not c.logo_key:
        raise AppError(404, "not_found", "No logo uploaded")
    return Response(read_file(c.logo_key), media_type=c.logo_content_type,
                    headers={"Cache-Control": "max-age=300"})


@router.post("/tax-rates/{id}/make-default", response_model=TaxRateOut)
def make_default_tax(id: int, db: DB, _: User = EDIT):
    t = get_or_404(db, TaxRate, id, "Tax rate")
    db.execute(update(TaxRate).where(TaxRate.is_default).values(is_default=False))
    db.flush()
    t.is_default = True
    audit(db, "update", entity_type="tax_rates", entity_id=t.id, after={"is_default": True})
    return t


def default_tax_rate(db: Session) -> TaxRate | None:
    return db.scalar(select(TaxRate).where(TaxRate.is_default, TaxRate.archived_at.is_(None)))


def seq_out(s: NumberSequence) -> SequenceOut:
    return SequenceOut(doc_type=s.doc_type, label=DOC_TYPES[s.doc_type][1], prefix=s.prefix, padding=s.padding,
                       yearly_reset=s.yearly_reset, next_value=s.next_value,
                       preview=format_number(s, s.next_value, local_today().year))


@router.get("/numbering", response_model=list[SequenceOut])
def list_numbering(db: DB, _: User = VIEW):
    return [seq_out(get_sequence(db, t)) for t in DOC_TYPES]


@router.patch("/numbering/{doc_type}", response_model=SequenceOut)
def update_numbering(doc_type: str, body: SequencePatch, db: DB, _: User = EDIT):
    if doc_type not in DOC_TYPES:
        raise AppError(404, "not_found", "Unknown document type")
    s = get_sequence(db, doc_type, lock=True)
    before = {"prefix": s.prefix, "padding": s.padding, "yearly_reset": s.yearly_reset, "next_value": s.next_value}
    data = body.model_dump(exclude_unset=True)
    if data.get("next_value") is not None and data["next_value"] < s.next_value:
        raise AppError(422, "number_backwards", "The next number can only move forward (avoids duplicates)",
                       {"next_value": f"must be at least {s.next_value}"})
    for k, v in data.items():
        setattr(s, k, v)
    audit(db, "update", entity_type="number_sequences", note=doc_type, before=before, after={**before, **data})
    return seq_out(s)


crud_routers = [
    crud_router(Branch, prefix="/settings/branches", feature="settings", create=BranchIn, update=BranchPatch,
                out=BranchOut, search=(Branch.name, Branch.code), default_sort=Branch.name, tags=["settings"]),
    crud_router(Department, prefix="/settings/departments", feature="settings", create=DepartmentIn,
                update=DepartmentIn, out=DepartmentOut, default_sort=Department.name, tags=["settings"]),
    crud_router(TaxRate, prefix="/settings/tax-rates", feature="settings", create=TaxRateIn, update=TaxRatePatch,
                out=TaxRateOut, default_sort=TaxRate.name, tags=["settings"]),
    crud_router(Unit, prefix="/settings/units", feature="settings", create=UnitIn, update=UnitPatch, out=UnitOut,
                search=(Unit.code, Unit.name), default_sort=Unit.code, tags=["settings"]),
    crud_router(FinancialPeriod, prefix="/settings/periods", feature="settings", create=PeriodIn,
                update=PeriodPatch, out=PeriodOut, default_sort=FinancialPeriod.start_date, tags=["settings"]),
]

routers = [router, *crud_routers]
