from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import exists, func, select
from sqlalchemy.orm import Session

from app.approvals import check_refund
from app.audit import audit, snapshot
from app.auth.access import require_access
from app.auth.models import User
from app.clock import local_today
from app.crud import RecordOut, crud_router, get_or_404
from app.customers import Customer
from app.db import DB
from app.errors import AppError
from app.listing import ListParams, Page, apply_filters, export_response, paginate
from app.numbering import next_number
from app.pdf import pdf_response, render_pdf
from app.orders.models import DiscountCode, Order, OrderLine, OrderStatusHistory, Payment, Shipment, ShipmentLine
from app.orders.service import (
    LOCKED, apply_priced, change_status, create_shipment, ensure_editable, price_order, refresh_payment_status,
)

router = APIRouter(prefix="/orders", tags=["orders"])
VIEW, CREATE, EDIT, EXPORT = (require_access("orders", a) for a in ("view", "create", "edit", "export"))
PAY_VIEW, PAY_CREATE = require_access("order_payments", "view"), require_access("order_payments", "create")

OrderType = Literal["retail", "wholesale", "corporate", "cafe", "stall", "sample", "promotional", "replacement"]
OrderStatus = Literal["draft", "confirmed", "processing", "packed", "dispatched", "delivered", "cancelled",
                      "returned", "refunded"]
PaymentStatus = Literal["unpaid", "partially_paid", "paid", "cod_pending", "refunded", "failed"]
PaymentMethod = Literal["cash", "card", "bank_transfer", "cod", "online", "cheque", "other"]
ZERO = Decimal(0)


# ---------- schemas ----------

class LineIn(BaseModel):
    product_id: int
    quantity: Decimal = Field(gt=0)
    unit_price: Decimal | None = Field(None, ge=0)  # empty = price list price
    discount_pct: Decimal = Field(ZERO, ge=0, le=100)
    discount_amount: Decimal = Field(ZERO, ge=0)
    description: str | None = None


class AddressIn(BaseModel):
    label: str | None = None
    line1: str
    line2: str | None = None
    area: str | None = None
    city: str
    postal_code: str | None = None
    phone: str | None = None


class OrderIn(BaseModel):
    customer_id: int | None = None
    customer_name: str | None = None  # walk-in customers without a profile
    customer_phone: str | None = None
    order_date: date | None = None
    order_type: OrderType = "retail"
    channel: str | None = None
    price_list_id: int | None = None
    branch_id: int | None = None
    warehouse_id: int | None = None
    payment_method: PaymentMethod | None = None
    delivery_method: Literal["delivery", "pickup"] = "delivery"
    shipping_address_id: int | None = None
    shipping_address: AddressIn | None = None
    billing_address: AddressIn | None = None
    discount_code: str | None = None
    order_discount_pct: Decimal = Field(ZERO, ge=0, le=100)
    order_discount_amount: Decimal = Field(ZERO, ge=0)
    delivery_charge: Decimal = Field(ZERO, ge=0)
    notes: str | None = None
    internal_notes: str | None = None
    customer_instructions: str | None = None
    campaign_id: int | None = None
    loyalty_points: int = Field(0, ge=0)  # points to redeem as a discount
    referral_code: str | None = None
    lines: list[LineIn] = Field(min_length=1)

    @field_validator("shipping_address", "billing_address", mode="after")
    @classmethod
    def _as_dict(cls, v):
        return v.model_dump() if v else None


class OrderCreate(OrderIn):
    confirm: bool = False  # create and confirm in one step


class LineOut(BaseModel):
    model_config = {"from_attributes": True}
    id: int | None = None
    line_no: int
    product_id: int
    sku: str
    description: str
    quantity: Decimal
    unit_price: Decimal
    list_price: Decimal | None
    price_overridden: bool
    discount_pct: Decimal
    discount_amount: Decimal
    line_discount: Decimal
    order_discount_share: Decimal
    tax_rate: Decimal
    tax_amount: Decimal
    net_amount: Decimal
    line_total: Decimal
    shipped_qty: Decimal = Decimal(0)
    reserved_qty: Decimal | None = None  # in line units
    backorder_qty: Decimal | None = None


