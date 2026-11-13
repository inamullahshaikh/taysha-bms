"""Purchasing: requests -> approval -> purchase orders -> goods receipts (stock in) -> supplier bills -> payments."""

from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit import audit
from app.auth.access import can, require_access
from app.auth.models import User
from app.clock import local_today, utcnow
from app.company import get_company
from app.crud import RecordOut, get_or_404
from app.db import DB
from app.errors import AppError
from app.inventory.models import Warehouse
from app.inventory.service import default_warehouse_id, fill_backorders, get_or_create_batch, move, to_base_qty
from app.listing import ListParams, Page, apply_filters, export_response, paginate
from app.numbering import next_number
from app.pdf import pdf_response, render_pdf
from app.products.models import Product
from app.products.pricing import money
from app.purchasing.models import (
    GoodsReceipt, GoodsReceiptLine, PurchaseOrder, PurchaseOrderLine, PurchaseRequest, PurchaseRequestLine,
    SupplierBill, SupplierBillLine, SupplierPayment, SupplierRating,
)
from app.suppliers import Supplier

ZERO = Decimal(0)
P_VIEW, P_CREATE, P_EDIT, P_APPROVE, P_EXPORT = (require_access("purchasing", a)
                                                 for a in ("view", "create", "edit", "approve", "export"))
B_VIEW, B_CREATE, B_EDIT, B_EXPORT = (require_access("supplier_bills", a)
                                      for a in ("view", "create", "edit", "export"))
Method = Literal["cash", "bank_transfer", "cheque", "card", "online", "other"]


def check_approver(db: Session, user: User, created_by_id: int | None, amount: Decimal) -> None:
    """Same rule as expenses: not your own, and an owner above the company's purchase limit."""
    if created_by_id == user.id:
        raise AppError(403, "own_request", "You can't approve your own purchase")
    limit = get_company(db).purchase_approval_limit
    if limit is not None and amount > limit and not user.is_owner:
        raise AppError(403, "over_limit", f"Purchases over {limit} need an owner's approval")


# ======================= purchase requests =======================

class PRLineIn(BaseModel):
    product_id: int
    quantity: Decimal = Field(gt=0)
    unit: str | None = None
    estimated_unit_cost: Decimal | None = Field(None, ge=0)
    suggested_supplier_id: int | None = None
    note: str | None = None


class PRIn(BaseModel):
    needed_by: date | None = None
    warehouse_id: int | None = None
    note: str | None = None
    lines: list[PRLineIn] = Field(min_length=1)


class PROut(RecordOut):
    number: str
    status: str
    needed_by: date | None
    warehouse_id: int | None
    note: str | None
    estimated_total: Decimal
    created_by_id: int | None
    created_at: datetime
    decided_by_id: int | None
    decided_at: datetime | None
    decision_note: str | None
    lines: list[dict] = []


class DecisionIn(BaseModel):
    note: str | None = None


def pr_out(db: Session, r: PurchaseRequest) -> PROut:
    o = PROut.model_validate(r)
    o.lines = [{k: getattr(ln, k) for k in ("id", "product_id", "quantity", "unit", "estimated_unit_cost",
                                            "suggested_supplier_id", "note")}
               for ln in db.scalars(select(PurchaseRequestLine).where(PurchaseRequestLine.request_id == r.id)
                                    .order_by(PurchaseRequestLine.id))]
    return o


pr_router = APIRouter(prefix="/purchase-requests", tags=["purchasing"])


@pr_router.post("", response_model=PROut, status_code=201)
def create_request(body: PRIn, db: DB, _: User = P_CREATE):
    for ln in body.lines:
        get_or_404(db, Product, ln.product_id, "Product")
    est = sum((money(ln.quantity * ln.estimated_unit_cost) for ln in body.lines if ln.estimated_unit_cost), ZERO)
    r = PurchaseRequest(number=next_number(db, "purchase_request"), needed_by=body.needed_by,
                        warehouse_id=body.warehouse_id, note=body.note, estimated_total=est)
    db.add(r)
    db.flush()
    db.add_all(PurchaseRequestLine(request_id=r.id, **ln.model_dump()) for ln in body.lines)
    audit(db, "create", r)
    return pr_out(db, r)


@pr_router.get("", response_model=Page[PROut])
def list_requests(db: DB, p: Annotated[ListParams, Depends()], status: str | None = None, _: User = P_VIEW):
    q = apply_filters(select(PurchaseRequest), PurchaseRequest, p, (PurchaseRequest.number, PurchaseRequest.note), {})
    if status:
        q = q.where(PurchaseRequest.status == status)
    page = paginate(db, q, p)
    page["items"] = [pr_out(db, r) for r in page["items"]]
    return page


@pr_router.get("/{request_id}", response_model=PROut)
def read_request(request_id: int, db: DB, _: User = P_VIEW):
    return pr_out(db, get_or_404(db, PurchaseRequest, request_id, "Purchase request"))


def decide_request(db: Session, user: User, request_id: int, status: str, note: str | None) -> PurchaseRequest:
    r = get_or_404(db, PurchaseRequest, request_id, "Purchase request")
    if r.status != "requested":
        raise AppError(409, "decided", f"This request is already {r.status}")
    if status == "approved":
        check_approver(db, user, r.created_by_id, r.estimated_total)
    elif r.created_by_id == user.id:
        raise AppError(403, "own_request", "You can't reject your own request; cancel it instead")
    r.status, r.decided_by_id, r.decided_at, r.decision_note = status, user.id, utcnow(), note
    audit(db, status, entity_type="purchase_requests", entity_id=r.id, note=note)
    return r


