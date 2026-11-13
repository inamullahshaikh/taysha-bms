"""Customer returns (request -> receive & inspect -> complete with refund / credit note / replacement) and the
complaints register."""

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import BigInteger, DateTime, ForeignKey, String, Text, func, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.audit import audit, snapshot
from app.auth.access import ensure, require_access
from app.auth.models import User
from app.clock import local_today, utcnow
from app.crud import RecordOut, get_or_404
from app.db import DB, Base, Entity, Money, Qty
from app.documents.models import SalesDocument, SalesDocumentLine
from app.documents.router import CreditLineIn, CreditNoteIn, create_credit_note
from app.documents.service import OPEN_INVOICE, issue
from app.errors import AppError
from app.inventory.service import default_warehouse_id, fill_backorders, get_or_create_batch, move
from app.listing import ListParams, Page, apply_filters, paginate
from app.numbering import next_number
from app.orders.models import Order, OrderLine, OrderStatusHistory, Payment
from app.orders.router import LineIn, OrderCreate, create_order
from app.orders.service import refresh_payment_status
from app.products.models import Product
from app.reports import Range, period

ZERO = Decimal(0)


class ReturnRequest(Entity, Base):
    __tablename__ = "returns"
    number: Mapped[str] = mapped_column(String(30), unique=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("customers.id"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="requested", index=True)
    reason: Mapped[str] = mapped_column(String(30))
    reason_note: Mapped[str | None] = mapped_column(Text)
    warehouse_id: Mapped[int | None] = mapped_column(ForeignKey("warehouses.id"))
    resolution: Mapped[str | None] = mapped_column(String(20))  # refund | credit_note | replacement | none
    refund_amount: Mapped[Money] = mapped_column(default=Decimal(0))
    refund_payment_id: Mapped[int | None] = mapped_column(ForeignKey("payments.id"))
    credit_note_id: Mapped[int | None] = mapped_column(ForeignKey("sales_documents.id"))
    replacement_order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"))
    received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decision_note: Mapped[str | None] = mapped_column(Text)


class ReturnLine(Base):
    __tablename__ = "return_lines"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    return_id: Mapped[int] = mapped_column(ForeignKey("returns.id", ondelete="CASCADE"), index=True)
    order_line_id: Mapped[int] = mapped_column(ForeignKey("order_lines.id"))
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    quantity: Mapped[Qty]
    condition: Mapped[str | None] = mapped_column(String(20))  # unopened | opened | damaged | expired | other
    disposition: Mapped[str | None] = mapped_column(String(20))  # restock | damaged | dispose
    batch_id: Mapped[int | None] = mapped_column(ForeignKey("batches.id"))
    inspection_note: Mapped[str | None] = mapped_column(Text)


class Complaint(Entity, Base):
    __tablename__ = "complaints"
    number: Mapped[str] = mapped_column(String(30), unique=True)
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("customers.id"), index=True)
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"))
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"), index=True)
    batch_id: Mapped[int | None] = mapped_column(ForeignKey("batches.id"), index=True)
    channel: Mapped[str | None] = mapped_column(String(30))
    category: Mapped[str] = mapped_column(String(30))  # quality | taste | packaging | delivery | service | other
    severity: Mapped[str] = mapped_column(String(10), default="medium")
    description: Mapped[str] = mapped_column(Text)
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(20), default="open", index=True)  # open|in_progress|resolved|closed
    resolution: Mapped[str | None] = mapped_column(Text)
    first_response_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


# ======================= returns =======================

Reason = Literal["damaged", "wrong_item", "quality", "expired", "late_delivery", "changed_mind", "other"]


class ReturnLineIn(BaseModel):
    order_line_id: int
    quantity: Decimal = Field(gt=0)


class ReturnIn(BaseModel):
    reason: Reason
    reason_note: str | None = None
    lines: list[ReturnLineIn] = Field(min_length=1)


class InspectLine(BaseModel):
    line_id: int
    condition: Literal["unopened", "opened", "damaged", "expired", "other"]
    disposition: Literal["restock", "damaged", "dispose"]
    batch_id: int | None = None  # where to restock; default: a new return batch
    expiry_date: date | None = None
    inspection_note: str | None = None


class ReceiveIn(BaseModel):
    warehouse_id: int | None = None
    lines: list[InspectLine] = Field(min_length=1)


