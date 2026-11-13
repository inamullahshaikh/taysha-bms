from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import audit, snapshot
from app.auth.access import require_access
from app.auth.models import User
from app.clock import local_today, utcnow
from app.crud import RecordOut, get_or_404
from app.customers import Customer
from app.db import DB
from app.documents.models import SalesDocument, SalesDocumentLine
from app.documents.service import (
    OPEN_INVOICE, copy_from_order, issue, payments_for, price_lines, refresh_invoice, write_document,
)
from app.errors import AppError
from app.listing import ListParams, Page, apply_filters, export_response, paginate
from app.mailer import send_email
from app.numbering import next_number
from app.company import get_company
from app.orders.calc import LineCalc, calculate
from app.orders.models import Order, OrderLine, OrderStatusHistory, Payment
from app.orders.router import AddressIn, PaymentIn, PaymentOut
from app.orders.service import refresh_payment_status
from app.pdf import pdf_response, render_pdf

router = APIRouter(prefix="/documents", tags=["documents"])
VIEW, CREATE, EDIT, EXPORT = (require_access("invoices", a) for a in ("view", "create", "edit", "export"))
PAY_CREATE = require_access("order_payments", "create")
ZERO = Decimal(0)

DocType = Literal["invoice", "quotation", "proforma", "receipt", "credit_note", "debit_note", "delivery_challan"]
CreatableType = Literal["invoice", "quotation", "proforma", "debit_note", "delivery_challan"]
TITLES = {"invoice": "SALES TAX INVOICE", "quotation": "QUOTATION", "proforma": "PRO-FORMA INVOICE",
          "receipt": "RECEIPT", "credit_note": "CREDIT NOTE", "debit_note": "DEBIT NOTE",
          "delivery_challan": "DELIVERY CHALLAN"}


# ---------- schemas ----------

class DocLineIn(BaseModel):
    product_id: int | None = None
    description: str | None = None
    quantity: Decimal = Field(gt=0)
    unit_price: Decimal | None = Field(None, ge=0)
    tax_rate: Decimal | None = Field(None, ge=0, le=100)
    discount_pct: Decimal = Field(ZERO, ge=0, le=100)
    discount_amount: Decimal = Field(ZERO, ge=0)


class ChargeIn(BaseModel):
    label: str = Field(min_length=1)
    amount: Decimal = Field(ge=0)


class DocIn(BaseModel):
    doc_type: CreatableType = "invoice"
    customer_id: int | None = None
    customer_name: str | None = None
    customer_phone: str | None = None
    customer_email: EmailStr | None = None
    customer_ntn: str | None = None
    customer_strn: str | None = None
    doc_date: date | None = None
    due_date: date | None = None
    valid_until: date | None = None
    billing_address: AddressIn | None = None
    shipping_address: AddressIn | None = None
    order_discount_pct: Decimal = Field(ZERO, ge=0, le=100)
    order_discount_amount: Decimal = Field(ZERO, ge=0)
    delivery_charge: Decimal = Field(ZERO, ge=0)
    other_charges: list[ChargeIn] = []
    notes: str | None = None
    terms: str | None = None
    related_document_id: int | None = None
    lines: list[DocLineIn] = Field(min_length=1)

    @field_validator("billing_address", "shipping_address", mode="after")
    @classmethod
    def _as_dict(cls, v):
        return v.model_dump() if v else None


class DocLineOut(BaseModel):
    model_config = {"from_attributes": True}
    id: int
    line_no: int
    product_id: int | None
    sku: str | None
    description: str
    quantity: Decimal
    unit_price: Decimal
    discount_pct: Decimal
    discount_amount: Decimal
    line_discount: Decimal
    order_discount_share: Decimal
    tax_rate: Decimal
    tax_amount: Decimal
    net_amount: Decimal
    line_total: Decimal