@pr_router.post("/{request_id}/approve", response_model=PROut)
def approve_request(request_id: int, body: DecisionIn, db: DB, user: User = P_APPROVE):
    return pr_out(db, decide_request(db, user, request_id, "approved", body.note))


@pr_router.post("/{request_id}/reject", response_model=PROut)
def reject_request(request_id: int, body: DecisionIn, db: DB, user: User = P_APPROVE):
    if not body.note:
        raise AppError(422, "reason_required", "Say why it's rejected", {"note": "required"})
    return pr_out(db, decide_request(db, user, request_id, "rejected", body.note))


@pr_router.post("/{request_id}/cancel", response_model=PROut)
def cancel_request(request_id: int, db: DB, _: User = P_CREATE):
    r = get_or_404(db, PurchaseRequest, request_id, "Purchase request")
    if r.status not in ("requested", "approved"):
        raise AppError(409, "not_cancellable", f"This request is {r.status}")
    r.status = "cancelled"
    audit(db, "cancel", entity_type="purchase_requests", entity_id=r.id)
    return pr_out(db, r)


class ConvertIn(BaseModel):
    supplier_id: int | None = None  # else each line's suggested supplier


# ======================= purchase orders =======================

class POLineIn(BaseModel):
    product_id: int
    quantity: Decimal = Field(gt=0)
    unit: str | None = None
    unit_cost: Decimal | None = Field(None, ge=0)  # excl. tax; empty = last price from this supplier
    tax_rate: Decimal = Field(ZERO, ge=0, le=100)
    description: str | None = None


class POIn(BaseModel):
    supplier_id: int
    order_date: date | None = None
    expected_date: date | None = None
    warehouse_id: int | None = None
    notes: str | None = None
    terms: str | None = None
    lines: list[POLineIn] = Field(min_length=1)


class POLineOut(BaseModel):
    model_config = {"from_attributes": True}
    id: int
    line_no: int
    product_id: int
    description: str
    quantity: Decimal
    unit: str | None
    base_quantity: Decimal
    unit_cost: Decimal
    tax_rate: Decimal
    tax_amount: Decimal
    line_total: Decimal
    received_base_qty: Decimal
    billed_quantity: Decimal


class POOut(RecordOut):
    number: str
    supplier_id: int
    supplier_name: str = ""
    status: str
    order_date: date
    expected_date: date | None
    warehouse_id: int | None
    purchase_request_id: int | None
    subtotal: Decimal
    tax_total: Decimal
    grand_total: Decimal
    notes: str | None
    terms: str | None
    created_by_id: int | None
    approved_by_id: int | None
    approved_at: datetime | None
    ordered_at: datetime | None
    cancelled_reason: str | None
    created_at: datetime
    lines: list[POLineOut] = []


def last_cost(db: Session, supplier_id: int, product_id: int, unit: str | None) -> Decimal | None:
    return db.scalar(select(PurchaseOrderLine.unit_cost).join(PurchaseOrder)
                     .where(PurchaseOrder.supplier_id == supplier_id, PurchaseOrderLine.product_id == product_id,
                            PurchaseOrderLine.unit.is_(None) if unit is None else PurchaseOrderLine.unit == unit,
                            PurchaseOrder.status != "cancelled")
                     .order_by(PurchaseOrder.order_date.desc(), PurchaseOrderLine.id.desc()).limit(1))


def write_po_lines(db: Session, po: PurchaseOrder, lines: list[POLineIn]) -> None:
    db.query(PurchaseOrderLine).filter(PurchaseOrderLine.purchase_order_id == po.id).delete()
    sub = tax = ZERO
    for i, ln in enumerate(lines, start=1):
        p = get_or_404(db, Product, ln.product_id, "Product")
        cost = ln.unit_cost if ln.unit_cost is not None else last_cost(db, po.supplier_id, p.id, ln.unit)
        if cost is None:
            raise AppError(422, "cost_required", f"Enter a cost for {p.name} (no previous price from this supplier)",
                           {f"lines.{i - 1}.unit_cost": "required"})
        net = money(ln.quantity * cost)
        t = money(net * ln.tax_rate / 100)
        db.add(PurchaseOrderLine(purchase_order_id=po.id, line_no=i, product_id=p.id,
                                 description=ln.description or p.name, quantity=ln.quantity, unit=ln.unit,
                                 base_quantity=to_base_qty(db, p, ln.quantity, ln.unit), unit_cost=cost,
                                 tax_rate=ln.tax_rate, tax_amount=t, line_total=net + t))
        sub, tax = sub + net, tax + t
    po.subtotal, po.tax_total, po.grand_total = sub, tax, sub + tax
    db.flush()


def po_lines(db: Session, po_id: int) -> list[PurchaseOrderLine]:
    return db.scalars(select(PurchaseOrderLine).where(PurchaseOrderLine.purchase_order_id == po_id)
                      .order_by(PurchaseOrderLine.line_no)).all()


def po_out(db: Session, po: PurchaseOrder) -> POOut:
    o = POOut.model_validate(po)
    o.supplier_name = db.get(Supplier, po.supplier_id).name
    o.lines = [POLineOut.model_validate(x) for x in po_lines(db, po.id)]
    return o


po_router = APIRouter(prefix="/purchase-orders", tags=["purchasing"])


