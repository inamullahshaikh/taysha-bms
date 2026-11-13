"""Point of sale for stalls, pop-ups and events.

Each sale is a normal order (type stall, channel pos) created, paid and handed over in one call. The device
generates the sale id, so offline sales can be synced later without duplicates.
"""

from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import DateTime, ForeignKey, Numeric, String, Text, func, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.audit import audit
from app.auth.access import require_access
from app.auth.models import User
from app.clock import local_today, utcnow
from app.crud import RecordOut, crud_router, get_or_404
from app.db import DB, Base, Entity, Money, Qty
from app.errors import AppError
from app.expenses import Expense
from app.inventory.models import StockMovement
from app.inventory.service import issue, on_hand
from app.numbering import next_number
from app.orders.models import Order, OrderLine, OrderStatusHistory, Payment
from app.orders.router import LineIn, OrderIn
from app.orders.service import apply_priced, change_status, price_order, refresh_payment_status
from app.pdf import pdf_response, render_pdf
from app.products.models import PriceList, Product
from app.products.pricing import resolve_price

ZERO = Decimal(0)


class POSEvent(Entity, Base):
    __tablename__ = "pos_events"
    name: Mapped[str] = mapped_column(String(150))
    kind: Mapped[str] = mapped_column(String(20), default="stall")  # stall | popup | event | branch | other
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"))
    branch_id: Mapped[int | None] = mapped_column(ForeignKey("branches.id"))
    location: Mapped[str | None] = mapped_column(String(200))
    start_date: Mapped[date | None] = mapped_column()
    end_date: Mapped[date | None] = mapped_column()
    status: Mapped[str] = mapped_column(String(20), default="planned")  # planned | open | closed
    notes: Mapped[str | None] = mapped_column(Text)


class POSSession(Entity, Base):
    __tablename__ = "pos_sessions"
    event_id: Mapped[int] = mapped_column(ForeignKey("pos_events.id"), index=True)
    status: Mapped[str] = mapped_column(String(10), default="open")
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    opening_cash: Mapped[Money] = mapped_column(default=Decimal(0))
    expected_cash: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    counted_cash: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    note: Mapped[str | None] = mapped_column(Text)


class EventStockCount(Base):
    __tablename__ = "pos_event_counts"
    event_id: Mapped[int] = mapped_column(ForeignKey("pos_events.id", ondelete="CASCADE"), primary_key=True)
    kind: Mapped[str] = mapped_column(String(10), primary_key=True)  # opening | closing
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), primary_key=True)
    quantity: Mapped[Qty]


# ---------- schemas ----------

class EventIn(BaseModel):
    name: str = Field(min_length=1)
    kind: Literal["stall", "popup", "event", "branch", "other"] = "stall"
    warehouse_id: int
    branch_id: int | None = None
    location: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    notes: str | None = None


class EventPatch(BaseModel):
    name: str | None = None
    location: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    notes: str | None = None


class EventOut(RecordOut, EventIn):
    status: str


class CountLine(BaseModel):
    product_id: int
    quantity: Decimal = Field(ge=0)


class SessionIn(BaseModel):
    event_id: int
    opening_cash: Decimal = Field(ZERO, ge=0)


class SessionClose(BaseModel):
    counted_cash: Decimal = Field(ge=0)
    note: str | None = None


class SessionOut(RecordOut):
    event_id: int
    status: str
    opened_at: datetime
    closed_at: datetime | None
    opening_cash: Decimal
    expected_cash: Decimal | None
    counted_cash: Decimal | None
    note: str | None
    created_by_id: int | None
    cash_variance: Decimal | None = None


class PayIn(BaseModel):
    method: Literal["cash", "card", "online", "bank_transfer", "other"]
    amount: Decimal = Field(gt=0)
    reference: str | None = None


class SaleIn(BaseModel):
    client_id: str = Field(min_length=8, max_length=64)  # generated on the device (uuid)
    session_id: int
    customer_id: int | None = None
    customer_name: str | None = None
    customer_phone: str | None = None
    lines: list[LineIn] = Field(min_length=1)
    order_discount_pct: Decimal = Field(ZERO, ge=0, le=100)
    order_discount_amount: Decimal = Field(ZERO, ge=0)
    discount_code: str | None = None
    payments: list[PayIn] = Field(min_length=1)
    sold_at: datetime | None = None  # when the device made the sale (offline)


class SaleOut(BaseModel):
    order_id: int
    number: str
    grand_total: Decimal
    paid: Decimal
    change: Decimal
    duplicate: bool = False


class ConsumptionIn(BaseModel):
    event_id: int
    reason: Literal["sample", "complimentary", "wastage"]
    note: str | None = None
    lines: list[CountLine] = Field(min_length=1)


# ---------- events & sessions ----------

