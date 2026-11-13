"""Wholesale, cafes and distribution: customer price lists, MOQs, credit limits, recurring orders, territories,
delivery routes with proof of delivery, and sell-through."""

from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, String, Text, func, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.audit import audit
from app.auth.access import require_access
from app.auth.models import User
from app.clock import local_today, utcnow
from app.crud import RecordOut, crud_router, get_or_404
from app.customers import Customer
from app.db import DB, Base, Entity, Money, Qty
from app.errors import AppError
from app.listing import ListParams, Page, apply_filters, paginate
from app.notifications import send
from app.numbering import next_number
from app.orders.models import Order, OrderLine, Payment
from app.orders.router import OrderCreate, create_order, order_out
from app.orders.service import change_status, refresh_payment_status
from app.products.models import PriceList
from app.reports import COUNTED, Range, period

ZERO = Decimal(0)


class CustomerProductTerm(Base):
    __tablename__ = "customer_product_terms"
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id", ondelete="CASCADE"), primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), primary_key=True)
    min_order_qty: Mapped[Qty]


class RecurringOrder(Entity, Base):
    __tablename__ = "recurring_orders"
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    frequency: Mapped[str] = mapped_column(String(20))  # weekly | fortnightly | monthly
    next_date: Mapped[date] = mapped_column(Date, index=True)
    end_date: Mapped[date | None] = mapped_column(Date)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    auto_confirm: Mapped[bool] = mapped_column(Boolean, default=False)
    template: Mapped[dict] = mapped_column(JSONB)  # order body without customer/date
    last_order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"))


class Territory(Entity, Base):
    __tablename__ = "territories"
    name: Mapped[str] = mapped_column(String(120), unique=True)
    description: Mapped[str | None] = mapped_column(Text)


class DeliveryRoute(Entity, Base):
    __tablename__ = "delivery_routes"
    number: Mapped[str] = mapped_column(String(30), unique=True)
    route_date: Mapped[date] = mapped_column(Date, index=True)
    driver_name: Mapped[str | None] = mapped_column(String(120))
    driver_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    vehicle: Mapped[str | None] = mapped_column(String(60))
    status: Mapped[str] = mapped_column(String(20), default="planned")  # planned | out | completed
    notes: Mapped[str | None] = mapped_column(Text)