@pr_router.post("/{request_id}/convert", response_model=list[POOut])
def convert_request(request_id: int, body: ConvertIn, db: DB, user: User = P_CREATE):
    """Approved request -> one purchase order per supplier. The request's approval carries over."""
    r = get_or_404(db, PurchaseRequest, request_id, "Purchase request")
    if r.status != "approved":
        raise AppError(409, "not_approved", "Only approved requests can become purchase orders")
    groups: dict[int, list[PurchaseRequestLine]] = defaultdict(list)
    for ln in db.scalars(select(PurchaseRequestLine).where(PurchaseRequestLine.request_id == r.id)):
        sid = body.supplier_id or ln.suggested_supplier_id
        if sid is None:
            raise AppError(422, "supplier_required", "Pick a supplier (some lines have no suggested supplier)")
        groups[sid].append(ln)
    out = []
    for sid, lines in groups.items():
        get_or_404(db, Supplier, sid, "Supplier")
        po = PurchaseOrder(number=next_number(db, "purchase_order"), supplier_id=sid, status="approved",
                           order_date=local_today(), expected_date=r.needed_by, purchase_request_id=r.id,
                           warehouse_id=r.warehouse_id or default_warehouse_id(db), approved_by_id=r.decided_by_id,
                           approved_at=r.decided_at)
        db.add(po)
        db.flush()
        write_po_lines(db, po, [POLineIn(product_id=ln.product_id, quantity=ln.quantity, unit=ln.unit,
                                         unit_cost=ln.estimated_unit_cost) for ln in lines])
        audit(db, "create", po, note=f"from {r.number}")
        out.append(po_out(db, po))
    r.status = "converted"
    return out


SEARCH = (PurchaseOrder.number, PurchaseOrder.notes)
SORTS = {"order_date": PurchaseOrder.order_date, "number": PurchaseOrder.number,
         "grand_total": PurchaseOrder.grand_total, "expected_date": PurchaseOrder.expected_date}


class POFilters:
    def __init__(self, status: str | None = None, supplier_id: int | None = None, date_from: date | None = None,
                 date_to: date | None = None, open_only: bool = False, product_id: int | None = None):
        self.status, self.supplier_id, self.date_from, self.date_to = status, supplier_id, date_from, date_to
        self.open_only, self.product_id = open_only, product_id

    def apply(self, q):
        if self.status:
            q = q.where(PurchaseOrder.status == self.status)
        if self.supplier_id:
            q = q.where(PurchaseOrder.supplier_id == self.supplier_id)
        if self.date_from:
            q = q.where(PurchaseOrder.order_date >= self.date_from)
        if self.date_to:
            q = q.where(PurchaseOrder.order_date <= self.date_to)
        if self.open_only:
            q = q.where(PurchaseOrder.status.in_(("requested", "approved", "ordered", "partially_received")))
        if self.product_id:
            q = q.where(PurchaseOrder.id.in_(select(PurchaseOrderLine.purchase_order_id).where(
                PurchaseOrderLine.product_id == self.product_id)))
        return q


@po_router.get("", response_model=Page[POOut])
def list_pos(db: DB, p: Annotated[ListParams, Depends()], f: Annotated[POFilters, Depends()], _: User = P_VIEW):
    page = paginate(db, f.apply(apply_filters(select(PurchaseOrder), PurchaseOrder, p, SEARCH, SORTS)), p)
    page["items"] = [po_out(db, x) for x in page["items"]]
    return page


@po_router.get("/export")
def export_pos(db: DB, p: Annotated[ListParams, Depends()], f: Annotated[POFilters, Depends()],
               format: str = "csv", _: User = P_EXPORT):
    rows = [po_out(db, x).model_dump() for x in db.scalars(f.apply(apply_filters(
        select(PurchaseOrder), PurchaseOrder, p, SEARCH, SORTS)))]
    cols = [("number", "PO"), ("order_date", "Date"), ("supplier_name", "Supplier"), ("status", "Status"),
            ("expected_date", "Expected"), ("subtotal", "Subtotal"), ("tax_total", "Tax"), ("grand_total", "Total")]
    return export_response(db, rows, cols, format, "purchase-orders", "purchase_orders")


@po_router.post("", response_model=POOut, status_code=201)
def create_po(body: POIn, db: DB, _: User = P_CREATE):
    get_or_404(db, Supplier, body.supplier_id, "Supplier")
    po = PurchaseOrder(number=next_number(db, "purchase_order"), supplier_id=body.supplier_id, status="draft",
                       order_date=body.order_date or local_today(), expected_date=body.expected_date,
                       warehouse_id=body.warehouse_id or default_warehouse_id(db), notes=body.notes, terms=body.terms)
    db.add(po)
    db.flush()
    write_po_lines(db, po, body.lines)
    audit(db, "create", po)
    return po_out(db, po)


@po_router.get("/{po_id}", response_model=POOut)
def read_po(po_id: int, db: DB, _: User = P_VIEW):
    return po_out(db, get_or_404(db, PurchaseOrder, po_id, "Purchase order"))


@po_router.put("/{po_id}", response_model=POOut)
def update_po(po_id: int, body: POIn, db: DB, _: User = P_EDIT):
    po = get_or_404(db, PurchaseOrder, po_id, "Purchase order")
    if po.status not in ("draft", "requested"):
        raise AppError(409, "locked", f"A {po.status} purchase order can't be edited")
    po.status = "draft"  # editing sends it back for approval
    po.supplier_id, po.expected_date, po.notes, po.terms = body.supplier_id, body.expected_date, body.notes, body.terms
    po.order_date = body.order_date or po.order_date
    po.warehouse_id = body.warehouse_id or po.warehouse_id
    write_po_lines(db, po, body.lines)
    audit(db, "update", po)
    return po_out(db, po)


