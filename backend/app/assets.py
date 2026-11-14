"""Fixed assets & equipment: register, maintenance/repairs, straight-line depreciation posted monthly, disposal."""

from datetime import date, timedelta
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import Date, ForeignKey, Integer, Numeric, String, Text, func, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.accounting.models import JournalEntry
from app.accounting.posting import CASH_ACCOUNT, post_entry
from app.audit import audit, snapshot
from app.auth.access import require_access
from app.auth.models import User
from app.clock import local_today
from app.crud import RecordOut, crud_router, get_or_404
from app.db import DB, Base, Entity, Money
from app.errors import AppError
from app.products.pricing import money

ZERO = Decimal(0)
Category = Literal["equipment", "furniture", "computer", "appliance", "vehicle", "building", "other"]


class Asset(Entity, Base):
    __tablename__ = "assets"
    asset_code: Mapped[str] = mapped_column(String(30), unique=True)
    name: Mapped[str] = mapped_column(String(150))
    category: Mapped[str] = mapped_column(String(20))
    supplier_id: Mapped[int | None] = mapped_column(ForeignKey("suppliers.id"))
    purchase_date: Mapped[date | None] = mapped_column(Date)
    cost: Mapped[Money] = mapped_column(default=Decimal(0))
    serial_number: Mapped[str | None] = mapped_column(String(100))
    location: Mapped[str | None] = mapped_column(String(120))
    branch_id: Mapped[int | None] = mapped_column(ForeignKey("branches.id"))
    assigned_to_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    assigned_to_name: Mapped[str | None] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(20), default="in_use")  # in_use|under_repair|idle|retired|disposed
    warranty_until: Mapped[date | None] = mapped_column(Date)
    useful_life_months: Mapped[int | None] = mapped_column(Integer)  # None = not depreciated
    salvage_value: Mapped[Money] = mapped_column(default=Decimal(0))
    depreciation_start: Mapped[date | None] = mapped_column(Date)
    disposed_on: Mapped[date | None] = mapped_column(Date)
    disposal_proceeds: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    notes: Mapped[str | None] = mapped_column(Text)


class MaintenanceRecord(Entity, Base):
    __tablename__ = "asset_maintenance"
    asset_id: Mapped[int] = mapped_column(ForeignKey("assets.id"), index=True)
    kind: Mapped[str] = mapped_column(String(20))  # scheduled | repair | inspection | replacement
    record_date: Mapped[date] = mapped_column(Date)
    cost: Mapped[Money] = mapped_column(default=Decimal(0))
    vendor: Mapped[str | None] = mapped_column(String(150))
    description: Mapped[str] = mapped_column(Text)
    downtime_hours: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    next_due_date: Mapped[date | None] = mapped_column(Date, index=True)


def monthly_depreciation(a: Asset) -> Decimal:
    if not a.useful_life_months:
        return ZERO
    return money((a.cost - a.salvage_value) / a.useful_life_months)


def accumulated(db: Session, a: Asset) -> Decimal:
    return db.scalar(select(func.coalesce(func.count(), 0)).select_from(JournalEntry).where(
        JournalEntry.source_type == "asset_depreciation", JournalEntry.source_id == a.id)) * monthly_depreciation(a)


def book_value(db: Session, a: Asset) -> Decimal:
    return a.cost - accumulated(db, a)