class OrderSummary(RecordOut):
    number: str
    order_date: date
    customer_id: int | None
    customer_name: str | None
    customer_phone: str | None
    order_type: str
    channel: str | None
    source: str
    status: str
    payment_status: str
    fulfilment_status: str
    payment_method: str | None
    grand_total: Decimal
    paid_total: Decimal
    balance_due: Decimal
    courier: str | None
    tracking_number: str | None
    created_at: datetime


class HistoryOut(BaseModel):
    model_config = {"from_attributes": True}
    from_status: str | None
    to_status: str
    at: datetime
    user_id: int | None
    note: str | None


class OrderOut(OrderSummary):
    price_list_id: int | None
    branch_id: int | None
    warehouse_id: int | None
    delivery_method: str
    shipping_address: dict | None
    billing_address: dict | None
    discount_code_id: int | None
    order_discount_pct: Decimal
    order_discount_amount: Decimal
    subtotal: Decimal
    discount_total: Decimal
    tax_total: Decimal
    net_total: Decimal
    delivery_charge: Decimal
    rounding: Decimal
    notes: str | None
    internal_notes: str | None
    customer_instructions: str | None
    delivery_status: str | None
    confirmed_at: datetime | None
    dispatched_at: datetime | None
    delivered_at: datetime | None
    cancelled_reason: str | None
    lines: list[LineOut] = []
    history: list[HistoryOut] = []


class StatusIn(BaseModel):
    status: OrderStatus
    note: str | None = None


class NotesIn(BaseModel):
    notes: str | None = None
    internal_notes: str | None = None
    customer_instructions: str | None = None


class DeliveryIn(BaseModel):
    delivery_method: Literal["delivery", "pickup"] | None = None
    courier: str | None = None
    tracking_number: str | None = None
    delivery_status: str | None = None


class PaymentIn(BaseModel):
    kind: Literal["payment", "refund"] = "payment"
    status: Literal["completed", "failed"] = "completed"
    method: PaymentMethod
    amount: Decimal = Field(gt=0, decimal_places=2)
    payment_date: date | None = None
    reference: str | None = None
    note: str | None = None


class PaymentOut(RecordOut):
    number: str
    kind: str
    status: str
    customer_id: int | None
    order_id: int | None
    payment_date: date
    method: str
    amount: Decimal
    reference: str | None
    note: str | None
    created_at: datetime


# ---------- helpers ----------

def get_order(db: Session, order_id: int) -> Order:
    return get_or_404(db, Order, order_id, "Order")


def order_out(db: Session, o: Order) -> OrderOut:
    from app.inventory.service import line_backorder

    out = OrderOut.model_validate(o)
    out.lines = []
    for x in db.scalars(select(OrderLine).where(OrderLine.order_id == o.id).order_by(OrderLine.line_no)):
        lo = LineOut.model_validate(x)
        if o.status in ("confirmed", "processing", "packed") and o.warehouse_id:
            lo.backorder_qty = line_backorder(db, x)
            lo.reserved_qty = x.quantity - x.shipped_qty - lo.backorder_qty
        out.lines.append(lo)
    out.history = [HistoryOut.model_validate(h) for h in db.scalars(
        select(OrderStatusHistory).where(OrderStatusHistory.order_id == o.id).order_by(OrderStatusHistory.id))]
    return out


def preview_out(priced: dict) -> dict:
    t = priced["totals"]
    return {
        "price_list": priced["price_list"].code if priced["price_list"] else None,
        "lines": [{"product_id": info["product"].id, "sku": info["product"].sku, "description": info["description"],
                   "quantity": lc.quantity, "unit_price": lc.unit_price, "list_price": info["list_price"],
                   "price_overridden": info["overridden"], "line_discount": lc.line_discount,
                   "order_discount_share": lc.order_discount_share, "tax_rate": lc.tax_rate, "tax_amount": lc.tax,
                   "net_amount": lc.net, "line_total": lc.total}
                  for info, lc in zip(priced["lines"], t.lines)],
        **{f: getattr(t, f) for f in ("subtotal", "discount_total", "tax_total", "net_total", "delivery_charge",
                                      "rounding", "grand_total")},
    }


# ---------- list / export ----------

SEARCH = (Order.number, Order.customer_name, Order.customer_phone, Order.tracking_number)
SORTS = {"order_date": Order.order_date, "number": Order.number, "grand_total": Order.grand_total,
         "status": Order.status}