def po_transition(db: Session, po: PurchaseOrder, allowed_from: tuple, to: str, note: str | None = None) -> None:
    if po.status not in allowed_from:
        raise AppError(409, "invalid_transition", f"Can't go from {po.status} to {to}")
    frm, po.status = po.status, to
    audit(db, "status", entity_type="purchase_orders", entity_id=po.id, before={"status": frm},
          after={"status": to}, note=note)


@po_router.post("/{po_id}/submit", response_model=POOut)
def submit_po(po_id: int, db: DB, _: User = P_CREATE):
    po = get_or_404(db, PurchaseOrder, po_id, "Purchase order")
    po_transition(db, po, ("draft",), "requested")
    return po_out(db, po)


@po_router.post("/{po_id}/approve", response_model=POOut)
def approve_po(po_id: int, body: DecisionIn, db: DB, user: User = P_APPROVE):
    po = get_or_404(db, PurchaseOrder, po_id, "Purchase order")
    check_approver(db, user, po.created_by_id, po.grand_total)
    po_transition(db, po, ("requested",), "approved", body.note)
    po.approved_by_id, po.approved_at = user.id, utcnow()
    return po_out(db, po)


@po_router.post("/{po_id}/reject", response_model=POOut)
def reject_po(po_id: int, body: DecisionIn, db: DB, _: User = P_APPROVE):
    if not body.note:
        raise AppError(422, "reason_required", "Say why it's rejected", {"note": "required"})
    po = get_or_404(db, PurchaseOrder, po_id, "Purchase order")
    po_transition(db, po, ("requested",), "draft", f"rejected: {body.note}")
    return po_out(db, po)


@po_router.post("/{po_id}/send", response_model=POOut)
def mark_ordered(po_id: int, db: DB, _: User = P_EDIT):
    """Mark as sent to the supplier (download the PDF to send it)."""
    po = get_or_404(db, PurchaseOrder, po_id, "Purchase order")
    po_transition(db, po, ("approved",), "ordered")
    po.ordered_at = utcnow()
    return po_out(db, po)


@po_router.post("/{po_id}/cancel", response_model=POOut)
def cancel_po(po_id: int, body: DecisionIn, db: DB, _: User = P_EDIT):
    po = get_or_404(db, PurchaseOrder, po_id, "Purchase order")
    if any(ln.received_base_qty for ln in po_lines(db, po.id)):
        raise AppError(409, "has_receipts", "Goods were already received on this order")
    po_transition(db, po, ("draft", "requested", "approved", "ordered"), "cancelled", body.note)
    po.cancelled_reason = body.note
    return po_out(db, po)


@po_router.get("/{po_id}/pdf")
def po_pdf(po_id: int, db: DB, _: User = P_VIEW):
    po = get_or_404(db, PurchaseOrder, po_id, "Purchase order")
    wh = db.get(Warehouse, po.warehouse_id) if po.warehouse_id else None
    data = render_pdf(db, "purchase_order.html", po=po, lines=po_lines(db, po.id),
                      supplier=db.get(Supplier, po.supplier_id), warehouse=wh)
    return pdf_response(data, f"{po.number}.pdf")


# ---------- goods receipts ----------

class GRLineIn(BaseModel):
    po_line_id: int
    quantity: Decimal = Field(gt=0)  # in the PO line's unit
    batch_number: str | None = None
    supplier_batch_no: str | None = None
    mfg_date: date | None = None
    expiry_date: date | None = None
    location_id: int | None = None
    qc_result: Literal["pass", "fail", "pending"] = "pass"
    qc_note: str | None = None


class GRIn(BaseModel):
    warehouse_id: int | None = None
    received_date: date | None = None
    supplier_delivery_note: str | None = None
    note: str | None = None
    lines: list[GRLineIn] = Field(min_length=1)


class GROut(RecordOut):
    number: str
    purchase_order_id: int | None
    supplier_id: int
    warehouse_id: int
    received_date: date
    supplier_delivery_note: str | None
    note: str | None
    created_at: datetime
    lines: list[dict] = []


def gr_out(db: Session, g: GoodsReceipt) -> GROut:
    o = GROut.model_validate(g)
    o.lines = [{k: getattr(ln, k) for k in ("id", "po_line_id", "product_id", "quantity", "unit", "base_quantity",
                                            "batch_id", "supplier_batch_no", "expiry_date", "qc_result", "qc_note")}
               for ln in db.scalars(select(GoodsReceiptLine).where(GoodsReceiptLine.receipt_id == g.id))]
    return o


