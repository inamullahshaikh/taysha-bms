"""Accounts receivable / payable: aging, customer statements, on-account payments and allocation."""

from datetime import date
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import audit
from app.auth.access import require_access
from app.auth.models import User
from app.clock import local_today
from app.company import get_company
from app.crud import get_or_404
from app.customers import Customer
from app.db import DB
from app.documents.models import SalesDocument
from app.documents.service import refresh_invoice
from app.errors import AppError
from app.listing import export_response
from app.mailer import send_email
from app.numbering import next_number
from app.orders.models import Order, Payment
from app.orders.router import PaymentIn, PaymentOut
from app.orders.service import refresh_payment_status
from app.pdf import pdf_response, render_pdf
from app.purchasing.models import SupplierBill
from app.suppliers import Supplier

ZERO = Decimal(0)
BUCKETS = ("current", "1_30", "31_60", "61_90", "over_90")
OPEN_INV = ("issued", "partially_paid", "overdue")


def bucket(due: date | None, as_of: date) -> str:
    days = (as_of - due).days if due else 0
    if days <= 0:
        return "current"
    return "1_30" if days <= 30 else "31_60" if days <= 60 else "61_90" if days <= 90 else "over_90"


def aging(rows: list[tuple[int, str, date | None, Decimal]], as_of: date) -> dict:
    """rows: (party_id, party_name, due_date, balance)"""
    parties: dict[int, dict] = {}
    totals = {b: ZERO for b in BUCKETS}
    for pid, name, due, bal in rows:
        if bal <= 0:
            continue
        p = parties.setdefault(pid, {"id": pid, "name": name, **{b: ZERO for b in BUCKETS}, "total": ZERO})
        b = bucket(due, as_of)
        p[b] += bal
        p["total"] += bal
        totals[b] += bal
    return {"as_of": as_of, "rows": sorted(parties.values(), key=lambda r: -r["total"]),
            "totals": {**totals, "total": sum(totals.values(), ZERO)}}


router = APIRouter(tags=["receivables"])


@router.get("/reports/receivables-aging")
def receivables_aging(db: DB, as_of: date | None = None, format: Literal["json", "csv", "xlsx"] = "json",
                      _: User = require_access("invoices", "view")):
    as_of = as_of or local_today()
    rows = [(d.customer_id or 0, d.customer_name or "Walk-in", d.due_date, d.balance_due)
            for d in db.scalars(select(SalesDocument).where(SalesDocument.doc_type == "invoice",
                                                            SalesDocument.status.in_(OPEN_INV)))]
    rows += [(d.customer_id or 0, d.customer_name or "Walk-in", d.due_date, d.grand_total)
             for d in db.scalars(select(SalesDocument).where(SalesDocument.doc_type == "debit_note",
                                                             SalesDocument.status == "issued"))]
    out = aging(rows, as_of)
    if format == "json":
        return out
    cols = [("name", "Customer"), *[(b, b.replace("_", "-").title()) for b in BUCKETS], ("total", "Total")]
    return export_response(db, out["rows"], cols, format, "receivables-aging", "sales_documents")


@router.get("/reports/payables-aging")
def payables_aging(db: DB, as_of: date | None = None, format: Literal["json", "csv", "xlsx"] = "json",
                   _: User = require_access("supplier_bills", "view")):
    as_of = as_of or local_today()
    names = {s.id: s.name for s in db.scalars(select(Supplier))}
    rows = [(b.supplier_id, names.get(b.supplier_id, ""), b.due_date, b.balance_due)
            for b in db.scalars(select(SupplierBill).where(SupplierBill.status.in_(("unpaid", "partially_paid",
                                                                                     "overdue"))))]
    out = aging(rows, as_of)
    if format == "json":
        return out
    cols = [("name", "Supplier"), *[(b, b.replace("_", "-").title()) for b in BUCKETS], ("total", "Total")]
    return export_response(db, out["rows"], cols, format, "payables-aging", "supplier_bills")


# ---------- customer statement ----------

def statement(db: Session, customer_id: int, start: date, end: date) -> dict:
    """Everything that moved the customer's balance, with a running balance. Positive = they owe us."""
    events: list[dict] = []
    for d in db.scalars(select(SalesDocument).where(
            SalesDocument.customer_id == customer_id, SalesDocument.status.not_in(("draft", "cancelled")),
            SalesDocument.doc_type.in_(("invoice", "debit_note", "credit_note")))):
        sign = -1 if d.doc_type == "credit_note" else 1
        events.append({"date": d.doc_date, "type": d.doc_type, "reference": d.number, "amount": sign * d.grand_total,
                       "due_date": d.due_date})
    invoiced_orders = {d.order_id for d in db.scalars(select(SalesDocument).where(
        SalesDocument.customer_id == customer_id, SalesDocument.doc_type == "invoice",
        SalesDocument.status.not_in(("draft", "cancelled"))))}
    for p in db.scalars(select(Payment).where(Payment.customer_id == customer_id, Payment.status == "completed")):
        # payments on orders that were never invoiced settle the order itself, not the account
        if p.invoice_id is None and p.order_id and p.order_id not in invoiced_orders:
            continue
        sign = 1 if p.kind == "refund" else -1
        events.append({"date": p.payment_date, "type": p.kind, "reference": p.number, "amount": sign * p.amount,
                       "due_date": None, "method": p.method})
    events.sort(key=lambda e: (e["date"], e["type"] != "invoice"))
    opening = sum((e["amount"] for e in events if e["date"] < start), ZERO)
    running, lines = opening, []
    for e in events:
        if start <= e["date"] <= end:
            running += e["amount"]
            lines.append({**e, "balance": running})
    return {"from": start, "to": end, "opening_balance": opening, "lines": lines, "closing_balance": running}