router = APIRouter(prefix="/pos", tags=["pos"])
VIEW, CREATE, EDIT = (require_access("pos", a) for a in ("view", "create", "edit"))


def get_event(db: Session, event_id: int) -> POSEvent:
    return get_or_404(db, POSEvent, event_id, "Event")


@router.post("/events/{event_id}/open", response_model=EventOut)
def open_event(event_id: int, db: DB, _: User = EDIT):
    e = get_event(db, event_id)
    if e.status == "closed":
        raise AppError(409, "closed", "This event is closed")
    e.status = "open"
    audit(db, "open", entity_type="pos_events", entity_id=e.id)
    return e


@router.post("/events/{event_id}/close", response_model=EventOut)
def close_event(event_id: int, db: DB, _: User = EDIT):
    e = get_event(db, event_id)
    if db.scalar(select(POSSession.id).where(POSSession.event_id == e.id, POSSession.status == "open").limit(1)):
        raise AppError(409, "sessions_open", "Close all cashier sessions first")
    e.status = "closed"
    audit(db, "close", entity_type="pos_events", entity_id=e.id)
    return e


@router.put("/events/{event_id}/counts/{kind}")
def set_counts(event_id: int, kind: Literal["opening", "closing"], body: list[CountLine], db: DB, _: User = CREATE):
    get_event(db, event_id)
    for ln in body:
        row = db.get(EventStockCount, (event_id, kind, ln.product_id))
        if row:
            row.quantity = ln.quantity
        else:
            db.add(EventStockCount(event_id=event_id, kind=kind, product_id=ln.product_id, quantity=ln.quantity))
    audit(db, "count", entity_type="pos_events", entity_id=event_id, note=kind)
    return {"saved": len(body)}


@router.get("/events/{event_id}/products")
def event_products(event_id: int, db: DB, q: str | None = None, _: User = VIEW):
    """Quick-pick grid: sellable products with retail price and stock at the event."""
    e = get_event(db, event_id)
    retail = db.scalar(select(PriceList).where(PriceList.code == "retail"))
    query = select(Product).where(Product.archived_at.is_(None), Product.status == "active",
                                  Product.type == "finished").order_by(Product.name)
    if q:
        query = query.where(Product.name.ilike(f"%{q}%") | Product.sku.ilike(f"%{q}%") | (Product.barcode == q))
    out = []
    for p in db.scalars(query.limit(200)):
        pp = resolve_price(db, p.id, retail.id, local_today()) if retail else None
        out.append({"product_id": p.id, "sku": p.sku, "name": p.name, "barcode": p.barcode,
                    "price": pp.price if pp else None,
                    "in_stock": on_hand(db, p.id, e.warehouse_id, usable_only=True) if p.track_stock else None})
    return out


@router.post("/sessions", response_model=SessionOut, status_code=201)
def open_session(body: SessionIn, db: DB, _: User = CREATE):
    e = get_event(db, body.event_id)
    if e.status != "open":
        raise AppError(409, "event_not_open", "Open the event first")
    s = POSSession(event_id=e.id, opening_cash=body.opening_cash, opened_at=utcnow())
    db.add(s)
    audit(db, "create", s)
    return s


def session_cash(db: Session, s: POSSession) -> Decimal:
    rows = dict(db.execute(select(Payment.kind, func.coalesce(func.sum(Payment.amount), 0))
                           .join(Order, Order.id == Payment.order_id)
                           .where(Order.pos_session_id == s.id, Payment.method == "cash",
                                  Payment.status == "completed").group_by(Payment.kind)).all())
    return s.opening_cash + rows.get("payment", ZERO) - rows.get("refund", ZERO)


@router.post("/sessions/{session_id}/close", response_model=SessionOut)
def close_session(session_id: int, body: SessionClose, db: DB, _: User = CREATE):
    s = get_or_404(db, POSSession, session_id, "Session")
    if s.status != "open":
        raise AppError(409, "closed", "Session already closed")
    s.expected_cash, s.counted_cash, s.note = session_cash(db, s), body.counted_cash, body.note
    s.status, s.closed_at = "closed", utcnow()
    audit(db, "close", entity_type="pos_sessions", entity_id=s.id,
          after={"expected": str(s.expected_cash), "counted": str(s.counted_cash)})
    out = SessionOut.model_validate(s)
    out.cash_variance = s.counted_cash - s.expected_cash
    return out


# ---------- sales ----------