@po_router.post("/{po_id}/receive", response_model=GROut, status_code=201)
def receive_po(po_id: int, body: GRIn, db: DB, _: User = require_access("inventory", "create")):
    """Goods in against a PO. Failed QC -> batch rejected, pending QC -> batch on hold; neither can be sold."""
    po = get_or_404(db, PurchaseOrder, po_id, "Purchase order")
    if po.status not in ("approved", "ordered", "partially_received"):
        raise AppError(409, "not_receivable", f"Can't receive against a {po.status} purchase order")
    wh = body.warehouse_id or po.warehouse_id or default_warehouse_id(db)
    if wh is None:
        raise AppError(422, "no_warehouse", "Create a warehouse first")
    g = GoodsReceipt(number=next_number(db, "goods_receipt"), purchase_order_id=po.id, supplier_id=po.supplier_id,
                     warehouse_id=wh, received_date=body.received_date or local_today(),
                     supplier_delivery_note=body.supplier_delivery_note, note=body.note)
    db.add(g)
    db.flush()
    lines = {ln.id: ln for ln in po_lines(db, po.id)}
    for gl in body.lines:
        pl = lines.get(gl.po_line_id)
        if pl is None:
            raise AppError(422, "invalid_line", "That line isn't on this purchase order")
        p = db.get(Product, pl.product_id)
        base = to_base_qty(db, p, gl.quantity, pl.unit)
        if pl.received_base_qty + base > pl.base_quantity:
            raise AppError(422, "over_receipt", f"{p.name}: receiving more than ordered "
                                                f"({(pl.base_quantity - pl.received_base_qty).normalize():f} left)")
        unit_cost = pl.unit_cost * pl.quantity / pl.base_quantity  # per base unit, excl. tax
        batch_id = None
        status = {"pass": "available", "fail": "rejected", "pending": "hold"}[gl.qc_result]
        if p.track_batches:
            number = gl.batch_number or gl.supplier_batch_no or f"{g.number}-{pl.line_no}"
            expiry = gl.expiry_date or (gl.mfg_date + timedelta(days=p.shelf_life_days)
                                        if gl.mfg_date and p.shelf_life_days else None)
            b = get_or_create_batch(db, p.id, number, mfg_date=gl.mfg_date, expiry_date=expiry,
                                    supplier_id=po.supplier_id, supplier_batch_no=gl.supplier_batch_no, status=status)
            batch_id = b.id
        if p.track_stock and (batch_id or gl.qc_result == "pass"):  # unbatched failed goods aren't put into stock
            move(db, product_id=p.id, warehouse_id=wh, quantity=base, reason="purchase_receipt", batch_id=batch_id,
                 location_id=gl.location_id, unit_cost=unit_cost, ref=("goods_receipt", g.id, g.number),
                 note=f"{po.number}")
        pl.received_base_qty += base
        db.add(GoodsReceiptLine(receipt_id=g.id, po_line_id=pl.id, product_id=p.id, quantity=gl.quantity, unit=pl.unit,
                                base_quantity=base, unit_cost=unit_cost, batch_id=batch_id,
                                supplier_batch_no=gl.supplier_batch_no, expiry_date=gl.expiry_date,
                                qc_result=gl.qc_result, qc_note=gl.qc_note))
        if gl.qc_result == "pass":
            fill_backorders(db, p.id, wh)
    db.flush()
    done = all(ln.received_base_qty >= ln.base_quantity for ln in lines.values())
    po.status = "received" if done else "partially_received"
    audit(db, "receive", entity_type="purchase_orders", entity_id=po.id, note=g.number)
    return gr_out(db, g)


gr_router = APIRouter(prefix="/goods-receipts", tags=["purchasing"])


@gr_router.get("", response_model=Page[GROut])
def list_receipts(db: DB, p: Annotated[ListParams, Depends()], supplier_id: int | None = None,
                  purchase_order_id: int | None = None, _: User = P_VIEW):
    q = apply_filters(select(GoodsReceipt), GoodsReceipt, p, (GoodsReceipt.number,), {})
    if supplier_id:
        q = q.where(GoodsReceipt.supplier_id == supplier_id)
    if purchase_order_id:
        q = q.where(GoodsReceipt.purchase_order_id == purchase_order_id)
    page = paginate(db, q, p)
    page["items"] = [gr_out(db, g) for g in page["items"]]
    return page


@gr_router.get("/{receipt_id}", response_model=GROut)
def read_receipt(receipt_id: int, db: DB, _: User = P_VIEW):
    return gr_out(db, get_or_404(db, GoodsReceipt, receipt_id, "Goods receipt"))


# ======================= supplier bills & payments =======================

class BillLineIn(BaseModel):
    product_id: int | None = None
    description: str | None = None
    quantity: Decimal = Field(gt=0)
    unit_cost: Decimal = Field(ge=0)
    tax_rate: Decimal = Field(ZERO, ge=0, le=100)


class BillIn(BaseModel):
    supplier_id: int
    supplier_invoice_number: str | None = None
    bill_date: date | None = None
    due_date: date | None = None
    withholding_tax: Decimal = Field(ZERO, ge=0)
    notes: str | None = None
    lines: list[BillLineIn] = Field(min_length=1)


class BillFromPOLine(BaseModel):
    po_line_id: int
    quantity: Decimal = Field(gt=0)
    unit_cost: Decimal | None = None  # if the supplier billed a different price


class BillFromPOIn(BaseModel):
    supplier_invoice_number: str | None = None
    bill_date: date | None = None
    due_date: date | None = None
    withholding_tax: Decimal = Field(ZERO, ge=0)
    notes: str | None = None
    lines: list[BillFromPOLine] | None = None  # None = everything received and not yet billed


class BillOut(RecordOut):
    number: str
    supplier_invoice_number: str | None
    supplier_id: int
    purchase_order_id: int | None
    bill_date: date
    due_date: date | None
    subtotal: Decimal
    tax_total: Decimal
    withholding_tax: Decimal
    grand_total: Decimal
    paid_total: Decimal
    balance_due: Decimal
    status: str
    notes: str | None
    created_at: datetime
    lines: list[dict] = []