class OrderFilters:
    def __init__(self, date_from: date | None = None, date_to: date | None = None, status: OrderStatus | None = None,
                 payment_status: PaymentStatus | None = None, customer_id: int | None = None,
                 product_id: int | None = None, channel: str | None = None, order_type: OrderType | None = None,
                 source: str | None = None, open_only: bool = False):
        self.__dict__.update(locals())
        del self.__dict__["self"]

    def apply(self, q):
        if self.date_from:
            q = q.where(Order.order_date >= self.date_from)
        if self.date_to:
            q = q.where(Order.order_date <= self.date_to)
        for f in ("status", "payment_status", "customer_id", "channel", "order_type", "source"):
            if getattr(self, f) is not None:
                q = q.where(getattr(Order, f) == getattr(self, f))
        if self.product_id:
            q = q.where(exists().where(OrderLine.order_id == Order.id, OrderLine.product_id == self.product_id))
        if self.open_only:
            q = q.where(Order.status.in_(("confirmed", "processing", "packed", "dispatched")))
        return q


def list_query(p: ListParams, f: OrderFilters):
    q = apply_filters(select(Order), Order, p, SEARCH, SORTS, Order.id.desc())
    return f.apply(q)


@router.get("", response_model=Page[OrderSummary])
def list_orders(db: DB, p: Annotated[ListParams, Depends()], f: Annotated[OrderFilters, Depends()],
                _: User = VIEW):
    return paginate(db, list_query(p, f), p, OrderSummary)


@router.get("/export")
def export_orders(db: DB, p: Annotated[ListParams, Depends()], f: Annotated[OrderFilters, Depends()],
                  format: str = "csv", _: User = EXPORT):
    rows = [OrderSummary.model_validate(o).model_dump() for o in db.scalars(list_query(p, f))]
    cols = [("number", "Order"), ("order_date", "Date"), ("customer_name", "Customer"),
            ("customer_phone", "Phone"), ("order_type", "Type"), ("channel", "Channel"), ("status", "Status"),
            ("payment_status", "Payment"), ("grand_total", "Total"), ("paid_total", "Paid"),
            ("balance_due", "Balance"), ("courier", "Courier"), ("tracking_number", "Tracking")]
    return export_response(db, rows, cols, format, "orders", "orders")


# ---------- printing ----------

def order_lines(db: Session, order_id: int) -> list[OrderLine]:
    return db.scalars(select(OrderLine).where(OrderLine.order_id == order_id).order_by(OrderLine.line_no)).all()


@router.get("/dispatch-list")
def dispatch_list(ids: str, db: DB, _: User = VIEW):
    """PDF for the courier hand-over. ids = comma-separated order ids."""
    try:
        id_list = [int(x) for x in ids.split(",") if x.strip()]
    except ValueError:
        raise AppError(422, "invalid_ids", "ids must be comma-separated numbers")
    orders = db.scalars(select(Order).where(Order.id.in_(id_list)).order_by(Order.number)).all()
    if not orders:
        raise AppError(404, "not_found", "No orders found")
    cod = sum((o.grand_total - o.paid_total for o in orders if o.payment_method == "cod"), ZERO)
    data = render_pdf(db, "dispatch_list.html", orders=[(o, order_lines(db, o.id)) for o in orders], cod_total=cod)
    return pdf_response(data, f"dispatch-list-{local_today()}.pdf")


@router.get("/{order_id}/pdf")
def order_pdf(order_id: int, db: DB, doc: Literal["summary", "packing_slip"] = "summary", _: User = VIEW):
    o = get_order(db, order_id)
    template = "order_summary.html" if doc == "summary" else "packing_slip.html"
    data = render_pdf(db, template, o=o, lines=order_lines(db, o.id))
    return pdf_response(data, f"{o.number}-{doc}.pdf")


# ---------- create / edit ----------

@router.post("/preview")
def preview(body: OrderIn, db: DB, user: User = VIEW):
    """Totals for the order form, computed exactly as saving would."""
    return preview_out(price_order(db, user, body))