class CompleteIn(BaseModel):
    resolution: Literal["refund", "credit_note", "replacement", "none"]
    refund_amount: Decimal | None = Field(None, gt=0)  # default: value of the returned lines
    refund_method: Literal["cash", "card", "bank_transfer", "online", "other"] | None = None
    note: str | None = None


class ReturnOut(RecordOut):
    number: str
    order_id: int
    customer_id: int | None
    status: str
    reason: str
    reason_note: str | None
    warehouse_id: int | None
    resolution: str | None
    refund_amount: Decimal
    refund_payment_id: int | None
    credit_note_id: int | None
    replacement_order_id: int | None
    received_at: datetime | None
    completed_at: datetime | None
    decision_note: str | None
    created_at: datetime
    lines: list[dict] = []


def return_out(db: Session, r: ReturnRequest) -> ReturnOut:
    o = ReturnOut.model_validate(r)
    o.lines = [{k: getattr(ln, k) for k in ("id", "order_line_id", "product_id", "quantity", "condition",
                                            "disposition", "batch_id", "inspection_note")}
               for ln in db.scalars(select(ReturnLine).where(ReturnLine.return_id == r.id).order_by(ReturnLine.id))]
    return o


def already_returned(db: Session, order_line_id: int, exclude_return: int | None = None) -> Decimal:
    q = (select(func.coalesce(func.sum(ReturnLine.quantity), 0)).join(ReturnRequest)
         .where(ReturnLine.order_line_id == order_line_id, ReturnRequest.status.not_in(("rejected", "cancelled"))))
    if exclude_return:
        q = q.where(ReturnRequest.id != exclude_return)
    return db.scalar(q)


def line_value(ol: OrderLine, qty: Decimal) -> Decimal:
    return (ol.line_total / ol.quantity * qty).quantize(Decimal("0.01"))


router = APIRouter(prefix="/returns", tags=["returns"])
VIEW, CREATE, EDIT = (require_access("returns", a) for a in ("view", "create", "edit"))


@router.post("/from-order/{order_id}", response_model=ReturnOut, status_code=201)
def create_return(order_id: int, body: ReturnIn, db: DB, _: User = CREATE):
    o = get_or_404(db, Order, order_id, "Order")
    if o.status not in ("dispatched", "delivered", "processing"):
        raise AppError(409, "not_returnable", f"Can't return items from a {o.status} order")
    r = ReturnRequest(number=next_number(db, "return"), order_id=o.id, customer_id=o.customer_id, reason=body.reason,
                      reason_note=body.reason_note, warehouse_id=o.warehouse_id)
    db.add(r)
    db.flush()
    for ln in body.lines:
        ol = db.get(OrderLine, ln.order_line_id)
        if ol is None or ol.order_id != o.id:
            raise AppError(422, "invalid_line", "That line isn't on this order")
        left = ol.shipped_qty - already_returned(db, ol.id)
        if ln.quantity > left:
            raise AppError(422, "over_return", f"Line {ol.line_no}: only {left.normalize():f} can be returned")
        db.add(ReturnLine(return_id=r.id, order_line_id=ol.id, product_id=ol.product_id, quantity=ln.quantity))
    audit(db, "create", r)
    db.flush()
    return return_out(db, r)


@router.get("", response_model=Page[ReturnOut])
def list_returns(db: DB, p: Annotated[ListParams, Depends()], status: str | None = None,
                 order_id: int | None = None, customer_id: int | None = None, _: User = VIEW):
    q = apply_filters(select(ReturnRequest), ReturnRequest, p, (ReturnRequest.number,), {})
    for k, v in (("status", status), ("order_id", order_id), ("customer_id", customer_id)):
        if v is not None:
            q = q.where(getattr(ReturnRequest, k) == v)
    page = paginate(db, q, p)
    page["items"] = [return_out(db, r) for r in page["items"]]
    return page


@router.get("/{return_id}", response_model=ReturnOut)
def read_return(return_id: int, db: DB, _: User = VIEW):
    return return_out(db, get_or_404(db, ReturnRequest, return_id, "Return"))