class SupplierPaymentIn(BaseModel):
    method: Method
    amount: Decimal = Field(gt=0, decimal_places=2)
    payment_date: date | None = None
    reference: str | None = None
    note: str | None = None


class SupplierPaymentOut(RecordOut):
    number: str
    supplier_id: int
    bill_id: int | None
    payment_date: date
    method: str
    amount: Decimal
    reference: str | None
    note: str | None
    created_at: datetime


def bill_out(db: Session, b: SupplierBill) -> BillOut:
    o = BillOut.model_validate(b)
    o.lines = [{k: getattr(ln, k) for k in ("id", "po_line_id", "product_id", "description", "quantity", "unit_cost",
                                            "tax_rate", "tax_amount", "line_total")}
               for ln in db.scalars(select(SupplierBillLine).where(SupplierBillLine.bill_id == b.id)
                                    .order_by(SupplierBillLine.id))]
    return o


def refresh_bill(db: Session, b: SupplierBill) -> None:
    db.flush()
    b.paid_total = db.scalar(select(func.coalesce(func.sum(SupplierPayment.amount), 0)).where(
        SupplierPayment.bill_id == b.id))
    if b.status == "cancelled":
        return
    if b.balance_due <= 0:
        b.status = "paid"
    elif b.due_date and b.due_date < local_today():
        b.status = "overdue"
    elif b.paid_total > 0:
        b.status = "partially_paid"
    else:
        b.status = "unpaid"


def make_bill(db: Session, supplier_id: int, head, lines: list[dict], po_id: int | None = None) -> SupplierBill:
    s = get_or_404(db, Supplier, supplier_id, "Supplier")
    bill_date = head.bill_date or local_today()
    b = SupplierBill(number=next_number(db, "supplier_bill"), supplier_invoice_number=head.supplier_invoice_number,
                     supplier_id=supplier_id, purchase_order_id=po_id, bill_date=bill_date,
                     due_date=head.due_date or bill_date + timedelta(days=s.payment_terms_days),
                     withholding_tax=head.withholding_tax, notes=head.notes)
    db.add(b)
    db.flush()
    sub = tax = ZERO
    for ln in lines:
        net = money(ln["quantity"] * ln["unit_cost"])
        t = money(net * ln["tax_rate"] / 100)
        db.add(SupplierBillLine(bill_id=b.id, tax_amount=t, line_total=net + t, **ln))
        sub, tax = sub + net, tax + t
    b.subtotal, b.tax_total, b.grand_total = sub, tax, sub + tax
    if b.withholding_tax > b.grand_total:
        raise AppError(422, "withholding_too_high", "Withholding can't exceed the bill total")
    refresh_bill(db, b)
    audit(db, "create", b)
    return b


bill_router = APIRouter(prefix="/supplier-bills", tags=["supplier bills"])


@po_router.post("/{po_id}/bill", response_model=BillOut, status_code=201)
def bill_from_po(po_id: int, body: BillFromPOIn, db: DB, _: User = B_CREATE):
    po = get_or_404(db, PurchaseOrder, po_id, "Purchase order")
    lines = {ln.id: ln for ln in po_lines(db, po.id)}
    picks = body.lines
    if picks is None:  # bill what was received but not yet billed
        picks = []
        for ln in lines.values():
            received_units = ln.received_base_qty * ln.quantity / ln.base_quantity
            if received_units > ln.billed_quantity:
                picks.append(BillFromPOLine(po_line_id=ln.id, quantity=received_units - ln.billed_quantity))
        if not picks:
            raise AppError(422, "nothing_to_bill", "Nothing received is waiting to be billed")
    rows = []
    for pk in picks:
        ln = lines.get(pk.po_line_id)
        if ln is None:
            raise AppError(422, "invalid_line", "That line isn't on this purchase order")
        if ln.billed_quantity + pk.quantity > ln.quantity:
            raise AppError(422, "over_bill", f"{ln.description}: billing more than ordered")
        ln.billed_quantity += pk.quantity
        rows.append({"po_line_id": ln.id, "product_id": ln.product_id, "description": ln.description,
                     "quantity": pk.quantity, "unit_cost": pk.unit_cost if pk.unit_cost is not None else ln.unit_cost,
                     "tax_rate": ln.tax_rate})
    return bill_out(db, make_bill(db, po.supplier_id, body, rows, po.id))


@bill_router.post("", response_model=BillOut, status_code=201)
def create_bill(body: BillIn, db: DB, _: User = B_CREATE):
    rows = []
    for ln in body.lines:
        desc = ln.description or (get_or_404(db, Product, ln.product_id, "Product").name if ln.product_id else None)
        if not desc:
            raise AppError(422, "description_required", "Each line needs a product or a description")
        rows.append({"product_id": ln.product_id, "description": desc, "quantity": ln.quantity,
                     "unit_cost": ln.unit_cost, "tax_rate": ln.tax_rate})
    return bill_out(db, make_bill(db, body.supplier_id, body, rows))


class BillFilters:
    def __init__(self, supplier_id: int | None = None, status: str | None = None, unpaid: bool = False,
                 date_from: date | None = None, date_to: date | None = None):
        self.supplier_id, self.status, self.unpaid, self.date_from, self.date_to = (
            supplier_id, status, unpaid, date_from, date_to)

    def apply(self, q):
        if self.supplier_id:
            q = q.where(SupplierBill.supplier_id == self.supplier_id)
        if self.status:
            q = q.where(SupplierBill.status == self.status)
        if self.unpaid:
            q = q.where(SupplierBill.status.in_(("unpaid", "partially_paid", "overdue")))
        if self.date_from:
            q = q.where(SupplierBill.bill_date >= self.date_from)
        if self.date_to:
            q = q.where(SupplierBill.bill_date <= self.date_to)
        return q


