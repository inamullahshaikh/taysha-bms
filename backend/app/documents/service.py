"""Sales document logic: pricing lines, issuing, invoice payment status, credit notes."""

from datetime import timedelta
from decimal import Decimal

from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from app.audit import audit
from app.auth.access import can
from app.auth.models import User
from app.clock import local_today, utcnow
from app.company import get_company
from app.customers import Customer
from app.documents.models import SalesDocument, SalesDocumentLine
from app.errors import AppError, not_found
from app.numbering import next_number
from app.orders.calc import LineCalc, calculate
from app.orders.models import Order, OrderLine, Payment
from app.orders.service import address_snapshot, pick_price_list
from app.products.models import Product
from app.products.pricing import money, resolve_price, tax_rate_of

ZERO = Decimal(0)
OPEN_INVOICE = ("issued", "partially_paid", "overdue", "paid", "credited")


def price_lines(db: Session, user: User, body, customer: Customer | None, known_prices: dict[int, Decimal]):
    """-> (line infos, Totals). known_prices: product_id -> already-agreed unit price (from the order or the
    document being edited); keeping it doesn't count as a price change."""
    pl = pick_price_list(db, "retail", customer, None)
    on = body.doc_date or local_today()
    may_override = can(db, user, "order_pricing", "edit")
    infos, calcs = [], []
    for i, ln in enumerate(body.lines):
        p = db.get(Product, ln.product_id) if ln.product_id else None
        if ln.product_id and p is None:
            raise not_found(f"Product on line {i + 1}")
        reference = known_prices.get(p.id) if p else None
        if reference is None and p and pl:
            listed = resolve_price(db, p.id, pl.id, on)
            reference = listed.price if listed else None
        unit_price = ln.unit_price if ln.unit_price is not None else reference
        if unit_price is None:
            raise AppError(422, "no_price", f"Enter a price for line {i + 1}", {f"lines.{i}.unit_price": "required"})
        rate = ln.tax_rate if ln.tax_rate is not None else (tax_rate_of(db, p) if p else ZERO)
        changed = unit_price != reference or ln.discount_pct or ln.discount_amount
        if changed and not may_override and body.doc_type not in ("delivery_challan",):
            raise AppError(403, "pricing_not_allowed", "You don't have access to change prices or give discounts",
                           {f"lines.{i}": "pricing"})
        calcs.append(LineCalc(quantity=ln.quantity, unit_price=unit_price, tax_rate=rate,
                              discount_pct=ln.discount_pct, discount_amount=ln.discount_amount))
        infos.append({"product": p, "description": ln.description or (p.name if p else "")})
    if (body.order_discount_pct or body.order_discount_amount) and not may_override:
        existing = known_prices.get("__order_discount__")
        if existing != (body.order_discount_pct, body.order_discount_amount):
            raise AppError(403, "pricing_not_allowed", "You don't have access to give discounts")
    charges = body.delivery_charge + sum((c.amount for c in body.other_charges), ZERO)
    totals = calculate(calcs, body.order_discount_pct, body.order_discount_amount, charges)
    return infos, totals


def write_document(db: Session, doc: SalesDocument, body, customer: Customer | None, infos, totals) -> None:
    doc.doc_date = body.doc_date or doc.doc_date or local_today()
    doc.customer_id = customer.id if customer else None
    doc.customer_name = (customer.company_name or customer.name) if customer else body.customer_name
    doc.customer_phone = customer.phone if customer else body.customer_phone
    doc.customer_email = customer.email if customer else body.customer_email
    doc.customer_ntn = body.customer_ntn if body.customer_ntn is not None else (customer.ntn if customer else None)
    doc.customer_strn = body.customer_strn if body.customer_strn is not None else (customer.strn if customer else None)
    doc.billing_address = body.billing_address or address_snapshot(db, customer, None, None, "billing")
    doc.shipping_address = body.shipping_address or address_snapshot(db, customer, None, None, "shipping")
    doc.order_discount_pct, doc.order_discount_amount = body.order_discount_pct, body.order_discount_amount
    doc.delivery_charge = body.delivery_charge
    doc.other_charges = [{"label": c.label, "amount": str(money(c.amount))} for c in body.other_charges]
    doc.notes = body.notes
    doc.terms = body.terms if body.terms is not None else (doc.terms or get_company(db).invoice_terms)
    doc.due_date = body.due_date
    doc.valid_until = body.valid_until
    doc.subtotal, doc.discount_total, doc.tax_total = totals.subtotal, totals.discount_total, totals.tax_total
    doc.net_total, doc.rounding, doc.grand_total = totals.net_total, totals.rounding, totals.grand_total
    doc.charges_total = totals.delivery_charge
    db.flush()
    db.execute(delete(SalesDocumentLine).where(SalesDocumentLine.document_id == doc.id))
    for i, (info, lc) in enumerate(zip(infos, totals.lines), start=1):
        p = info["product"]
        db.add(SalesDocumentLine(
            document_id=doc.id, line_no=i, product_id=p.id if p else None, sku=p.sku if p else None,
            description=info["description"], quantity=lc.quantity, unit_price=lc.unit_price,
            discount_pct=lc.discount_pct, discount_amount=lc.discount_amount, line_discount=lc.line_discount,
            order_discount_share=lc.order_discount_share, tax_rate=lc.tax_rate, tax_amount=lc.tax,
            net_amount=lc.net, line_total=lc.total))
    db.flush()