@router.post("/{return_id}/receive", response_model=ReturnOut)
def receive_return(return_id: int, body: ReceiveIn, db: DB, _: User = EDIT):
    """Goods are back: record condition and what happens to each line. Restocked items go back into stock."""
    r = get_or_404(db, ReturnRequest, return_id, "Return")
    if r.status != "requested":
        raise AppError(409, "invalid_status", f"Return is {r.status}")
    lines = {ln.id: ln for ln in db.scalars(select(ReturnLine).where(ReturnLine.return_id == r.id))}
    if {i.line_id for i in body.lines} != set(lines):
        raise AppError(422, "inspect_all", "Inspect every returned line")
    wh = body.warehouse_id or r.warehouse_id or default_warehouse_id(db)
    for i in body.lines:
        ln = lines[i.line_id]
        ln.condition, ln.disposition, ln.inspection_note = i.condition, i.disposition, i.inspection_note
        p = db.get(Product, ln.product_id)
        if i.disposition == "restock" and wh and p.track_stock and p.kind != "bundle":
            batch_id = i.batch_id
            if batch_id is None and p.track_batches:
                batch_id = get_or_create_batch(db, p.id, r.number, expiry_date=i.expiry_date).id
            ol = db.get(OrderLine, ln.order_line_id)
            move(db, product_id=p.id, warehouse_id=wh, quantity=ln.quantity, reason="customer_return",
                 batch_id=batch_id, unit_cost=ol.unit_cost, ref=("return", r.id, r.number), note=i.inspection_note)
            ln.batch_id = batch_id
            fill_backorders(db, p.id, wh)
    r.status, r.received_at, r.warehouse_id = "received", utcnow(), wh
    audit(db, "receive", entity_type="returns", entity_id=r.id)
    return return_out(db, r)


@router.post("/{return_id}/complete", response_model=ReturnOut)
def complete_return(return_id: int, body: CompleteIn, db: DB, user: User = EDIT):
    r = get_or_404(db, ReturnRequest, return_id, "Return")
    if r.status != "received":
        raise AppError(409, "invalid_status", "Receive and inspect the return first")
    o = db.get(Order, r.order_id)
    lines = db.scalars(select(ReturnLine).where(ReturnLine.return_id == r.id)).all()
    value = sum((line_value(db.get(OrderLine, ln.order_line_id), ln.quantity) for ln in lines), ZERO)

    if body.resolution == "refund":
        ensure(db, user, "order_payments", "create")
        amount = body.refund_amount or value
        if amount > o.paid_total:
            raise AppError(422, "over_refund", f"Only {o.paid_total} was paid on this order")
        pay = Payment(number=next_number(db, "payment"), kind="refund", customer_id=o.customer_id, order_id=o.id,
                      payment_date=local_today(), method=body.refund_method or "cash", amount=amount,
                      note=f"Return {r.number}")
        db.add(pay)
        db.flush()
        r.refund_amount, r.refund_payment_id = amount, pay.id
    elif body.resolution == "credit_note":
        ensure(db, user, "invoices", "create")
        r.credit_note_id = credit_for_return(db, user, o, lines, r)
    elif body.resolution == "replacement":
        r.replacement_order_id = replacement_order(db, user, o, lines, r)

    r.resolution, r.status, r.completed_at, r.decision_note = body.resolution, "completed", utcnow(), body.note
    # whole order back? then the order itself is "returned" (and "refunded" if money went back in full)
    all_back = all(already_returned(db, ol.id) >= ol.shipped_qty
                   for ol in db.scalars(select(OrderLine).where(OrderLine.order_id == o.id)))
    refresh_payment_status(db, o)
    if all_back and o.status in ("dispatched", "delivered"):
        set_order_status(db, o, "returned", f"Return {r.number}")
    if o.status == "returned" and o.payment_status == "refunded":
        set_order_status(db, o, "refunded", f"Return {r.number}")
    audit(db, "complete", entity_type="returns", entity_id=r.id, after={"resolution": body.resolution})
    return return_out(db, r)


def set_order_status(db: Session, o: Order, to: str, note: str) -> None:
    frm, o.status = o.status, to
    db.add(OrderStatusHistory(order_id=o.id, from_status=frm, to_status=to, user_id=db.info.get("user_id"), note=note))