BILL_SEARCH = (SupplierBill.number, SupplierBill.supplier_invoice_number)
BILL_SORTS = {"bill_date": SupplierBill.bill_date, "due_date": SupplierBill.due_date,
              "grand_total": SupplierBill.grand_total}


@bill_router.get("", response_model=Page[BillOut])
def list_bills(db: DB, p: Annotated[ListParams, Depends()], f: Annotated[BillFilters, Depends()], _: User = B_VIEW):
    page = paginate(db, f.apply(apply_filters(select(SupplierBill), SupplierBill, p, BILL_SEARCH, BILL_SORTS)), p)
    page["items"] = [bill_out(db, b) for b in page["items"]]
    return page


@bill_router.get("/export")
def export_bills(db: DB, p: Annotated[ListParams, Depends()], f: Annotated[BillFilters, Depends()],
                 format: str = "csv", _: User = B_EXPORT):
    rows = [BillOut.model_validate(b).model_dump() for b in db.scalars(
        f.apply(apply_filters(select(SupplierBill), SupplierBill, p, BILL_SEARCH, BILL_SORTS)))]
    cols = [("number", "Bill"), ("supplier_invoice_number", "Supplier invoice"), ("bill_date", "Date"),
            ("due_date", "Due"), ("grand_total", "Total"), ("withholding_tax", "WHT"), ("paid_total", "Paid"),
            ("balance_due", "Balance"), ("status", "Status")]
    return export_response(db, rows, cols, format, "supplier-bills", "supplier_bills")


@bill_router.get("/{bill_id}", response_model=BillOut)
def read_bill(bill_id: int, db: DB, _: User = B_VIEW):
    return bill_out(db, get_or_404(db, SupplierBill, bill_id, "Bill"))


@bill_router.post("/{bill_id}/cancel", response_model=BillOut)
def cancel_bill(bill_id: int, body: DecisionIn, db: DB, _: User = B_EDIT):
    b = get_or_404(db, SupplierBill, bill_id, "Bill")
    if b.paid_total:
        raise AppError(409, "has_payments", "This bill has payments")
    for ln in db.scalars(select(SupplierBillLine).where(SupplierBillLine.bill_id == b.id,
                                                        SupplierBillLine.po_line_id.is_not(None))):
        db.get(PurchaseOrderLine, ln.po_line_id).billed_quantity -= ln.quantity
    b.status, b.cancelled_reason = "cancelled", body.note
    audit(db, "cancel", entity_type="supplier_bills", entity_id=b.id, note=body.note)
    return bill_out(db, b)


@bill_router.get("/{bill_id}/payments", response_model=list[SupplierPaymentOut])
def bill_payments(bill_id: int, db: DB, _: User = B_VIEW):
    return db.scalars(select(SupplierPayment).where(SupplierPayment.bill_id == bill_id)
                      .order_by(SupplierPayment.id)).all()


@bill_router.post("/{bill_id}/payments", response_model=SupplierPaymentOut, status_code=201)
def pay_bill(bill_id: int, body: SupplierPaymentIn, db: DB, _: User = B_CREATE):
    b = get_or_404(db, SupplierBill, bill_id, "Bill")
    if b.status == "cancelled":
        raise AppError(409, "cancelled", "This bill is cancelled")
    if body.amount > b.balance_due:
        raise AppError(422, "overpayment", f"Only {b.balance_due} is due", {"amount": f"max {b.balance_due}"})
    pay = SupplierPayment(number=next_number(db, "supplier_payment"), supplier_id=b.supplier_id, bill_id=b.id,
                          payment_date=body.payment_date or local_today(),
                          **body.model_dump(exclude={"payment_date"}))
    db.add(pay)
    audit(db, "create", pay)
    refresh_bill(db, b)
    return pay


def mark_overdue_bills(db: Session) -> int:
    rows = db.scalars(select(SupplierBill).where(SupplierBill.status.in_(("unpaid", "partially_paid")),
                                                 SupplierBill.due_date < local_today())).all()
    for b in rows:
        refresh_bill(db, b)
    return len(rows)


# ======================= supplier insights =======================

sup_router = APIRouter(tags=["suppliers"])


@sup_router.get("/suppliers/{supplier_id}/price-history")
def price_history(supplier_id: int, db: DB, product_id: int | None = None, _: User = P_VIEW):
    q = (select(PurchaseOrder.order_date, PurchaseOrder.number, PurchaseOrderLine.product_id,
                PurchaseOrderLine.description, PurchaseOrderLine.unit, PurchaseOrderLine.unit_cost,
                (PurchaseOrderLine.unit_cost * PurchaseOrderLine.quantity / PurchaseOrderLine.base_quantity)
                .label("base_unit_cost"))
         .join(PurchaseOrder).where(PurchaseOrder.supplier_id == supplier_id, PurchaseOrder.status != "cancelled")
         .order_by(PurchaseOrder.order_date.desc(), PurchaseOrderLine.id.desc()))
    if product_id:
        q = q.where(PurchaseOrderLine.product_id == product_id)
    return [dict(r._mapping) for r in db.execute(q.limit(500))]