def depreciate(db: Session, until: date | None = None) -> str:
    """Post every month of depreciation that is due and not yet posted (idempotent: one entry per month)."""
    until = until or local_today()
    n = 0
    for a in db.scalars(select(Asset).where(Asset.useful_life_months.is_not(None), Asset.disposed_on.is_(None),
                                            Asset.archived_at.is_(None))):
        start = a.depreciation_start or a.purchase_date
        if not start:
            continue
        posted = {e.kind for e in db.scalars(select(JournalEntry).where(
            JournalEntry.source_type == "asset_depreciation", JournalEntry.source_id == a.id))}
        amount = monthly_depreciation(a)
        for k in range(a.useful_life_months):  # one charge at the end of each month of the asset's life
            y, m = divmod(start.month - 1 + k, 12)
            month_end = date(start.year + y + (m + 1) // 12, (m + 1) % 12 + 1, 1) - timedelta(days=1)
            if month_end > until:
                break
            if f"{month_end:%Y%m}" in posted:
                continue
            post_entry(db, month_end, [("6100", amount, 0, {}), ("1410", 0, amount, {})],
                       f"Depreciation {a.asset_code} {month_end:%b %Y}", ("asset_depreciation", a.id),
                       kind=f"{month_end:%Y%m}")
            n += 1
    return f"{n} depreciation entries"


# ---------- schemas ----------

class AssetIn(BaseModel):
    asset_code: str = Field(min_length=1, max_length=30)
    name: str = Field(min_length=1)
    category: Category
    supplier_id: int | None = None
    purchase_date: date | None = None
    cost: Decimal = Field(ZERO, ge=0)
    serial_number: str | None = None
    location: str | None = None
    branch_id: int | None = None
    assigned_to_id: int | None = None
    assigned_to_name: str | None = None
    status: Literal["in_use", "under_repair", "idle", "retired"] = "in_use"
    warranty_until: date | None = None
    useful_life_months: int | None = Field(None, ge=1)
    salvage_value: Decimal = Field(ZERO, ge=0)
    depreciation_start: date | None = None
    notes: str | None = None


class AssetCreate(AssetIn):
    record_purchase: Literal["no", "cash", "bank_transfer", "payable"] = "no"  # post the purchase to the ledger


class AssetPatch(BaseModel):
    name: str | None = None
    serial_number: str | None = None
    location: str | None = None
    branch_id: int | None = None
    assigned_to_id: int | None = None
    assigned_to_name: str | None = None
    status: Literal["in_use", "under_repair", "idle", "retired"] | None = None
    warranty_until: date | None = None
    notes: str | None = None


class AssetOut(RecordOut, AssetIn):
    status: str
    disposed_on: date | None
    disposal_proceeds: Decimal | None
    monthly_depreciation: Decimal = ZERO
    accumulated_depreciation: Decimal = ZERO
    book_value: Decimal = ZERO


class MaintIn(BaseModel):
    asset_id: int
    kind: Literal["scheduled", "repair", "inspection", "replacement"]
    record_date: date
    cost: Decimal = Field(ZERO, ge=0)
    vendor: str | None = None
    description: str = Field(min_length=1)
    downtime_hours: Decimal | None = Field(None, ge=0)
    next_due_date: date | None = None


class MaintPatch(BaseModel):
    description: str | None = None
    cost: Decimal | None = Field(None, ge=0)
    next_due_date: date | None = None


class MaintOut(RecordOut, MaintIn):
    pass


class DisposeIn(BaseModel):
    disposed_on: date | None = None
    proceeds: Decimal = Field(ZERO, ge=0)
    method: Literal["cash", "bank_transfer"] = "bank_transfer"
    note: str | None = None


def asset_out(db: Session, a: Asset) -> AssetOut:
    o = AssetOut.model_validate(a)
    o.monthly_depreciation = monthly_depreciation(a)
    o.accumulated_depreciation = accumulated(db, a)
    o.book_value = a.cost - o.accumulated_depreciation
    return o


# ---------- routes ----------

router = APIRouter(prefix="/assets", tags=["assets"])
VIEW, CREATE, EDIT = (require_access("assets", a) for a in ("view", "create", "edit"))


@router.post("", response_model=AssetOut, status_code=201)
def create_asset(body: AssetCreate, db: DB, _: User = CREATE):
    data = body.model_dump(exclude={"record_purchase"})
    a = Asset(**data)
    db.add(a)
    db.flush()
    if body.record_purchase != "no" and a.cost:
        credit = "2000" if body.record_purchase == "payable" else CASH_ACCOUNT[body.record_purchase]
        post_entry(db, a.purchase_date or local_today(),
                   [("1400", a.cost, 0, {}), (credit, 0, a.cost, {"supplier_id": a.supplier_id})],
                   f"Asset purchase {a.asset_code} {a.name}", ("asset", a.id))
    audit(db, "create", a)
    return asset_out(db, a)


@router.get("/{asset_id}", response_model=AssetOut)
def read_asset(asset_id: int, db: DB, _: User = VIEW):
    return asset_out(db, get_or_404(db, Asset, asset_id, "Asset"))


@router.get("/{asset_id}/maintenance", response_model=list[MaintOut])
def asset_maintenance(asset_id: int, db: DB, _: User = VIEW):
    return db.scalars(select(MaintenanceRecord).where(MaintenanceRecord.asset_id == asset_id)
                      .order_by(MaintenanceRecord.record_date.desc())).all()


@router.post("/{asset_id}/dispose", response_model=AssetOut)
def dispose(asset_id: int, body: DisposeIn, db: DB, _: User = EDIT):
    """Sell or scrap: removes cost and depreciation from the books; the difference is a gain or loss."""
    a = get_or_404(db, Asset, asset_id, "Asset")
    if a.disposed_on:
        raise AppError(409, "disposed", "Already disposed")
    on = body.disposed_on or local_today()
    depreciate(db, on)
    acc = accumulated(db, a)
    gain = body.proceeds - (a.cost - acc)
    lines = [("1410", acc, 0, {}), (CASH_ACCOUNT[body.method], body.proceeds, 0, {}), ("1400", 0, a.cost, {})]
    lines.append(("4910", 0, gain, {}) if gain >= 0 else ("6000", -gain, 0, {}))
    if db.scalar(select(JournalEntry.id).where(JournalEntry.source_type == "asset", JournalEntry.source_id == a.id)):
        post_entry(db, on, lines, f"Disposal of {a.asset_code}", ("asset", a.id), kind="dispose")
    a.disposed_on, a.disposal_proceeds, a.status = on, body.proceeds, "disposed"
    audit(db, "dispose", entity_type="assets", entity_id=a.id, note=body.note)
    return asset_out(db, a)


@router.get("")
def register(db: DB, status: str | None = None, category: str | None = None, _: User = VIEW):
    q = select(Asset).where(Asset.archived_at.is_(None)).order_by(Asset.asset_code)
    if status:
        q = q.where(Asset.status == status)
    if category:
        q = q.where(Asset.category == category)
    items = [asset_out(db, a) for a in db.scalars(q)]
    return {"items": items, "total_cost": sum((i.cost for i in items), ZERO),
            "total_book_value": sum((i.book_value for i in items), ZERO)}


def due_maintenance(db: Session) -> list[tuple[MaintenanceRecord, Asset]]:
    """Latest record per asset whose next maintenance is due within 7 days."""
    latest = (select(MaintenanceRecord.asset_id, func.max(MaintenanceRecord.id).label("id"))
              .group_by(MaintenanceRecord.asset_id).subquery())
    return db.execute(select(MaintenanceRecord, Asset).join(latest, latest.c.id == MaintenanceRecord.id)
                      .join(Asset, Asset.id == MaintenanceRecord.asset_id)
                      .where(MaintenanceRecord.next_due_date <= local_today() + timedelta(days=7),
                             Asset.disposed_on.is_(None))).all()


crud_routers = [
    crud_router(MaintenanceRecord, prefix="/asset-maintenance", feature="assets", create=MaintIn, update=MaintPatch,
                out=MaintOut, filters={"asset_id": MaintenanceRecord.asset_id, "kind": MaintenanceRecord.kind},
                default_sort=MaintenanceRecord.record_date.desc(), tags=["assets"]),
]


@router.patch("/{asset_id}", response_model=AssetOut)
def update_asset(asset_id: int, body: AssetPatch, db: DB, _: User = EDIT):
    a = get_or_404(db, Asset, asset_id, "Asset")
    before = snapshot(a)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(a, k, v)
    audit(db, "update", a, before=before)
    return asset_out(db, a)


routers = [router, *crud_routers]