class RouteStop(Entity, Base):
    __tablename__ = "route_stops"
    route_id: Mapped[int] = mapped_column(ForeignKey("delivery_routes.id", ondelete="CASCADE"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending | delivered | failed
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    recipient_name: Mapped[str | None] = mapped_column(String(120))
    cod_collected: Mapped[Money] = mapped_column(default=Decimal(0))
    failure_reason: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)


class SellThrough(Entity, Base):
    """Stock and sales figures reported by a retailer/distributor for a period."""

    __tablename__ = "sell_through"
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    period_start: Mapped[date] = mapped_column(Date)
    period_end: Mapped[date] = mapped_column(Date)
    opening: Mapped[Qty] = mapped_column(default=Decimal(0))
    sold: Mapped[Qty]
    returned: Mapped[Qty] = mapped_column(default=Decimal(0))
    closing: Mapped[Qty] = mapped_column(default=Decimal(0))
    note: Mapped[str | None] = mapped_column(Text)


# ---------- rules used by the order code ----------

def check_moq(db: Session, customer_id: int | None, product_id: int, qty: Decimal, line_no: int) -> None:
    if not customer_id:
        return
    t = db.get(CustomerProductTerm, (customer_id, product_id))
    if t and qty < t.min_order_qty:
        raise AppError(422, "below_moq", f"Line {line_no}: minimum order is {t.min_order_qty.normalize():f}",
                       {f"lines.{line_no - 1}.quantity": "below minimum"})


def check_credit(db: Session, order: Order) -> None:
    """Confirming an order mustn't take a customer over their credit limit (owners may override)."""
    c = db.get(Customer, order.customer_id) if order.customer_id else None
    if not c or c.credit_limit is None or order.payment_method in ("cash", "card", "online"):
        return
    exposure = db.scalar(select(func.coalesce(func.sum(Order.grand_total - Order.paid_total), 0)).where(
        Order.customer_id == c.id, Order.status.in_(COUNTED), Order.id != order.id))
    if exposure + order.grand_total - order.paid_total > c.credit_limit:
        user = db.get(User, db.info.get("user_id")) if db.info.get("user_id") else None
        if not (user and user.is_owner):
            raise AppError(409, "credit_limit_exceeded",
                           f"{c.name} would owe {exposure + order.grand_total - order.paid_total} "
                           f"(limit {c.credit_limit}); an owner must confirm")


# ---------- customer price lists & MOQs ----------

router = APIRouter(tags=["wholesale"])
C_EDIT = require_access("customers", "edit")


@router.post("/customers/{customer_id}/price-list")
def customer_price_list(customer_id: int, db: DB, _: User = C_EDIT):
    """Give the customer their own price list (prices then set per product as usual). Products without a
    customer price fall back to the normal list for their type."""
    c = get_or_404(db, Customer, customer_id, "Customer")
    pl = db.scalar(select(PriceList).where(PriceList.customer_id == c.id))
    if pl is None:
        pl = PriceList(code=f"cust_{c.id}", name=f"{c.company_name or c.name} prices", customer_id=c.id)
        db.add(pl)
        db.flush()
        audit(db, "create", pl)
    c.price_list_id = pl.id
    return {"price_list_id": pl.id, "code": pl.code}


class TermIn(BaseModel):
    product_id: int
    min_order_qty: Decimal = Field(gt=0)


@router.get("/customers/{customer_id}/terms")
def get_terms(customer_id: int, db: DB, _: User = require_access("customers", "view")):
    return [{"product_id": t.product_id, "min_order_qty": t.min_order_qty} for t in db.scalars(
        select(CustomerProductTerm).where(CustomerProductTerm.customer_id == customer_id))]


@router.put("/customers/{customer_id}/terms")
def set_terms(customer_id: int, body: list[TermIn], db: DB, _: User = C_EDIT):
    get_or_404(db, Customer, customer_id, "Customer")
    db.query(CustomerProductTerm).filter(CustomerProductTerm.customer_id == customer_id).delete()
    db.add_all(CustomerProductTerm(customer_id=customer_id, **t.model_dump()) for t in body)
    audit(db, "update", entity_type="customers", entity_id=customer_id, note="minimum order quantities")
    db.flush()
    return get_terms(customer_id, db)


# ---------- recurring orders ----------

class RecurringIn(BaseModel):
    customer_id: int
    name: str = Field(min_length=1)
    frequency: Literal["weekly", "fortnightly", "monthly"]
    next_date: date
    end_date: date | None = None
    auto_confirm: bool = False
    template: OrderCreate  # customer_id/order_date in it are ignored


class RecurringPatch(BaseModel):
    name: str | None = None
    frequency: Literal["weekly", "fortnightly", "monthly"] | None = None
    next_date: date | None = None
    end_date: date | None = None
    active: bool | None = None
    auto_confirm: bool | None = None


class RecurringOut(RecordOut):
    customer_id: int
    name: str
    frequency: str
    next_date: date
    end_date: date | None
    active: bool
    auto_confirm: bool
    template: dict
    last_order_id: int | None


def advance(d: date, freq: str) -> date:
    if freq == "weekly":
        return d + timedelta(days=7)
    if freq == "fortnightly":
        return d + timedelta(days=14)
    month = d.month % 12 + 1
    year = d.year + (d.month == 12)
    for day in (d.day, 30, 29, 28):
        try:
            return d.replace(year=year, month=month, day=day)
        except ValueError:
            continue
    raise ValueError(d)


def run_recurring(db: Session, r: RecurringOrder) -> Order:
    user = db.get(User, r.created_by_id)
    body = OrderCreate(**{**r.template, "customer_id": r.customer_id, "order_date": r.next_date,
                          "confirm": r.auto_confirm})
    db.info["user_id"] = user.id
    out = create_order(body, db, user)
    o = db.get(Order, out.id)
    o.internal_notes = f"{o.internal_notes or ''}\nRecurring order: {r.name}".strip()
    r.last_order_id = o.id
    r.next_date = advance(r.next_date, r.frequency)
    if r.end_date and r.next_date > r.end_date:
        r.active = False
    return o


def run_due_recurring(db: Session) -> str:
    n = 0
    for r in db.scalars(select(RecurringOrder).where(RecurringOrder.active, RecurringOrder.next_date <= local_today(),
                                                     RecurringOrder.archived_at.is_(None))):
        try:
            with db.begin_nested():
                run_recurring(db, r)
                n += 1
        except AppError as e:
            send(db, "delayed_dispatch", f"Recurring order '{r.name}' couldn't be created", e.message,
                 f"/recurring-orders/{r.id}")
    return f"{n} recurring orders created"


rec = APIRouter(prefix="/recurring-orders", tags=["wholesale"])


@rec.post("/{rec_id}/run-now")
def run_now(rec_id: int, db: DB, _: User = require_access("orders", "create")):
    r = get_or_404(db, RecurringOrder, rec_id, "Recurring order")
    return order_out(db, run_recurring(db, r))


class RecurringCreate(RecurringIn):
    def model_dump(self, **kw):
        d = super().model_dump(mode="json", **kw)
        d["template"] = {k: v for k, v in d["template"].items() if k not in ("customer_id", "order_date", "confirm")}
        return d


# ---------- delivery routes ----------

class RouteIn(BaseModel):
    route_date: date | None = None
    driver_name: str | None = None
    driver_user_id: int | None = None
    vehicle: str | None = None
    notes: str | None = None
    order_ids: list[int] = Field(min_length=1)


class DeliverIn(BaseModel):
    recipient_name: str | None = None
    cod_collected: Decimal = Field(ZERO, ge=0)
    note: str | None = None


class FailIn(BaseModel):
    reason: str = Field(min_length=2)


class RouteOut(RecordOut):
    number: str
    route_date: date
    driver_name: str | None
    driver_user_id: int | None
    vehicle: str | None
    status: str
    notes: str | None
    stops: list[dict] = []
    cod_total: Decimal = ZERO


routes = APIRouter(prefix="/routes", tags=["distribution"])
R_VIEW, R_EDIT = require_access("distribution", "view"), require_access("distribution", "edit")


def route_out(db: Session, r: DeliveryRoute) -> RouteOut:
    o = RouteOut.model_validate(r)
    for s in db.scalars(select(RouteStop).where(RouteStop.route_id == r.id).order_by(RouteStop.seq)):
        order = db.get(Order, s.order_id)
        o.stops.append({"id": s.id, "seq": s.seq, "order_id": order.id, "order": order.number,
                        "customer": order.customer_name, "phone": order.customer_phone,
                        "address": order.shipping_address, "status": s.status, "cod_due": order.grand_total - order.paid_total
                        if order.payment_method == "cod" else ZERO, "cod_collected": s.cod_collected,
                        "recipient_name": s.recipient_name, "failure_reason": s.failure_reason,
                        "delivered_at": s.delivered_at})
        o.cod_total += s.cod_collected
    return o


@routes.post("", response_model=RouteOut, status_code=201)
def create_route(body: RouteIn, db: DB, _: User = R_EDIT):
    r = DeliveryRoute(number=next_number(db, "route"), route_date=body.route_date or local_today(),
                      driver_name=body.driver_name, driver_user_id=body.driver_user_id, vehicle=body.vehicle,
                      notes=body.notes)
    db.add(r)
    db.flush()
    for i, oid in enumerate(body.order_ids, start=1):
        o = get_or_404(db, Order, oid, "Order")
        if o.status not in ("confirmed", "processing", "packed", "dispatched"):
            raise AppError(422, "not_deliverable", f"{o.number} is {o.status}")
        db.add(RouteStop(route_id=r.id, seq=i, order_id=o.id))
    audit(db, "create", r)
    db.flush()
    return route_out(db, r)


@routes.get("", response_model=Page[RouteOut])
def list_routes(db: DB, p: Annotated[ListParams, Depends()], status: str | None = None,
                route_date: date | None = None, _: User = R_VIEW):
    q = apply_filters(select(DeliveryRoute), DeliveryRoute, p, (DeliveryRoute.number, DeliveryRoute.driver_name), {})
    if status:
        q = q.where(DeliveryRoute.status == status)
    if route_date:
        q = q.where(DeliveryRoute.route_date == route_date)
    page = paginate(db, q, p)
    page["items"] = [route_out(db, r) for r in page["items"]]
    return page


@routes.get("/{route_id}", response_model=RouteOut)
def read_route(route_id: int, db: DB, _: User = R_VIEW):
    return route_out(db, get_or_404(db, DeliveryRoute, route_id, "Route"))


@routes.post("/{route_id}/start", response_model=RouteOut)
def start_route(route_id: int, db: DB, _: User = R_EDIT):
    """Driver leaves: every order on the route is dispatched (stock goes out)."""
    r = get_or_404(db, DeliveryRoute, route_id, "Route")
    if r.status != "planned":
        raise AppError(409, "invalid_status", f"Route is {r.status}")
    for s in db.scalars(select(RouteStop).where(RouteStop.route_id == r.id)):
        o = db.get(Order, s.order_id)
        if o.status != "dispatched":
            o.courier = o.courier or f"Own delivery ({r.driver_name or r.number})"
            o.tracking_number = o.tracking_number or r.number
            change_status(db, o, "dispatched", f"Route {r.number}")
    r.status = "out"
    audit(db, "start", entity_type="delivery_routes", entity_id=r.id)
    return route_out(db, r)


def get_stop(db: Session, route_id: int, stop_id: int) -> RouteStop:
    s = db.get(RouteStop, stop_id)
    if s is None or s.route_id != route_id:
        raise AppError(404, "not_found", "Stop not found")
    if s.status != "pending":
        raise AppError(409, "done", f"Stop already {s.status}")
    return s


@routes.post("/{route_id}/stops/{stop_id}/deliver", response_model=RouteOut)
def deliver_stop(route_id: int, stop_id: int, body: DeliverIn, db: DB, _: User = R_EDIT):
    """Mark delivered; COD collected becomes a cash payment. Attach the POD photo/signature to route_stops."""
    s = get_stop(db, route_id, stop_id)
    o = db.get(Order, s.order_id)
    if body.cod_collected > o.grand_total - o.paid_total:
        raise AppError(422, "over_collected", f"Only {o.grand_total - o.paid_total} is due")
    if body.cod_collected:
        db.add(Payment(number=next_number(db, "payment"), customer_id=o.customer_id, order_id=o.id,
                       payment_date=local_today(), method="cash", amount=body.cod_collected,
                       note=f"COD collected on {get_or_404(db, DeliveryRoute, route_id, 'Route').number}"))
        refresh_payment_status(db, o)
    change_status(db, o, "delivered", f"Delivered to {body.recipient_name or 'customer'}")
    s.status, s.delivered_at, s.recipient_name = "delivered", utcnow(), body.recipient_name
    s.cod_collected, s.note = body.cod_collected, body.note
    return route_out(db, db.get(DeliveryRoute, route_id))


@routes.post("/{route_id}/stops/{stop_id}/fail", response_model=RouteOut)
def fail_stop(route_id: int, stop_id: int, body: FailIn, db: DB, _: User = R_EDIT):
    s = get_stop(db, route_id, stop_id)
    s.status, s.failure_reason = "failed", body.reason
    audit(db, "delivery_failed", entity_type="orders", entity_id=s.order_id, note=body.reason)
    return route_out(db, db.get(DeliveryRoute, route_id))


@routes.post("/{route_id}/complete", response_model=RouteOut)
def complete_route(route_id: int, db: DB, _: User = R_EDIT):
    r = get_or_404(db, DeliveryRoute, route_id, "Route")
    if db.scalar(select(RouteStop.id).where(RouteStop.route_id == r.id, RouteStop.status == "pending").limit(1)):
        raise AppError(409, "stops_pending", "Mark every stop delivered or failed first")
    r.status = "completed"
    return route_out(db, r)


# ---------- territories & sell-through ----------

class TerritoryIn(BaseModel):
    name: str = Field(min_length=1)
    description: str | None = None


class TerritoryPatch(BaseModel):
    name: str | None = None
    description: str | None = None


class TerritoryOut(RecordOut, TerritoryIn):
    pass


class SellThroughIn(BaseModel):
    customer_id: int
    product_id: int
    period_start: date
    period_end: date
    opening: Decimal = Field(ZERO, ge=0)
    sold: Decimal = Field(ge=0)
    returned: Decimal = Field(ZERO, ge=0)
    closing: Decimal = Field(ZERO, ge=0)
    note: str | None = None


class SellThroughOut(RecordOut, SellThroughIn):
    pass


@router.get("/reports/sell-through")
def sell_through_report(db: DB, customer_id: int | None = None, range: Range = "month",
                        date_from: date | None = None, date_to: date | None = None,
                        _: User = require_access("orders", "view")):
    """Sell-in (what we delivered) vs. sell-through (what the customer reports selling)."""
    start, end = period(range, date_from, date_to)
    sell_in_q = (select(Order.customer_id, OrderLine.product_id, func.sum(OrderLine.shipped_qty))
                 .join(Order, Order.id == OrderLine.order_id)
                 .where(Order.order_date.between(start, end), Order.status.in_(COUNTED), Order.customer_id.is_not(None))
                 .group_by(Order.customer_id, OrderLine.product_id))
    st_q = (select(SellThrough.customer_id, SellThrough.product_id, func.sum(SellThrough.sold),
                   func.sum(SellThrough.returned), func.max(SellThrough.closing))
            .where(SellThrough.period_start >= start, SellThrough.period_end <= end)
            .group_by(SellThrough.customer_id, SellThrough.product_id))
    if customer_id:
        sell_in_q = sell_in_q.where(Order.customer_id == customer_id)
        st_q = st_q.where(SellThrough.customer_id == customer_id)
    rows: dict[tuple, dict] = {}
    for cid, pid, q in db.execute(sell_in_q):
        rows[(cid, pid)] = {"customer_id": cid, "product_id": pid, "sell_in": q, "sold": None, "returned": None,
                            "closing": None}
    for cid, pid, sold, ret, closing in db.execute(st_q):
        r = rows.setdefault((cid, pid), {"customer_id": cid, "product_id": pid, "sell_in": ZERO})
        r.update(sold=sold, returned=ret, closing=closing)
    for r in rows.values():
        r["sell_through_pct"] = (r["sold"] / r["sell_in"] * 100).quantize(Decimal("0.1")) \
            if r.get("sold") is not None and r["sell_in"] else None
    return {"from": start, "to": end, "rows": list(rows.values())}


crud_routers = [
    crud_router(RecurringOrder, prefix="/recurring-orders", feature="orders", create=RecurringCreate,
                update=RecurringPatch, out=RecurringOut, filters={"customer_id": RecurringOrder.customer_id,
                                                                  "active": RecurringOrder.active},
                default_sort=RecurringOrder.next_date, tags=["wholesale"]),
    crud_router(Territory, prefix="/territories", feature="distribution", create=TerritoryIn, update=TerritoryPatch,
                out=TerritoryOut, search=(Territory.name,), default_sort=Territory.name, tags=["distribution"]),
    crud_router(SellThrough, prefix="/sell-through", feature="orders", create=SellThroughIn, update=SellThroughIn,
                out=SellThroughOut, filters={"customer_id": SellThrough.customer_id,
                                             "product_id": SellThrough.product_id},
                default_sort=SellThrough.period_end.desc(), tags=["distribution"]),
]
routers = [router, rec, routes, *crud_routers]