def make_sale(db: Session, user: User, body: SaleIn) -> SaleOut:
    existing = db.scalar(select(Order).where(Order.source == "pos", Order.external_id == body.client_id))
    if existing:
        return SaleOut(order_id=existing.id, number=existing.number, grand_total=existing.grand_total,
                       paid=existing.paid_total, change=ZERO, duplicate=True)
    s = get_or_404(db, POSSession, body.session_id, "Session")
    e = db.get(POSEvent, s.event_id)
    if s.status != "open" and body.sold_at is None:  # offline sales may arrive after the session closed
        raise AppError(409, "session_closed", "This cashier session is closed")
    oin = OrderIn(customer_id=body.customer_id, customer_name=body.customer_name or "Walk-in",
                  customer_phone=body.customer_phone, order_type="stall", channel="pos", branch_id=e.branch_id,
                  warehouse_id=e.warehouse_id, delivery_method="pickup", lines=body.lines,
                  order_discount_pct=body.order_discount_pct, order_discount_amount=body.order_discount_amount,
                  discount_code=body.discount_code,
                  payment_method=body.payments[0].method if len(body.payments) == 1 else "other",
                  order_date=(body.sold_at.date() if body.sold_at else None))
    priced = price_order(db, user, oin)
    total = priced["totals"].grand_total
    paid = sum((p.amount for p in body.payments), ZERO)
    if paid < total:
        raise AppError(422, "underpaid", f"Total is {total}; only {paid} paid", {"payments": "short"})
    change = paid - total
    if change and not any(p.method == "cash" for p in body.payments):
        raise AppError(422, "overpaid", "Only cash can be overpaid (change is given in cash)")
    o = Order(number=next_number(db, "pos_sale"), status="draft", source="pos", external_id=body.client_id,
              order_date=priced["order_date"], pos_session_id=s.id, event_id=e.id)
    db.add(o)
    db.flush()
    apply_priced(db, o, oin, priced)
    db.add(OrderStatusHistory(order_id=o.id, to_status="draft", user_id=user.id, note=f"POS {e.name}"))
    change_status(db, o, "confirmed")
    change_status(db, o, "delivered", "Handed over at POS")
    left = change
    for p in body.payments:  # the cash payment is recorded net of change given
        amount = p.amount
        if p.method == "cash" and left:
            take = min(left, amount)
            amount, left = amount - take, left - take
        if amount > 0:
            db.add(Payment(number=next_number(db, "payment"), customer_id=o.customer_id, order_id=o.id,
                           payment_date=o.order_date, method=p.method, amount=amount, reference=p.reference))
    refresh_payment_status(db, o)
    audit(db, "create", o, note=f"POS sale at {e.name}")
    return SaleOut(order_id=o.id, number=o.number, grand_total=total, paid=paid, change=change)


@router.post("/sales", response_model=SaleOut, status_code=201)
def pos_sale(body: SaleIn, db: DB, user: User = CREATE):
    return make_sale(db, user, body)


@router.post("/sales/sync")
def sync_offline(body: list[SaleIn], db: DB, user: User = CREATE):
    """Upload sales captured offline. Each one succeeds or fails on its own; re-sending is safe."""
    results = []
    for sale in body:
        try:
            with db.begin_nested():
                results.append({"client_id": sale.client_id, "ok": True, **make_sale(db, user, sale).model_dump()})
        except AppError as err:
            results.append({"client_id": sale.client_id, "ok": False, "code": err.code, "message": err.message})
    return results


@router.get("/sales/{order_id}/receipt")
def receipt(order_id: int, db: DB, _: User = VIEW):
    o = get_or_404(db, Order, order_id, "Sale")
    lines = db.scalars(select(OrderLine).where(OrderLine.order_id == o.id).order_by(OrderLine.line_no)).all()
    pays = db.scalars(select(Payment).where(Payment.order_id == o.id)).all()
    e = db.get(POSEvent, o.event_id) if o.event_id else None
    return pdf_response(render_pdf(db, "pos_receipt.html", o=o, lines=lines, payments=pays, event=e),
                        f"{o.number}.pdf")


@router.post("/consumption", status_code=201)
def consumption(body: ConsumptionIn, db: DB, _: User = CREATE):
    """Samples, complimentary items and wastage at an event: stock out, never counted as sales."""
    e = get_event(db, body.event_id)
    reason = {"sample": "sample", "complimentary": "internal_use", "wastage": "wastage"}[body.reason]
    for ln in body.lines:
        issue(db, product_id=ln.product_id, warehouse_id=e.warehouse_id, quantity=ln.quantity, reason=reason,
              ref=("pos_event", e.id, e.name), note=f"{body.reason}: {body.note or ''}".strip(": "))
    audit(db, "consumption", entity_type="pos_events", entity_id=e.id, note=body.reason)
    return {"recorded": len(body.lines)}


# ---------- reports ----------