def credit_for_return(db: Session, user: User, o: Order, lines, r: ReturnRequest) -> int:
    inv = db.scalar(select(SalesDocument).where(SalesDocument.order_id == o.id, SalesDocument.doc_type == "invoice",
                                                SalesDocument.status.in_(OPEN_INVOICE)))
    if inv is None:
        raise AppError(422, "not_invoiced", "This order has no issued invoice; refund instead")
    inv_lines = {ln.product_id: ln.id for ln in db.scalars(select(SalesDocumentLine).where(
        SalesDocumentLine.document_id == inv.id))}
    picks = [CreditLineIn(line_id=inv_lines[ln.product_id], quantity=ln.quantity) for ln in lines
             if ln.product_id in inv_lines]
    cn = create_credit_note(inv.id, CreditNoteIn(reason=f"Return {r.number}", lines=picks), db, user)
    issue(db, db.get(SalesDocument, cn.id))
    return cn.id


def replacement_order(db: Session, user: User, o: Order, lines, r: ReturnRequest) -> int:
    ensure(db, user, "orders", "create")
    body = OrderCreate(customer_id=o.customer_id, customer_name=o.customer_name, customer_phone=o.customer_phone,
                       order_type="replacement", channel=o.channel, delivery_method=o.delivery_method,
                       shipping_address=None, warehouse_id=o.warehouse_id, notes=f"Replacement for {o.number}",
                       internal_notes=f"Return {r.number}",
                       lines=[LineIn(product_id=ln.product_id, quantity=ln.quantity) for ln in lines])
    new = create_order(body, db, user)
    db.get(Order, new.id).shipping_address = o.shipping_address
    return new.id


@router.post("/{return_id}/reject", response_model=ReturnOut)
def reject_return(return_id: int, body: CompleteIn | None, db: DB, _: User = EDIT):
    r = get_or_404(db, ReturnRequest, return_id, "Return")
    if r.status not in ("requested", "received"):
        raise AppError(409, "invalid_status", f"Return is {r.status}")
    if r.status == "received" and db.scalar(select(ReturnLine.id).where(
            ReturnLine.return_id == r.id, ReturnLine.disposition == "restock").limit(1)):
        raise AppError(409, "restocked", "Items were already restocked; complete the return with resolution 'none'")
    r.status, r.decision_note = "rejected", body.note if body else None
    audit(db, "reject", entity_type="returns", entity_id=r.id)
    return return_out(db, r)


# ======================= complaints =======================

class ComplaintIn(BaseModel):
    customer_id: int | None = None
    order_id: int | None = None
    product_id: int | None = None
    batch_id: int | None = None
    channel: str | None = None
    category: Literal["quality", "taste", "packaging", "delivery", "service", "billing", "other"]
    severity: Literal["low", "medium", "high"] = "medium"
    description: str = Field(min_length=3)
    owner_id: int | None = None


class ComplaintPatch(BaseModel):
    owner_id: int | None = None
    status: Literal["open", "in_progress", "resolved", "closed"] | None = None
    severity: Literal["low", "medium", "high"] | None = None
    resolution: str | None = None


class ComplaintOut(RecordOut, ComplaintIn):
    number: str
    status: str
    resolution: str | None
    first_response_at: datetime | None
    resolved_at: datetime | None
    created_at: datetime
    response_hours: Decimal | None = None
    resolution_hours: Decimal | None = None


def hours(a: datetime | None, b: datetime | None) -> Decimal | None:
    return Decimal((b - a).total_seconds() / 3600).quantize(Decimal("0.1")) if a and b else None


def complaint_out(c: Complaint) -> ComplaintOut:
    o = ComplaintOut.model_validate(c)
    o.response_hours, o.resolution_hours = hours(c.created_at, c.first_response_at), hours(c.created_at, c.resolved_at)
    return o


complaints = APIRouter(prefix="/complaints", tags=["complaints"])
C_VIEW, C_CREATE, C_EDIT = (require_access("complaints", a) for a in ("view", "create", "edit"))


@complaints.post("", response_model=ComplaintOut, status_code=201)
def create_complaint(body: ComplaintIn, db: DB, _: User = C_CREATE):
    if body.order_id and not body.customer_id:
        body.customer_id = get_or_404(db, Order, body.order_id, "Order").customer_id
    c = Complaint(number=next_number(db, "complaint"), **body.model_dump())
    db.add(c)
    audit(db, "create", c)
    db.flush()
    db.refresh(c)
    return complaint_out(c)