@router.get("/customers/{customer_id}/statement")
def customer_statement(customer_id: int, db: DB, date_from: date | None = None, date_to: date | None = None,
                       format: Literal["json", "pdf"] = "json", _: User = require_access("invoices", "view")):
    c = get_or_404(db, Customer, customer_id, "Customer")
    end = date_to or local_today()
    start = date_from or end.replace(month=1, day=1)
    st = statement(db, c.id, start, end)
    if format == "json":
        return st
    return pdf_response(render_pdf(db, "statement.html", customer=c, st=st), f"statement-{c.id}-{end}.pdf")


class StatementEmailIn(BaseModel):
    to: EmailStr | None = None
    date_from: date | None = None
    date_to: date | None = None


@router.post("/customers/{customer_id}/statement/email", status_code=204)
def email_statement(customer_id: int, body: StatementEmailIn, db: DB, _: User = require_access("invoices", "edit")):
    c = get_or_404(db, Customer, customer_id, "Customer")
    to = body.to or c.email
    if not to:
        raise AppError(422, "no_email", "No email address for this customer", {"to": "required"})
    end = body.date_to or local_today()
    st = statement(db, c.id, body.date_from or end.replace(month=1, day=1), end)
    company = get_company(db).name
    send_email(to, f"Account statement from {company}",
               f"Dear {c.name},\n\nPlease find your account statement attached. Balance: Rs {st['closing_balance']:,.2f}"
               f"\n\nRegards,\n{company}",
               [(render_pdf(db, "statement.html", customer=c, st=st), f"statement-{end}.pdf")])
    audit(db, "email", entity_type="customers", entity_id=c.id, note=f"statement sent to {to}")


# ---------- on-account payments & allocation ----------

@router.post("/customers/{customer_id}/payments", response_model=PaymentOut, status_code=201)
def on_account_payment(customer_id: int, body: PaymentIn, db: DB,
                       _: User = require_access("order_payments", "create")):
    """Money received that isn't for a single order (e.g. a wholesale customer paying several invoices)."""
    get_or_404(db, Customer, customer_id, "Customer")
    if body.kind != "payment":
        raise AppError(422, "payments_only", "Refunds are recorded on the order or invoice")
    pay = Payment(number=next_number(db, "payment"), customer_id=customer_id,
                  payment_date=body.payment_date or local_today(), **body.model_dump(exclude={"payment_date"}))
    db.add(pay)
    audit(db, "create", pay)
    return pay


class AllocateIn(BaseModel):
    invoice_id: int


@router.post("/payments/{payment_id}/allocate", response_model=PaymentOut)
def allocate(payment_id: int, body: AllocateIn, db: DB, _: User = require_access("order_payments", "create")):
    """Apply an unallocated payment to an invoice of the same customer."""
    pay = get_or_404(db, Payment, payment_id, "Payment")
    inv = get_or_404(db, SalesDocument, body.invoice_id, "Invoice")
    if pay.invoice_id or pay.order_id:
        raise AppError(409, "already_allocated", "This payment is already applied")
    if inv.doc_type != "invoice" or inv.status not in OPEN_INV or inv.customer_id != pay.customer_id:
        raise AppError(422, "invalid_invoice", "Pick an open invoice of the same customer")
    if pay.amount > inv.balance_due:
        raise AppError(422, "overpayment", f"Only {inv.balance_due} is due on {inv.number}")
    pay.invoice_id, pay.order_id = inv.id, inv.order_id
    audit(db, "allocate", entity_type="payments", entity_id=pay.id, after={"invoice": inv.number})
    if inv.order_id:
        refresh_payment_status(db, db.get(Order, inv.order_id))
    else:
        refresh_invoice(db, inv)
    return pay


@router.get("/customers/{customer_id}/unallocated-payments", response_model=list[PaymentOut])
def unallocated(customer_id: int, db: DB, _: User = require_access("order_payments", "view")):
    return db.scalars(select(Payment).where(Payment.customer_id == customer_id, Payment.invoice_id.is_(None),
                                            Payment.order_id.is_(None), Payment.kind == "payment",
                                            Payment.status == "completed")).all()


routers = [router]