@router.post("", response_model=OrderOut, status_code=201)
def create_order(body: OrderCreate, db: DB, user: User = CREATE):
    priced = price_order(db, user, body)
    o = Order(number=next_number(db, "order"), status="draft", source="manual", order_date=priced["order_date"])
    db.add(o)
    db.flush()
    apply_priced(db, o, body, priced)
    db.add(OrderStatusHistory(order_id=o.id, from_status=None, to_status="draft", user_id=user.id))
    audit(db, "create", o)
    if body.confirm:
        change_status(db, o, "confirmed")
    refresh_payment_status(db, o)
    return order_out(db, o)


@router.get("/{order_id}", response_model=OrderOut)
def read_order(order_id: int, db: DB, _: User = VIEW):
    return order_out(db, get_order(db, order_id))


@router.put("/{order_id}", response_model=OrderOut)
def update_order(order_id: int, body: OrderIn, db: DB, user: User = EDIT):
    o = get_order(db, order_id)
    ensure_editable(o)
    before = snapshot(o)
    apply_priced(db, o, body, price_order(db, user, body, order_id=o.id))
    refresh_payment_status(db, o)
    audit(db, "update", o, before=before)
    return order_out(db, o)


@router.post("/{order_id}/status", response_model=OrderOut)
def set_status(order_id: int, body: StatusIn, db: DB, _: User = EDIT):
    o = get_order(db, order_id)
    change_status(db, o, body.status, body.note)
    return order_out(db, o)


@router.patch("/{order_id}/notes", response_model=OrderOut)
def update_notes(order_id: int, body: NotesIn, db: DB, _: User = EDIT):
    o = get_order(db, order_id)
    before = snapshot(o)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(o, k, v)
    audit(db, "update", o, before=before)
    return order_out(db, o)


@router.patch("/{order_id}/delivery", response_model=OrderOut)
def update_delivery(order_id: int, body: DeliveryIn, db: DB, _: User = EDIT):
    o = get_order(db, order_id)
    if o.status in LOCKED:
        raise AppError(409, "order_closed", f"The order is {o.status}")
    before = snapshot(o)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(o, k, v)
    audit(db, "update", o, before=before)
    return order_out(db, o)


# ---------- shipments ----------

class ShipLineIn(BaseModel):
    order_line_id: int
    quantity: Decimal = Field(gt=0)


class ShipmentIn(BaseModel):
    lines: list[ShipLineIn] = Field(min_length=1)
    courier: str | None = None
    tracking_number: str | None = None


class ShipmentOut(RecordOut):
    number: str
    order_id: int
    warehouse_id: int | None
    status: str
    courier: str | None
    tracking_number: str | None
    dispatched_at: datetime | None
    delivered_at: datetime | None
    lines: list[dict] = []


@router.get("/{order_id}/shipments", response_model=list[ShipmentOut])
def list_shipments(order_id: int, db: DB, _: User = VIEW):
    get_order(db, order_id)
    out = []
    for sh in db.scalars(select(Shipment).where(Shipment.order_id == order_id).order_by(Shipment.id)):
        so = ShipmentOut.model_validate(sh)
        so.lines = [{"order_line_id": ln.order_line_id, "quantity": ln.quantity}
                    for ln in db.scalars(select(ShipmentLine).where(ShipmentLine.shipment_id == sh.id))]
        out.append(so)
    return out


@router.post("/{order_id}/shipments", response_model=OrderOut, status_code=201)
def ship_partial(order_id: int, body: ShipmentIn, db: DB, _: User = EDIT):
    """Partial fulfilment / split shipment. When everything has shipped the order becomes dispatched."""
    o = get_order(db, order_id)
    if o.status not in ("confirmed", "processing", "packed"):
        raise AppError(409, "not_shippable", f"Can't ship an order that is {o.status}")
    courier = body.courier or o.courier
    if o.delivery_method == "delivery" and not courier:
        raise AppError(422, "courier_required", "Add the courier", {"courier": "required"})
    qty: dict[int, Decimal] = {}
    for ln in body.lines:
        qty[ln.order_line_id] = qty.get(ln.order_line_id, ZERO) + ln.quantity
    create_shipment(db, o, qty, courier, body.tracking_number)
    o.courier = o.courier or courier
    o.tracking_number = o.tracking_number or body.tracking_number
    if o.fulfilment_status == "fulfilled":
        change_status(db, o, "dispatched", "all items shipped")
    elif o.status == "confirmed":
        change_status(db, o, "processing", "partly shipped")
    return order_out(db, o)