class DocSummary(RecordOut):
    doc_type: str
    number: str | None
    status: str
    doc_date: date
    due_date: date | None
    order_id: int | None
    related_document_id: int | None
    customer_id: int | None
    customer_name: str | None
    grand_total: Decimal
    paid_total: Decimal
    credited_total: Decimal
    balance_due: Decimal
    issued_at: datetime | None
    created_at: datetime


class DocOut(DocSummary):
    valid_until: date | None
    payment_id: int | None
    customer_phone: str | None
    customer_email: str | None
    customer_ntn: str | None
    customer_strn: str | None
    billing_address: dict | None
    shipping_address: dict | None
    order_discount_pct: Decimal
    order_discount_amount: Decimal
    delivery_charge: Decimal
    other_charges: list
    subtotal: Decimal
    discount_total: Decimal
    tax_total: Decimal
    net_total: Decimal
    charges_total: Decimal
    rounding: Decimal
    notes: str | None
    terms: str | None
    cancelled_reason: str | None
    lines: list[DocLineOut] = []


class ReasonIn(BaseModel):
    reason: str = Field(min_length=1)


class FromOrderIn(BaseModel):
    doc_type: Literal["invoice", "proforma", "delivery_challan"] = "invoice"


class CreditLineIn(BaseModel):
    line_id: int
    quantity: Decimal = Field(gt=0)


class CreditNoteIn(BaseModel):
    reason: str = Field(min_length=1)
    lines: list[CreditLineIn] | None = None  # None = credit everything still creditable


class EmailIn(BaseModel):
    to: EmailStr | None = None
    subject: str | None = None
    message: str | None = None


class QuoteStatusIn(BaseModel):
    status: Literal["accepted", "rejected", "expired"]


# ---------- helpers ----------

def get_doc(db: Session, doc_id: int) -> SalesDocument:
    return get_or_404(db, SalesDocument, doc_id, "Document")


def doc_lines(db: Session, doc_id: int) -> list[SalesDocumentLine]:
    return db.scalars(select(SalesDocumentLine).where(SalesDocumentLine.document_id == doc_id)
                      .order_by(SalesDocumentLine.line_no)).all()


def doc_out(db: Session, d: SalesDocument) -> DocOut:
    out = DocOut.model_validate(d)
    out.lines = [DocLineOut.model_validate(x) for x in doc_lines(db, d.id)]
    return out


def ensure_draft(d: SalesDocument) -> None:
    if d.status != "draft":
        raise AppError(409, "not_draft", "Issued documents can't be edited; use a credit or debit note")


def known_prices(db: Session, d: SalesDocument | None) -> dict:
    if d is None:
        return {}
    out = {ln.product_id: ln.unit_price for ln in doc_lines(db, d.id) if ln.product_id}
    out["__order_discount__"] = (d.order_discount_pct, d.order_discount_amount)
    return out


# ---------- list ----------

SEARCH = (SalesDocument.number, SalesDocument.customer_name, SalesDocument.customer_phone)
SORTS = {"doc_date": SalesDocument.doc_date, "number": SalesDocument.number, "grand_total": SalesDocument.grand_total,
         "due_date": SalesDocument.due_date}


class DocFilters:
    def __init__(self, doc_type: DocType | None = None, status: str | None = None, customer_id: int | None = None,
                 order_id: int | None = None, date_from: date | None = None, date_to: date | None = None,
                 unpaid: bool = False):
        self.doc_type, self.status, self.customer_id, self.order_id = doc_type, status, customer_id, order_id
        self.date_from, self.date_to, self.unpaid = date_from, date_to, unpaid

    def apply(self, q):
        for f in ("doc_type", "status", "customer_id", "order_id"):
            if getattr(self, f) is not None:
                q = q.where(getattr(SalesDocument, f) == getattr(self, f))
        if self.date_from:
            q = q.where(SalesDocument.doc_date >= self.date_from)
        if self.date_to:
            q = q.where(SalesDocument.doc_date <= self.date_to)
        if self.unpaid:
            q = q.where(SalesDocument.status.in_(("issued", "partially_paid", "overdue")))
        return q