@sup_router.get("/purchasing/price-changes")
def price_changes(db: DB, days: int = 90, min_change_pct: Decimal = Decimal(0), _: User = P_VIEW):
    """Latest vs previous purchase price per supplier+product, where it changed in the last `days` days."""
    base_cost = PurchaseOrderLine.unit_cost * PurchaseOrderLine.quantity / PurchaseOrderLine.base_quantity
    rows = db.execute(select(PurchaseOrder.supplier_id, PurchaseOrderLine.product_id, PurchaseOrder.order_date,
                             base_cost.label("cost"))
                      .join(PurchaseOrder).where(PurchaseOrder.status != "cancelled")
                      .order_by(PurchaseOrder.supplier_id, PurchaseOrderLine.product_id, PurchaseOrder.order_date.desc(),
                                PurchaseOrderLine.id.desc())).all()
    since = local_today() - timedelta(days=days)
    seen: dict[tuple, list] = defaultdict(list)
    for r in rows:
        k = (r.supplier_id, r.product_id)
        if len(seen[k]) < 2:
            seen[k].append(r)
    out = []
    for (sid, pid), pair in seen.items():
        if len(pair) == 2 and pair[0].order_date >= since and pair[0].cost != pair[1].cost:
            pct = ((pair[0].cost - pair[1].cost) / pair[1].cost * 100).quantize(Decimal("0.1")) if pair[1].cost else None
            if pct is None or abs(pct) >= min_change_pct:
                out.append({"supplier_id": sid, "product_id": pid, "date": pair[0].order_date,
                            "previous_cost": pair[1].cost.quantize(Decimal("0.0001")),
                            "latest_cost": pair[0].cost.quantize(Decimal("0.0001")), "change_pct": pct})
    return sorted(out, key=lambda x: -abs(x["change_pct"] or 0))


@sup_router.get("/suppliers/{supplier_id}/performance")
def performance(supplier_id: int, db: DB, _: User = P_VIEW):
    get_or_404(db, Supplier, supplier_id, "Supplier")
    pos = db.scalars(select(PurchaseOrder).where(PurchaseOrder.supplier_id == supplier_id,
                                                 PurchaseOrder.status.in_(("partially_received", "received")))).all()
    on_time = lead = n = 0
    for po in pos:
        first = db.scalar(select(func.min(GoodsReceipt.received_date)).where(GoodsReceipt.purchase_order_id == po.id))
        if first is None:
            continue
        n += 1
        lead += (first - po.order_date).days
        on_time += 1 if po.expected_date is None or first <= po.expected_date else 0
    qc = dict(db.execute(select(GoodsReceiptLine.qc_result, func.count()).join(GoodsReceipt)
                         .where(GoodsReceipt.supplier_id == supplier_id).group_by(GoodsReceiptLine.qc_result)).all())
    checked = qc.get("pass", 0) + qc.get("fail", 0)
    ratings = db.execute(select(func.avg(SupplierRating.price), func.avg(SupplierRating.quality),
                                func.avg(SupplierRating.delivery), func.avg(SupplierRating.reliability))
                         .where(SupplierRating.supplier_id == supplier_id)).one()
    spent = db.scalar(select(func.coalesce(func.sum(SupplierBill.grand_total), 0)).where(
        SupplierBill.supplier_id == supplier_id, SupplierBill.status != "cancelled"))
    r1 = (lambda v: round(Decimal(v), 1) if v is not None else None)
    return {"orders_received": n, "on_time_pct": round(Decimal(on_time) / n * 100, 1) if n else None,
            "average_lead_time_days": round(Decimal(lead) / n, 1) if n else None,
            "qc_pass_pct": round(Decimal(qc.get("pass", 0)) / checked * 100, 1) if checked else None,
            "ratings": {"price": r1(ratings[0]), "quality": r1(ratings[1]), "delivery": r1(ratings[2]),
                        "reliability": r1(ratings[3])},
            "total_billed": spent}


class RatingIn(BaseModel):
    price: int = Field(ge=1, le=5)
    quality: int = Field(ge=1, le=5)
    delivery: int = Field(ge=1, le=5)
    reliability: int = Field(ge=1, le=5)
    note: str | None = None


@sup_router.post("/suppliers/{supplier_id}/ratings", status_code=201)
def rate_supplier(supplier_id: int, body: RatingIn, db: DB, _: User = P_EDIT):
    get_or_404(db, Supplier, supplier_id, "Supplier")
    r = SupplierRating(supplier_id=supplier_id, rated_on=local_today(), **body.model_dump())
    db.add(r)
    audit(db, "create", r)
    return {"id": r.id}


@sup_router.get("/suppliers/{supplier_id}/ratings")
def list_ratings(supplier_id: int, db: DB, _: User = P_VIEW):
    return [{k: getattr(r, k) for k in ("id", "rated_on", "price", "quality", "delivery", "reliability", "note",
                                        "created_by_id")}
            for r in db.scalars(select(SupplierRating).where(SupplierRating.supplier_id == supplier_id)
                                .order_by(SupplierRating.id.desc()))]


@sup_router.get("/suppliers/{supplier_id}/payments", response_model=list[SupplierPaymentOut])
def supplier_payments(supplier_id: int, db: DB, _: User = B_VIEW):
    return db.scalars(select(SupplierPayment).where(SupplierPayment.supplier_id == supplier_id)
                      .order_by(SupplierPayment.id.desc())).all()


routers = [pr_router, po_router, gr_router, bill_router, sup_router]