@complaints.get("", response_model=Page[ComplaintOut])
def list_complaints(db: DB, p: Annotated[ListParams, Depends()], status: str | None = None,
                    category: str | None = None, owner_id: int | None = None, customer_id: int | None = None,
                    product_id: int | None = None, batch_id: int | None = None, open_only: bool = False,
                    _: User = C_VIEW):
    q = apply_filters(select(Complaint), Complaint, p, (Complaint.number, Complaint.description), {})
    for k, v in (("status", status), ("category", category), ("owner_id", owner_id), ("customer_id", customer_id),
                 ("product_id", product_id), ("batch_id", batch_id)):
        if v is not None:
            q = q.where(getattr(Complaint, k) == v)
    if open_only:
        q = q.where(Complaint.status.in_(("open", "in_progress")))
    page = paginate(db, q, p)
    page["items"] = [complaint_out(c) for c in page["items"]]
    return page


@complaints.get("/stats")
def complaint_stats(db: DB, range: Range = "month", date_from: date | None = None, date_to: date | None = None,
                    _: User = C_VIEW):
    start, end = period(range, date_from, date_to)
    in_range = func.date(Complaint.created_at).between(start, end)
    by_cat = dict(db.execute(select(Complaint.category, func.count()).where(in_range)
                             .group_by(Complaint.category)).all())
    resp = db.scalar(select(func.avg(func.extract("epoch", Complaint.first_response_at - Complaint.created_at)))
                     .where(in_range, Complaint.first_response_at.is_not(None)))
    res = db.scalar(select(func.avg(func.extract("epoch", Complaint.resolved_at - Complaint.created_at)))
                    .where(in_range, Complaint.resolved_at.is_not(None)))
    return {"total": sum(by_cat.values()), "by_category": by_cat,
            "open": db.scalar(select(func.count()).select_from(Complaint).where(
                Complaint.status.in_(("open", "in_progress")))),
            "avg_response_hours": round(Decimal(resp) / 3600, 1) if resp else None,
            "avg_resolution_hours": round(Decimal(res) / 3600, 1) if res else None}


@complaints.get("/{complaint_id}", response_model=ComplaintOut)
def read_complaint(complaint_id: int, db: DB, _: User = C_VIEW):
    return complaint_out(get_or_404(db, Complaint, complaint_id, "Complaint"))


@complaints.patch("/{complaint_id}", response_model=ComplaintOut)
def update_complaint(complaint_id: int, body: ComplaintPatch, db: DB, _: User = C_EDIT):
    c = get_or_404(db, Complaint, complaint_id, "Complaint")
    before = snapshot(c)
    data = body.model_dump(exclude_unset=True)
    if data.get("status") in ("resolved", "closed") and not (data.get("resolution") or c.resolution):
        raise AppError(422, "resolution_required", "Describe how it was resolved", {"resolution": "required"})
    for k, v in data.items():
        setattr(c, k, v)
    now = utcnow()
    if c.status != "open" and c.first_response_at is None:
        c.first_response_at = now
    if c.status in ("resolved", "closed") and c.resolved_at is None:
        c.resolved_at = now
    audit(db, "update", c, before=before)
    return complaint_out(c)


# ======================= report =======================

reports = APIRouter(prefix="/reports", tags=["reports"])


@reports.get("/returns")
def returns_report(db: DB, range: Range = "month", date_from: date | None = None, date_to: date | None = None,
                   _: User = VIEW):
    start, end = period(range, date_from, date_to)
    shipped = db.scalar(select(func.count()).select_from(Order).where(
        Order.order_date.between(start, end), Order.fulfilment_status != "unfulfilled"))
    rets = select(ReturnRequest).where(func.date(ReturnRequest.created_at).between(start, end),
                                       ReturnRequest.status.not_in(("rejected", "cancelled")))
    n = db.scalar(select(func.count()).select_from(rets.subquery()))
    refunded = db.scalar(select(func.count()).select_from(rets.where(ReturnRequest.resolution == "refund").subquery()))
    reasons = dict(db.execute(select(ReturnRequest.reason, func.count()).where(
        func.date(ReturnRequest.created_at).between(start, end)).group_by(ReturnRequest.reason)).all())
    pct = (lambda a, b: round(Decimal(a) / b * 100, 1) if b else None)
    return {"from": start, "to": end, "orders_shipped": shipped, "returns": n, "return_rate_pct": pct(n, shipped),
            "refunds": refunded, "refund_rate_pct": pct(refunded, shipped), "reasons": reasons}


routers = [router, complaints, reports]