def list_query(p: ListParams, f: DocFilters):
    return f.apply(apply_filters(select(SalesDocument), SalesDocument, p, SEARCH, SORTS, SalesDocument.id.desc()))


@router.get("", response_model=Page[DocSummary])
def list_documents(db: DB, p: Annotated[ListParams, Depends()], f: Annotated[DocFilters, Depends()],
                   _: User = VIEW):
    return paginate(db, list_query(p, f), p, DocSummary)


@router.get("/export")
def export_documents(db: DB, p: Annotated[ListParams, Depends()], f: Annotated[DocFilters, Depends()],
                     format: str = "csv", _: User = EXPORT):
    rows = [DocSummary.model_validate(d).model_dump() for d in db.scalars(list_query(p, f))]
    cols = [("doc_type", "Type"), ("number", "Number"), ("status", "Status"), ("doc_date", "Date"),
            ("due_date", "Due"), ("customer_name", "Customer"), ("grand_total", "Total"), ("paid_total", "Paid"),
            ("credited_total", "Credited"), ("balance_due", "Balance")]
    return export_response(db, rows, cols, format, "documents", "sales_documents")


# ---------- create / edit ----------

@router.post("", response_model=DocOut, status_code=201)
def create_document(body: DocIn, db: DB, user: User = CREATE):
    customer = get_or_404(db, Customer, body.customer_id, "Customer") if body.customer_id else None
    if body.doc_type == "debit_note":
        inv = get_or_404(db, SalesDocument, body.related_document_id or 0, "Invoice")
        if inv.doc_type != "invoice" or inv.status not in OPEN_INVOICE:
            raise AppError(422, "invalid_invoice", "A debit note must reference an issued invoice")
    infos, totals = price_lines(db, user, body, customer, {})
    d = SalesDocument(doc_type=body.doc_type, status="draft", doc_date=body.doc_date or local_today(),
                      related_document_id=body.related_document_id)
    db.add(d)
    db.flush()
    write_document(db, d, body, customer, infos, totals)
    audit(db, "create", d)
    return doc_out(db, d)


@router.get("/{doc_id}", response_model=DocOut)
def read_document(doc_id: int, db: DB, _: User = VIEW):
    return doc_out(db, get_doc(db, doc_id))


@router.put("/{doc_id}", response_model=DocOut)
def update_document(doc_id: int, body: DocIn, db: DB, user: User = EDIT):
    d = get_doc(db, doc_id)
    ensure_draft(d)
    if body.doc_type != d.doc_type and d.doc_type in ("credit_note", "receipt"):
        raise AppError(422, "type_locked", "This document's type can't change")
    body.doc_type = d.doc_type
    customer = get_or_404(db, Customer, body.customer_id, "Customer") if body.customer_id else None
    before = snapshot(d)
    infos, totals = price_lines(db, user, body, customer, known_prices(db, d))
    write_document(db, d, body, customer, infos, totals)
    audit(db, "update", d, before=before)
    return doc_out(db, d)


@router.post("/{doc_id}/issue", response_model=DocOut)
def issue_document(doc_id: int, db: DB, _: User = EDIT):
    d = get_doc(db, doc_id)
    issue(db, d)
    return doc_out(db, d)


@router.post("/{doc_id}/cancel", response_model=DocOut)
def cancel_document(doc_id: int, body: ReasonIn, db: DB, _: User = EDIT):
    d = get_doc(db, doc_id)
    if d.status == "cancelled":
        raise AppError(409, "already_cancelled", "Already cancelled")
    if d.doc_type == "invoice" and d.status != "draft" and (d.paid_total or d.credited_total):
        raise AppError(409, "has_payments", "This invoice has payments or credits; issue a credit note instead")
    if d.doc_type == "credit_note" and d.status == "issued":
        raise AppError(409, "issued_credit", "An issued credit note can't be cancelled; issue a debit note")
    if d.doc_type == "quotation":
        raise AppError(409, "not_cancellable", "Quotations are rejected or expired, not cancelled")
    d.status, d.cancelled_reason = "cancelled", body.reason
    audit(db, "cancel", entity_type="sales_documents", entity_id=d.id, note=body.reason)
    return doc_out(db, d)