# ---------- payments ----------

@router.get("/{order_id}/payments", response_model=list[PaymentOut])
def list_payments(order_id: int, db: DB, _: User = PAY_VIEW):
    get_order(db, order_id)
    return db.scalars(select(Payment).where(Payment.order_id == order_id).order_by(Payment.id)).all()


@router.post("/{order_id}/payments", response_model=PaymentOut, status_code=201)
def add_payment(order_id: int, body: PaymentIn, db: DB, _: User = PAY_CREATE):
    o = get_order(db, order_id)
    check_refund(db, o.id, None, body)
    if body.status == "completed":
        if body.kind == "payment":
            if o.status == "cancelled":
                raise AppError(409, "order_closed", "Can't take payment on a cancelled order")
            if body.amount > o.balance_due:
                raise AppError(422, "overpayment", f"Only {o.balance_due} is due on this order",
                               {"amount": f"max {o.balance_due}"})
        elif body.amount > o.paid_total:
            raise AppError(422, "over_refund", f"Only {o.paid_total} has been paid", {"amount": f"max {o.paid_total}"})
    pay = Payment(number=next_number(db, "payment"), customer_id=o.customer_id, order_id=o.id,
                  payment_date=body.payment_date or local_today(),
                  **body.model_dump(exclude={"payment_date"}))
    db.add(pay)
    audit(db, "create", pay)
    refresh_payment_status(db, o)
    return pay


# ---------- customer views ----------

customers_router = APIRouter(prefix="/customers", tags=["customers"])
COUNTED = ("confirmed", "processing", "packed", "dispatched", "delivered")


@customers_router.get("/{customer_id}/stats")
def customer_stats(customer_id: int, db: DB, _: User = require_access("customers", "view")):
    get_or_404(db, Customer, customer_id, "Customer")
    row = db.execute(select(func.count(), func.coalesce(func.sum(Order.grand_total), 0), func.max(Order.order_date),
                            func.min(Order.order_date), func.coalesce(func.sum(Order.grand_total - Order.paid_total), 0))
                     .where(Order.customer_id == customer_id, Order.status.in_(COUNTED))).one()
    count, spend, last, first, outstanding = row
    return {"order_count": count, "total_spend": spend,
            "average_order_value": (spend / count).quantize(Decimal("0.01")) if count else ZERO,
            "first_order_date": first, "last_order_date": last, "outstanding": outstanding,
            "returning": count > 1}


@customers_router.get("/{customer_id}/orders", response_model=Page[OrderSummary])
def customer_orders(customer_id: int, db: DB, p: Annotated[ListParams, Depends()], _: User = VIEW):
    q = apply_filters(select(Order), Order, p, SEARCH, SORTS, Order.id.desc()).where(Order.customer_id == customer_id)
    return paginate(db, q, p, OrderSummary)


# ---------- discount codes ----------

class DiscountCodeIn(BaseModel):
    code: str = Field(min_length=2, max_length=40)
    description: str | None = None
    kind: Literal["percent", "fixed"]
    value: Decimal = Field(gt=0)
    valid_from: date | None = None
    valid_to: date | None = None
    min_order_amount: Decimal | None = Field(None, ge=0)
    max_uses: int | None = Field(None, ge=1)
    is_active: bool = True

    @field_validator("code")
    @classmethod
    def _upper(cls, v: str) -> str:
        return v.strip().upper()


class DiscountCodePatch(BaseModel):
    description: str | None = None
    valid_from: date | None = None
    valid_to: date | None = None
    min_order_amount: Decimal | None = None
    max_uses: int | None = None
    is_active: bool | None = None


class DiscountCodeOut(RecordOut, DiscountCodeIn):
    pass


crud_routers = [crud_router(DiscountCode, prefix="/discount-codes", feature="discount_codes", create=DiscountCodeIn,
                            update=DiscountCodePatch, out=DiscountCodeOut, search=(DiscountCode.code,),
                            filters={"is_active": DiscountCode.is_active}, default_sort=DiscountCode.code)]
routers = [router, customers_router, *crud_routers]