def copy_from_order(db: Session, doc: SalesDocument, order: Order) -> None:
    """Exact snapshot of an order's lines and totals (no re-pricing)."""
    for f in ("customer_id", "customer_name", "customer_phone", "billing_address", "shipping_address",
              "order_discount_pct", "order_discount_amount", "delivery_charge", "subtotal", "discount_total",
              "tax_total", "net_total", "rounding", "grand_total"):
        setattr(doc, f, getattr(order, f))
    doc.charges_total = order.delivery_charge
    doc.order_id = order.id
    c = db.get(Customer, order.customer_id) if order.customer_id else None
    if c:
        doc.customer_email, doc.customer_ntn, doc.customer_strn = c.email, c.ntn, c.strn
        doc.customer_name = c.company_name or c.name
    doc.notes = order.notes
    doc.terms = get_company(db).invoice_terms
    db.flush()
    for ln in db.scalars(select(OrderLine).where(OrderLine.order_id == order.id).order_by(OrderLine.line_no)):
        db.add(SalesDocumentLine(
            document_id=doc.id, line_no=ln.line_no, product_id=ln.product_id, sku=ln.sku,
            description=ln.description, quantity=ln.quantity, unit_price=ln.unit_price,
            discount_pct=ln.discount_pct, discount_amount=ln.discount_amount, line_discount=ln.line_discount,
            order_discount_share=ln.order_discount_share, tax_rate=ln.tax_rate, tax_amount=ln.tax_amount,
            net_amount=ln.net_amount, line_total=ln.line_total))
    db.flush()


def issue(db: Session, doc: SalesDocument) -> None:
    if doc.status != "draft":
        raise AppError(409, "already_issued", "Only drafts can be issued")
    if not db.scalar(select(SalesDocumentLine.id).where(SalesDocumentLine.document_id == doc.id).limit(1)) \
            and doc.doc_type != "receipt":
        raise AppError(422, "no_lines", "A document needs at least one line")
    if doc.doc_type == "invoice" and doc.order_id:
        other = db.scalar(select(SalesDocument.number).where(
            SalesDocument.order_id == doc.order_id, SalesDocument.doc_type == "invoice",
            SalesDocument.status.in_(OPEN_INVOICE), SalesDocument.id != doc.id))
        if other:
            raise AppError(409, "order_already_invoiced", f"This order is already invoiced on {other}")
    if doc.doc_type == "credit_note":
        inv = db.get(SalesDocument, doc.related_document_id)
        credited = inv.credited_total + doc.grand_total
        if credited > inv.grand_total:
            raise AppError(422, "over_credit", f"Only {inv.grand_total - inv.credited_total} can still be credited")
    doc.number = next_number(db, doc.doc_type)
    doc.status = "issued"
    doc.issued_at = utcnow()
    doc.doc_date = doc.doc_date or local_today()
    if doc.doc_type in ("invoice", "debit_note") and doc.due_date is None:
        c = db.get(Customer, doc.customer_id) if doc.customer_id else None
        doc.due_date = doc.doc_date + timedelta(days=c.payment_terms_days if c else 0)
    audit(db, "issue", entity_type="sales_documents", entity_id=doc.id, after={"number": doc.number})
    if doc.doc_type == "invoice":
        refresh_invoice(db, doc)
    if doc.doc_type == "credit_note":
        inv = db.get(SalesDocument, doc.related_document_id)
        inv.credited_total += doc.grand_total
        refresh_invoice(db, inv)


def payments_for(inv: SalesDocument):
    cond = Payment.invoice_id == inv.id
    if inv.order_id:
        cond = or_(cond, Payment.order_id == inv.order_id)
    return cond


def refresh_invoice(db: Session, inv: SalesDocument) -> None:
    if inv.doc_type != "invoice":
        return
    db.flush()
    rows = db.execute(select(Payment.kind, func.coalesce(func.sum(Payment.amount), 0))
                      .where(payments_for(inv), Payment.status == "completed").group_by(Payment.kind)).all()
    sums = dict(rows)
    inv.paid_total = sums.get("payment", ZERO) - sums.get("refund", ZERO)
    if inv.status in ("draft", "cancelled"):
        return
    balance = inv.grand_total - inv.paid_total - inv.credited_total
    if inv.credited_total >= inv.grand_total and inv.grand_total > 0:
        inv.status = "credited"
    elif balance <= 0:
        inv.status = "paid"
    elif inv.due_date and inv.due_date < local_today():
        inv.status = "overdue"
    elif inv.paid_total > 0:
        inv.status = "partially_paid"
    else:
        inv.status = "issued"


def refresh_invoices_for_order(db: Session, order_id: int) -> None:
    for inv in db.scalars(select(SalesDocument).where(SalesDocument.order_id == order_id,
                                                      SalesDocument.doc_type == "invoice")):
        refresh_invoice(db, inv)


def mark_overdue(db: Session) -> int:
    """Daily job: unpaid invoices past their due date become overdue. Safe to run repeatedly."""
    rows = db.scalars(select(SalesDocument).where(
        SalesDocument.doc_type == "invoice", SalesDocument.status.in_(("issued", "partially_paid")),
        SalesDocument.due_date < local_today())).all()
    for inv in rows:
        refresh_invoice(db, inv)
    return len(rows)