@router.post("/{doc_id}/quote-status", response_model=DocOut)
def quote_status(doc_id: int, body: QuoteStatusIn, db: DB, _: User = EDIT):
    d = get_doc(db, doc_id)
    if d.doc_type != "quotation" or d.status not in ("issued", "accepted"):
        raise AppError(409, "invalid_status", "Only sent quotations can be accepted, rejected or expired")
    before = d.status
    d.status = body.status
    audit(db, "status", entity_type="sales_documents", entity_id=d.id, before={"status": before},
          after={"status": d.status})
    return doc_out(db, d)


@router.post("/{doc_id}/convert-to-order")
def convert_quote(doc_id: int, db: DB, user: User = require_access("orders", "create")):
    """Accepted quotation -> draft order with the quoted prices."""
    d = get_doc(db, doc_id)
    if d.doc_type != "quotation" or d.status not in ("issued", "accepted"):
        raise AppError(409, "invalid_status", "Only sent or accepted quotations can be converted")
    lines = doc_lines(db, d.id)
    if any(ln.product_id is None for ln in lines):
        raise AppError(422, "free_text_lines", "Quotations with free-text lines can't become orders")
    o = Order(number=next_number(db, "order"), order_date=local_today(), status="draft", source="quotation",
              external_id=d.number, customer_id=d.customer_id, customer_name=d.customer_name,
              customer_phone=d.customer_phone, shipping_address=d.shipping_address, billing_address=d.billing_address,
              order_discount_pct=d.order_discount_pct, order_discount_amount=d.order_discount_amount,
              delivery_charge=d.charges_total, subtotal=d.subtotal, discount_total=d.discount_total,
              tax_total=d.tax_total, net_total=d.net_total, rounding=d.rounding, grand_total=d.grand_total,
              notes=d.notes)
    db.add(o)
    db.flush()
    for ln in lines:
        db.add(OrderLine(order_id=o.id, line_no=ln.line_no, product_id=ln.product_id, sku=ln.sku,
                         description=ln.description, quantity=ln.quantity, unit_price=ln.unit_price,
                         list_price=None, price_overridden=False, discount_pct=ln.discount_pct,
                         discount_amount=ln.discount_amount, line_discount=ln.line_discount,
                         order_discount_share=ln.order_discount_share, tax_rate=ln.tax_rate,
                         tax_amount=ln.tax_amount, net_amount=ln.net_amount, line_total=ln.line_total))
    db.add(OrderStatusHistory(order_id=o.id, to_status="draft", user_id=user.id, note=f"From quotation {d.number}"))
    d.status = "converted"
    audit(db, "create", o, note=f"from quotation {d.number}")
    return {"order_id": o.id, "order_number": o.number}