def event_report(db: Session, e: POSEvent) -> dict:
    orders = select(Order.id).where(Order.event_id == e.id, Order.status.not_in(("cancelled", "draft")))
    tot = db.execute(select(func.count(), func.coalesce(func.sum(Order.grand_total), 0),
                            func.coalesce(func.sum(Order.net_total), 0))
                     .where(Order.id.in_(orders))).one()
    products = db.execute(select(OrderLine.product_id, func.max(OrderLine.description), func.sum(OrderLine.quantity),
                                 func.sum(OrderLine.line_total),
                                 func.sum(OrderLine.quantity * func.coalesce(OrderLine.unit_cost, 0)))
                          .where(OrderLine.order_id.in_(orders)).group_by(OrderLine.product_id)
                          .order_by(func.sum(OrderLine.line_total).desc())).all()
    by_method = dict(db.execute(select(Payment.method, func.sum(Payment.amount)).where(
        Payment.order_id.in_(orders), Payment.kind == "payment").group_by(Payment.method)).all())
    by_cashier = [{"user_id": u, "sales": n, "revenue": r} for u, n, r in db.execute(
        select(Order.created_by_id, func.count(), func.sum(Order.grand_total)).where(Order.id.in_(orders))
        .group_by(Order.created_by_id))]
    used = db.execute(select(StockMovement.product_id, StockMovement.reason, func.sum(-StockMovement.quantity),
                             func.sum(-StockMovement.quantity * func.coalesce(StockMovement.unit_cost, 0)))
                      .where(StockMovement.reference_type == "pos_event", StockMovement.reference_id == e.id)
                      .group_by(StockMovement.product_id, StockMovement.reason)).all()
    consumption_cost = sum((c for *_, c in used), ZERO)
    expenses = db.scalar(select(func.coalesce(func.sum(Expense.amount - Expense.tax_amount), 0)).where(
        Expense.event_id == e.id, Expense.status == "approved"))
    cogs = sum((p[4] for p in products), ZERO)
    sold = {p[0]: p[2] for p in products}
    consumed: dict[int, Decimal] = {}
    for pid, _, q, _ in used:
        consumed[pid] = consumed.get(pid, ZERO) + q
    counts = {(c.kind, c.product_id): c.quantity for c in db.scalars(
        select(EventStockCount).where(EventStockCount.event_id == e.id))}
    recon = []
    for pid in {k[1] for k in counts}:
        opening, closing = counts.get(("opening", pid)), counts.get(("closing", pid))
        expected = (opening or ZERO) - sold.get(pid, ZERO) - consumed.get(pid, ZERO)
        recon.append({"product_id": pid, "name": db.get(Product, pid).name, "opening": opening,
                      "sold": sold.get(pid, ZERO), "consumed": consumed.get(pid, ZERO), "expected_closing": expected,
                      "counted_closing": closing, "variance": (closing - expected) if closing is not None else None})
    n, revenue, net = tot
    return {"event_id": e.id, "name": e.name, "status": e.status, "sales": n, "revenue": revenue, "net_sales": net,
            "average_sale": (revenue / n).quantize(Decimal("0.01")) if n else ZERO,
            "products": [{"product_id": p[0], "name": p[1], "quantity": p[2], "revenue": p[3]} for p in products],
            "payments_by_method": by_method, "by_cashier": by_cashier,
            "consumption": [{"product_id": pid, "reason": r, "quantity": q} for pid, r, q, _ in used],
            "cogs": cogs.quantize(Decimal("0.01")), "consumption_cost": consumption_cost.quantize(Decimal("0.01")),
            "expenses": expenses,
            "profit": (net - cogs - consumption_cost - expenses).quantize(Decimal("0.01")),
            "stock_reconciliation": recon}


@router.get("/events/{event_id}/report")
def report(event_id: int, db: DB, _: User = VIEW):
    return event_report(db, get_event(db, event_id))


@router.get("/events/compare")
def compare(ids: str, db: DB, _: User = VIEW):
    keep = ("event_id", "name", "sales", "revenue", "net_sales", "average_sale", "cogs", "consumption_cost",
            "expenses", "profit")
    return [{k: v for k, v in event_report(db, get_event(db, int(i))).items() if k in keep}
            for i in ids.split(",") if i.strip()]


@router.get("/sessions", response_model=list[SessionOut])
def list_sessions(db: DB, event_id: int | None = None, status: str | None = None, _: User = VIEW):
    q = select(POSSession).order_by(POSSession.id.desc())
    if event_id:
        q = q.where(POSSession.event_id == event_id)
    if status:
        q = q.where(POSSession.status == status)
    return db.scalars(q.limit(200)).all()


crud_routers = [crud_router(POSEvent, prefix="/pos/events", feature="pos", create=EventIn, update=EventPatch,
                            out=EventOut, search=(POSEvent.name, POSEvent.location),
                            filters={"status": POSEvent.status, "kind": POSEvent.kind},
                            default_sort=POSEvent.start_date.desc().nulls_last(), tags=["pos"])]
routers = [router, *crud_routers]
