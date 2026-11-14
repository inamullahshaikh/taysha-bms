"""Advanced reports: period comparison, slow-moving stock, wastage, cost changes, saved views and scheduled
(emailed) reports."""

import io
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import Boolean, Date, DateTime, String, func, or_, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.audit import audit
from app.auth.access import can, require_access
from app.auth.deps import CurrentUser
from app.auth.models import User
from app.clock import local_today, utcnow
from app.crud import RecordOut, crud_router, get_or_404
from app.db import DB, Base, Entity
from app.errors import AppError
from app.inventory.models import ProductStockCost, StockBalance, StockMovement
from app.mailer import send_email
from app.products.models import Product, ProductCost
from app.receivables import receivables_aging
from app.reports import Range, expenses_by, period, profit_and_loss, sales_by
from app.wholesale import advance as monthly

ZERO = Decimal(0)


class SavedView(Entity, Base):
    __tablename__ = "saved_views"
    name: Mapped[str] = mapped_column(String(120))
    report: Mapped[str] = mapped_column(String(50))  # frontend route / report key
    params: Mapped[dict] = mapped_column(JSONB, default=dict)
    shared: Mapped[bool] = mapped_column(Boolean, default=False)


class ScheduledReport(Entity, Base):
    __tablename__ = "scheduled_reports"
    name: Mapped[str] = mapped_column(String(120))
    report: Mapped[str] = mapped_column(String(30))
    params: Mapped[dict] = mapped_column(JSONB, default=dict)
    frequency: Mapped[str] = mapped_column(String(10))  # daily | weekly | monthly
    recipients: Mapped[list] = mapped_column(JSONB, default=list)
    next_run: Mapped[date] = mapped_column(Date, index=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


# ---------- report building blocks ----------

def slow_moving(db: Session, days: int) -> list[dict]:
    since = local_today() - timedelta(days=days)
    moved = select(StockMovement.product_id).where(StockMovement.reason.in_(("sale", "production_out")),
                                                   StockMovement.movement_date >= since)
    rows = db.execute(select(Product.id, Product.sku, Product.name, Product.type, func.sum(StockBalance.quantity),
                             func.max(ProductStockCost.avg_cost))
                      .join(StockBalance, StockBalance.product_id == Product.id)
                      .outerjoin(ProductStockCost, ProductStockCost.product_id == Product.id)
                      .where(Product.id.not_in(moved)).group_by(Product.id)
                      .having(func.sum(StockBalance.quantity) > 0))
    out = []
    for pid, sku, name, typ, qty, cost in rows:
        last = db.scalar(select(func.max(StockMovement.movement_date)).where(
            StockMovement.product_id == pid, StockMovement.reason.in_(("sale", "production_out"))))
        out.append({"product_id": pid, "sku": sku, "name": name, "type": typ, "on_hand": qty,
                    "value": (qty * (cost or ZERO)).quantize(Decimal("0.01")), "last_used": last,
                    "days_idle": (local_today() - last).days if last else None})
    return sorted(out, key=lambda r: -r["value"])


def wastage(db: Session, start: date, end: date) -> list[dict]:
    from app.production.models import ProductionOrder as PO

    prod = {pid: (out or ZERO, rej or ZERO, waste or ZERO) for pid, out, rej, waste in db.execute(
        select(PO.product_id, func.sum(PO.output_quantity), func.sum(PO.rejected_quantity), func.sum(PO.wastage_quantity))
        .where(PO.status == "completed", func.date(PO.completed_at).between(start, end)).group_by(PO.product_id))}
    writeoffs = {pid: (q, v) for pid, q, v in db.execute(
        select(StockMovement.product_id, func.sum(-StockMovement.quantity),
               func.sum(-StockMovement.quantity * func.coalesce(StockMovement.unit_cost, 0)))
        .where(StockMovement.reason.in_(("wastage", "damage", "expired")),
               StockMovement.movement_date.between(start, end)).group_by(StockMovement.product_id))}
    out = []
    for pid in set(prod) | set(writeoffs):
        p = db.get(Product, pid)
        made, rej, waste = prod.get(pid, (ZERO, ZERO, ZERO))
        wq, wv = writeoffs.get(pid, (ZERO, ZERO))
        total = made + rej + waste
        out.append({"product_id": pid, "name": p.name, "produced": made, "rejected": rej, "production_wastage": waste,
                    "production_loss_pct": ((rej + waste) / total * 100).quantize(Decimal("0.1")) if total else None,
                    "written_off_qty": wq, "written_off_value": Decimal(wv).quantize(Decimal("0.01"))})
    return sorted(out, key=lambda r: -(r["written_off_value"] + (r["production_loss_pct"] or 0)))


def cost_changes(db: Session, days: int) -> list[dict]:
    """Purchase cost per unit: first vs latest receipt in the window; and standard cost changes."""
    since = local_today() - timedelta(days=days)
    out = []
    rows = db.execute(select(StockMovement.product_id, StockMovement.movement_date, StockMovement.unit_cost)
                      .where(StockMovement.reason == "purchase_receipt", StockMovement.movement_date >= since,
                             StockMovement.unit_cost.is_not(None))
                      .order_by(StockMovement.product_id, StockMovement.id)).all()
    by: dict[int, list] = {}
    for pid, d, c in rows:
        by.setdefault(pid, []).append((d, c))
    changed = db.scalars(select(ProductCost.product_id).where(func.date(ProductCost.created_at) >= since)
                         .distinct()).all()
    last_two: dict[int, list] = {}  # newest two standard costs per changed product, one query
    for pc in db.scalars(select(ProductCost).where(ProductCost.product_id.in_(changed)).order_by(
            ProductCost.product_id, ProductCost.effective_from.desc(), ProductCost.id.desc())):
        if len(last_two.setdefault(pc.product_id, [])) < 2:
            last_two[pc.product_id].append(pc)
    names = dict(db.execute(select(Product.id, Product.name).where(Product.id.in_(set(by) | set(changed)))).all())
    for pid, seq in by.items():
        first, last = seq[0][1], seq[-1][1]
        if first and first != last:
            out.append({"product_id": pid, "name": names[pid], "source": "purchases",
                        "from": first.quantize(Decimal("0.0001")), "to": last.quantize(Decimal("0.0001")),
                        "change_pct": ((last - first) / first * 100).quantize(Decimal("0.1"))})
    for pid in changed:
        hist = last_two.get(pid, [])
        if len(hist) == 2 and hist[1].total and hist[0].total != hist[1].total:
            out.append({"product_id": pid, "name": names[pid], "source": "standard cost",
                        "from": hist[1].total, "to": hist[0].total,
                        "change_pct": ((hist[0].total - hist[1].total) / hist[1].total * 100).quantize(Decimal("0.1"))})
    return sorted(out, key=lambda r: -abs(r["change_pct"]))


# ---------- endpoints ----------

router = APIRouter(prefix="/reports", tags=["reports"])
INV_VIEW, COST_VIEW = require_access("inventory", "view"), require_access("product_costs", "view")
Dim = Literal["product", "channel", "customer", "order_type", "city", "month", "source", "branch", "territory",
              "sales_rep"]


@router.get("/compare")
def compare(db: DB, a_from: date, a_to: date, b_from: date, b_to: date, group_by: Dim = "channel",
            metric: Literal["revenue", "net_sales", "orders"] = "revenue", _: User = require_access("orders", "view")):
    """Period A vs period B for any sales breakdown."""
    a = {r["key"]: r for r in sales_by(db, a_from, a_to, group_by)}
    b = {r["key"]: r for r in sales_by(db, b_from, b_to, group_by)}
    rows = []
    for k in set(a) | set(b):
        va, vb = (a.get(k) or {}).get(metric) or ZERO, (b.get(k) or {}).get(metric) or ZERO
        rows.append({"key": k, "label": (a.get(k) or b.get(k)).get("label", k), "a": va, "b": vb,
                     "change": vb - va, "change_pct": round(Decimal(vb - va) / va * 100, 1) if va else None})
    return {"metric": metric, "a": {"from": a_from, "to": a_to}, "b": {"from": b_from, "to": b_to},
            "rows": sorted(rows, key=lambda r: -abs(r["change"]))}


@router.get("/slow-moving")
def slow_moving_report(db: DB, days: int = 60, _: User = INV_VIEW):
    return slow_moving(db, days)


@router.get("/wastage")
def wastage_report(db: DB, range: Range = "month", date_from: date | None = None, date_to: date | None = None,
                   _: User = INV_VIEW):
    start, end = period(range, date_from, date_to)
    return {"from": start, "to": end, "rows": wastage(db, start, end)}


@router.get("/cost-changes")
def cost_changes_report(db: DB, days: int = 90, _: User = COST_VIEW):
    return cost_changes(db, days)


# ---------- saved views ----------

class ViewIn(BaseModel):
    name: str = Field(min_length=1)
    report: str
    params: dict = {}
    shared: bool = False


views = APIRouter(prefix="/saved-views", tags=["reports"])


@views.get("")
def list_views(user: CurrentUser, db: DB, report: str | None = None):
    q = select(SavedView).where(SavedView.archived_at.is_(None),
                                or_(SavedView.created_by_id == user.id, SavedView.shared)).order_by(SavedView.name)
    if report:
        q = q.where(SavedView.report == report)
    return [{"id": v.id, "name": v.name, "report": v.report, "params": v.params, "shared": v.shared,
             "mine": v.created_by_id == user.id} for v in db.scalars(q)]


@views.post("", status_code=201)
def save_view(body: ViewIn, user: CurrentUser, db: DB):
    if body.shared and not can(db, user, "reports", "edit"):
        raise AppError(403, "forbidden", "Sharing report views needs report edit access")
    v = SavedView(**body.model_dump())
    db.add(v)
    db.flush()
    return {"id": v.id}


@views.delete("/{view_id}", status_code=204)
def delete_view(view_id: int, user: CurrentUser, db: DB):
    v = get_or_404(db, SavedView, view_id, "Saved view")
    if v.created_by_id != user.id:
        raise AppError(403, "forbidden", "Only the owner can remove a saved view")
    v.archived_at = utcnow()


# ---------- scheduled reports ----------

REPORTS = ("sales", "expenses", "profit_loss", "receivables_aging", "slow_moving")


def build(db: Session, report: str, params: dict) -> tuple[str, list[dict]]:
    rng = params.get("range", "month")
    if report == "sales":
        start, end = period(rng, None, None)
        return f"Sales by {params.get('group_by', 'product')}", sales_by(db, start, end, params.get("group_by", "product"))
    if report == "expenses":
        start, end = period(rng, None, None)
        return "Expenses by category", expenses_by(db, start, end, params.get("group_by", "category"))
    if report == "profit_loss":
        start, end = period(rng, None, None)
        pl = profit_and_loss(db, start, end)
        return "Profit & loss", [{"line": k, "amount": v} for k, v in pl.items() if not isinstance(v, list)]
    if report == "receivables_aging":
        return "Receivables aging", receivables_aging(db)["rows"]
    if report == "slow_moving":
        return "Slow-moving stock", slow_moving(db, int(params.get("days", 60)))
    raise AppError(422, "unknown_report", f"Unknown report {report}")


def to_xlsx(title: str, rows: list[dict]) -> bytes:
    from openpyxl import Workbook  # heavy; only loaded when a scheduled report is sent

    wb = Workbook()
    ws = wb.active
    ws.title = title[:30]
    cols = list(rows[0].keys()) if rows else ["(no data)"]
    ws.append(cols)
    for r in rows:
        ws.append([float(v) if isinstance(v, Decimal) else v for v in (r.get(c) for c in cols)])
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def advance(d: date, freq: str) -> date:
    if freq == "daily":
        return d + timedelta(days=1)
    if freq == "weekly":
        return d + timedelta(days=7)
    return monthly(d, "monthly")


def send_scheduled(db: Session, r: ScheduledReport) -> None:
    title, rows = build(db, r.report, r.params)
    data = to_xlsx(title, rows)
    for to in r.recipients:
        send_email(to, f"[Taysha] {r.name}", f"{r.name}: {len(rows)} rows attached.",
                   [(data, f"{r.report}-{local_today()}.xlsx")])
    r.last_sent_at = utcnow()


def run_scheduled(db: Session) -> str:
    n = 0
    for r in db.scalars(select(ScheduledReport).where(ScheduledReport.active, ScheduledReport.next_run <= local_today(),
                                                      ScheduledReport.archived_at.is_(None))):
        send_scheduled(db, r)
        while r.next_run <= local_today():
            r.next_run = advance(r.next_run, r.frequency)
        n += 1
    return f"{n} scheduled reports sent"


class ScheduleIn(BaseModel):
    name: str = Field(min_length=1)
    report: Literal["sales", "expenses", "profit_loss", "receivables_aging", "slow_moving"]
    params: dict = {}
    frequency: Literal["daily", "weekly", "monthly"]
    recipients: list[EmailStr] = Field(min_length=1)
    next_run: date
    active: bool = True

    def model_dump(self, **kw):
        return super().model_dump(mode="json", **kw)


class SchedulePatch(BaseModel):
    name: str | None = None
    params: dict | None = None
    frequency: Literal["daily", "weekly", "monthly"] | None = None
    recipients: list[EmailStr] | None = None
    next_run: date | None = None
    active: bool | None = None

    def model_dump(self, **kw):
        return super().model_dump(mode="json", **kw)


class ScheduleOut(RecordOut):
    name: str
    report: str
    params: dict
    frequency: str
    recipients: list
    next_run: date
    active: bool
    last_sent_at: datetime | None


sched = APIRouter(prefix="/scheduled-reports", tags=["reports"])


@sched.post("/{rid}/send-now")
def send_now(rid: int, db: DB, _: User = require_access("reports", "edit")):
    r = get_or_404(db, ScheduledReport, rid, "Scheduled report")
    send_scheduled(db, r)
    audit(db, "send", entity_type="scheduled_reports", entity_id=r.id)
    return {"sent_to": r.recipients}


crud_routers = [crud_router(ScheduledReport, prefix="/scheduled-reports", feature="reports", create=ScheduleIn,
                            update=SchedulePatch, out=ScheduleOut, search=(ScheduledReport.name,),
                            default_sort=ScheduledReport.next_run, tags=["reports"])]
routers = [router, views, sched, *crud_routers]