@router.post("/{doc_id}/credit-note", response_model=DocOut, status_code=201)
def create_credit_note(doc_id: int, body: CreditNoteIn, db: DB, _: User = CREATE):
    """Draft credit note against an issued invoice.

    No lines given: credits the whole invoice (lines, delivery, rounding), only if nothing was credited yet.
    Lines given: credits those quantities at the price actually charged per unit (after discounts).
    """
    inv = get_doc(db, doc_id)
    if inv.doc_type != "invoice" or inv.status not in OPEN_INVOICE:
        raise AppError(422, "invalid_invoice", "Credit notes are made against issued invoices")
    inv_lines = {ln.id: ln for ln in doc_lines(db, inv.id)}
    full = body.lines is None
    if full and inv.credited_total:
        raise AppError(422, "partly_credited", "Part of this invoice is already credited; choose the lines to credit")
    picks = [CreditLineIn(line_id=i, quantity=ln.quantity) for i, ln in inv_lines.items()] if full else body.lines
    calcs, src = [], []
    for pk in picks:
        ln = inv_lines.get(pk.line_id)
        if ln is None or pk.quantity > ln.quantity:
            raise AppError(422, "invalid_credit_line", "Credit lines must match the invoice and not exceed its quantities")
        calcs.append(LineCalc(quantity=pk.quantity, unit_price=ln.line_total / ln.quantity, tax_rate=ln.tax_rate))
        src.append(ln)
    t = calculate(calcs, round_to_rupee=False)
    charges = inv.charges_total if full else ZERO
    grand = inv.grand_total if full else t.grand_total
    cn = SalesDocument(doc_type="credit_note", status="draft", doc_date=local_today(), related_document_id=inv.id,
                       order_id=inv.order_id, customer_id=inv.customer_id, customer_name=inv.customer_name,
                       customer_phone=inv.customer_phone, customer_email=inv.customer_email,
                       customer_ntn=inv.customer_ntn, customer_strn=inv.customer_strn,
                       billing_address=inv.billing_address, notes=body.reason, subtotal=t.subtotal,
                       tax_total=inv.tax_total if full else t.tax_total,
                       net_total=inv.net_total if full else t.net_total, charges_total=charges,
                       rounding=grand - t.subtotal - charges, grand_total=grand)
    db.add(cn)
    db.flush()
    for i, (ln, lc) in enumerate(zip(src, t.lines), start=1):
        db.add(SalesDocumentLine(document_id=cn.id, line_no=i, product_id=ln.product_id, sku=ln.sku,
                                 description=ln.description, quantity=lc.quantity, unit_price=lc.unit_price,
                                 tax_rate=lc.tax_rate, tax_amount=lc.tax, net_amount=lc.net, line_total=lc.total))
    audit(db, "create", cn, note=f"credit note for {inv.number}: {body.reason}")
    db.flush()
    return doc_out(db, cn)


# ---------- payments on invoices ----------

@router.get("/{doc_id}/payments", response_model=list[PaymentOut])
def invoice_payments(doc_id: int, db: DB, _: User = VIEW):
    inv = get_doc(db, doc_id)
    return db.scalars(select(Payment).where(payments_for(inv)).order_by(Payment.id)).all()


@router.post("/{doc_id}/payments", response_model=PaymentOut, status_code=201)
def pay_invoice(doc_id: int, body: PaymentIn, db: DB, _: User = PAY_CREATE):
    inv = get_doc(db, doc_id)
    if inv.doc_type != "invoice" or inv.status in ("draft", "cancelled"):
        raise AppError(409, "not_payable", "Payments are recorded against issued invoices")
    if body.status == "completed":
        if body.kind == "payment" and body.amount > inv.balance_due:
            raise AppError(422, "overpayment", f"Only {inv.balance_due} is due", {"amount": f"max {inv.balance_due}"})
        if body.kind == "refund" and body.amount > inv.paid_total:
            raise AppError(422, "over_refund", f"Only {inv.paid_total} has been paid")
    pay = Payment(number=next_number(db, "payment"), customer_id=inv.customer_id, order_id=inv.order_id,
                  invoice_id=inv.id, payment_date=body.payment_date or local_today(),
                  **body.model_dump(exclude={"payment_date"}))
    db.add(pay)
    audit(db, "create", pay)
    if inv.order_id:
        refresh_payment_status(db, db.get(Order, inv.order_id))  # also refreshes the invoice
    else:
        refresh_invoice(db, inv)
    return pay


# ---------- PDF & email ----------

def render_doc(db: Session, d: SalesDocument) -> bytes:
    related = db.get(SalesDocument, d.related_document_id) if d.related_document_id else None
    payment = db.get(Payment, d.payment_id) if d.payment_id else None
    return render_pdf(db, "document.html", d=d, lines=doc_lines(db, d.id), title=TITLES[d.doc_type],
                      related=related, payment=payment)


def filename(d: SalesDocument) -> str:
    return f"{d.number or f'draft-{d.doc_type}-{d.id}'}.pdf"


@router.get("/{doc_id}/pdf")
def document_pdf(doc_id: int, db: DB, _: User = VIEW):
    d = get_doc(db, doc_id)
    return pdf_response(render_doc(db, d), filename(d))


@router.post("/{doc_id}/email", status_code=204)
def email_document(doc_id: int, body: EmailIn, db: DB, _: User = EDIT):
    d = get_doc(db, doc_id)
    if d.status == "draft":
        raise AppError(409, "not_issued", "Issue the document before sending it")
    to = body.to or d.customer_email
    if not to:
        raise AppError(422, "no_email", "No email address for this customer", {"to": "required"})
    title = TITLES[d.doc_type].title()
    company = get_company(db).name
    send_email(to, body.subject or f"{title} {d.number} from {company}",
               body.message or f"Dear {d.customer_name or 'customer'},\n\nPlease find attached {title.lower()} "
                                f"{d.number}.\n\nRegards,\n{company}",
               [(render_doc(db, d), filename(d))])
    audit(db, "email", entity_type="sales_documents", entity_id=d.id, note=f"sent to {to}")


# ---------- from orders / payments ----------

orders_router = APIRouter(prefix="/orders", tags=["orders"])


@orders_router.post("/{order_id}/documents", response_model=DocOut, status_code=201)
def document_from_order(order_id: int, body: FromOrderIn, db: DB, _: User = CREATE):
    o = get_or_404(db, Order, order_id, "Order")
    if o.status in ("draft", "cancelled"):
        raise AppError(409, "order_not_confirmed", "Confirm the order first")
    if body.doc_type == "invoice":
        existing = db.scalar(select(SalesDocument).where(
            SalesDocument.order_id == o.id, SalesDocument.doc_type == "invoice",
            SalesDocument.status != "cancelled"))
        if existing:
            raise AppError(409, "order_already_invoiced",
                           f"This order already has invoice {existing.number or '(draft)'}",
                           {"document_id": str(existing.id)})
    d = SalesDocument(doc_type=body.doc_type, status="draft", doc_date=local_today())
    db.add(d)
    db.flush()
    copy_from_order(db, d, o)
    if body.doc_type == "invoice":
        refresh_invoice(db, d)
    audit(db, "create", d, note=f"from order {o.number}")
    return doc_out(db, d)


payments_router = APIRouter(prefix="/payments", tags=["payments"])


@payments_router.post("/{payment_id}/receipt", response_model=DocOut)
def payment_receipt(payment_id: int, db: DB, _: User = require_access("order_payments", "view")):
    """Receipt for a payment (created once, then reused)."""
    pay = get_or_404(db, Payment, payment_id, "Payment")
    if pay.kind != "payment" or pay.status != "completed":
        raise AppError(422, "not_receivable", "Receipts are for completed payments")
    d = db.scalar(select(SalesDocument).where(SalesDocument.payment_id == pay.id))
    if d is None:
        c = db.get(Customer, pay.customer_id) if pay.customer_id else None
        o = db.get(Order, pay.order_id) if pay.order_id else None
        d = SalesDocument(doc_type="receipt", status="draft", doc_date=pay.payment_date, payment_id=pay.id,
                          order_id=pay.order_id, related_document_id=pay.invoice_id,
                          customer_id=pay.customer_id,
                          customer_name=(c.company_name or c.name) if c else (o.customer_name if o else None),
                          customer_phone=c.phone if c else None, customer_email=c.email if c else None,
                          subtotal=pay.amount, grand_total=pay.amount, paid_total=pay.amount)
        db.add(d)
        db.flush()
        d.number, d.status, d.issued_at = next_number(db, "receipt"), "issued", utcnow()
        audit(db, "issue", entity_type="sales_documents", entity_id=d.id, after={"number": d.number})
    return doc_out(db, d)


routers = [router, orders_router, payments_router]
