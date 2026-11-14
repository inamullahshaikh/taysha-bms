"""Automatic double-entry postings from business records.

post_pending() scans each source for records that should be in the ledger but aren't yet, and posts them.
It's idempotent (unique source_type + source_id + kind), runs from the scheduler and before every report.

Revenue rule: an order's sale is posted when it is dispatched (or handed over). An invoice raised for an order is
paperwork for that same sale and posts nothing; invoices without an order post their own sale.
"""

from collections import defaultdict
from datetime import date
from decimal import Decimal

from sqlalchemy import and_, exists, or_, select
from sqlalchemy.orm import Session

from app.accounting.models import Account, JournalEntry, JournalLine
from app.clock import TZ, local_today
from app.company import FinancialPeriod
from app.errors import AppError
from app.numbering import next_number
from app.products.pricing import money

ZERO = Decimal(0)
CASH_ACCOUNT = {"cash": "1000", "cod": "1000", "bank_transfer": "1010", "cheque": "1010", "card": "1020",
                "online": "1020", "other": "1010"}
# stock movement reason -> account on the other side of Inventory (1200)
STOCK_COUNTER = {
    "receipt": "4910", "opening": "3100", "purchase_receipt": "2010", "sale": "5000", "customer_return": "5000",
    "issue": "6000", "internal_use": "6000", "sample": "5020", "wastage": "5010", "damage": "5010",
    "expired": "5010", "adjustment": "5030", "count": "5030", "transfer_out": "1210", "transfer_in": "1210",
    "production_out": "1220", "production_return": "1220", "production_in": "1220", "supplier_return": "2010",
}


def account_ids(db: Session) -> dict[str, int]:
    key = "account_ids"
    if key not in db.info:
        db.info[key] = {code: aid for code, aid in db.execute(select(Account.code, Account.id))}
    return db.info[key]


def is_closed(db: Session, d: date) -> bool:
    return db.scalar(select(FinancialPeriod.id).where(FinancialPeriod.is_closed, FinancialPeriod.start_date <= d,
                                                      FinancialPeriod.end_date >= d).limit(1)) is not None


Line = tuple  # (account_code_or_id, debit, credit, extra: dict)


def post_entry(db: Session, entry_date: date, lines: list[Line], memo: str, source: tuple | None = None,
               kind: str = "main", manual: bool = False, status: str = "posted") -> JournalEntry | None:
    """Write a balanced entry. Accounts are codes (str) or ids (int). Zero lines are dropped."""
    ids = account_ids(db)
    clean = []
    for acct, dr, cr, extra in lines:
        net = money(dr or ZERO) - money(cr or ZERO)  # e.g. negative rounding on the credit side becomes a debit
        if net == 0:
            continue
        dr, cr = (net, ZERO) if net > 0 else (ZERO, -net)
        clean.append((ids[acct] if isinstance(acct, str) else acct, dr, cr, extra))
    if not clean:
        return None
    total_dr, total_cr = sum(c[1] for c in clean), sum(c[2] for c in clean)
    if total_dr != total_cr:
        raise AppError(422, "unbalanced", f"Debits {total_dr} and credits {total_cr} must be equal")
    if is_closed(db, entry_date):
        if manual:
            raise AppError(409, "period_closed", "That accounting period is closed")
        memo = f"{memo} (dated {entry_date}; period closed)"
        entry_date = local_today()
    e = JournalEntry(entry_date=entry_date, memo=memo, source_type=source[0] if source else None,
                     source_id=source[1] if source else None, kind=kind, is_manual=manual, status=status,
                     number=next_number(db, "journal") if status == "posted" else None)
    db.add(e)
    db.flush()
    db.add_all(JournalLine(entry_id=e.id, account_id=a, debit=dr, credit=cr, **(extra or {}))
               for a, dr, cr, extra in clean)
    db.flush()
    return e


def reverse(db: Session, entry: JournalEntry, on: date | None = None, memo: str | None = None,
            kind: str = "reverse") -> JournalEntry | None:
    lines = db.scalars(select(JournalLine).where(JournalLine.entry_id == entry.id)).all()
    return post_entry(db, on or local_today(),
                      [(ln.account_id, ln.credit, ln.debit,
                        {"customer_id": ln.customer_id, "supplier_id": ln.supplier_id,
                         "cost_centre_id": ln.cost_centre_id}) for ln in lines],
                      memo or f"Reversal of {entry.number}", (entry.source_type, entry.source_id), kind=kind,
                      manual=entry.is_manual)


def not_posted(model, source_type: str, kind: str = "main"):
    return ~exists().where(and_(JournalEntry.source_type == source_type, JournalEntry.source_id == model.id,
                                JournalEntry.kind == kind))


def posted_main(source_type: str, model):
    return exists().where(and_(JournalEntry.source_type == source_type, JournalEntry.source_id == model.id,
                               JournalEntry.kind == "main"))


def local_date(dt) -> date:
    return dt.astimezone(TZ).date() if dt else local_today()


# ---------- the sources ----------

def sale_lines(customer_id, net, tax, charges, rounding, grand, revenue_acct="4000", sign=1) -> list[Line]:
    c = {"customer_id": customer_id}
    s = sign
    return [("1100", grand * s, 0, c), (revenue_acct, 0, net * s, c), ("2100", 0, tax * s, c),
            ("4010", 0, charges * s, c), ("4900", 0, rounding * s, c)]


def pending_orders():
    from app.orders.models import Order

    return select(Order).where(Order.dispatched_at.is_not(None), not_posted(Order, "order"))


def post_orders(db: Session) -> int:
    n = 0
    for o in db.scalars(pending_orders()):
        post_entry(db, local_date(o.dispatched_at),
                   sale_lines(o.customer_id, o.net_total, o.tax_total, o.delivery_charge, o.rounding, o.grand_total),
                   f"Sale {o.number}", ("order", o.id))
        n += 1
    return n


def pending_documents():
    from app.documents.models import SalesDocument as D

    return select(D).where(D.status.not_in(("draft", "cancelled")), not_posted(D, "sales_document"),
                           (D.doc_type.in_(("credit_note", "debit_note")))
                           | and_(D.doc_type == "invoice", D.order_id.is_(None)))


def pending_document_cancels():
    from app.documents.models import SalesDocument as D

    return select(D).where(D.status == "cancelled", posted_main("sales_document", D),
                           not_posted(D, "sales_document", "reverse"))


def post_documents(db: Session) -> int:
    n = 0
    for d in db.scalars(pending_documents()):
        if d.doc_type == "credit_note":
            c = {"customer_id": d.customer_id}
            lines = [("4020", d.net_total, 0, c), ("2100", d.tax_total, 0, c), ("4010", d.charges_total, 0, c),
                     ("4900", d.rounding, 0, c), ("1100", 0, d.grand_total, c)]
        else:
            lines = sale_lines(d.customer_id, d.net_total, d.tax_total, d.charges_total, d.rounding, d.grand_total)
        post_entry(db, d.doc_date, lines, f"{d.doc_type.replace('_', ' ').title()} {d.number}",
                   ("sales_document", d.id))
        n += 1
    # cancelled after posting -> reverse
    for d in db.scalars(pending_document_cancels()):
        main = db.scalar(select(JournalEntry).where(JournalEntry.source_type == "sales_document",
                                                    JournalEntry.source_id == d.id, JournalEntry.kind == "main"))
        reverse(db, main, memo=f"{d.number} cancelled")
        n += 1
    return n


def pending_returns():
    from app.returns import ReturnRequest

    return select(ReturnRequest).where(ReturnRequest.status == "completed", ReturnRequest.resolution == "refund",
                                       not_posted(ReturnRequest, "return"))


def post_returns(db: Session) -> int:
    """Refunded returns reverse the sale for the returned goods (credit notes post themselves)."""
    from app.orders.models import Order, OrderLine
    from app.returns import ReturnLine

    n = 0
    for r in db.scalars(pending_returns()):
        net = tax = ZERO
        for rl in db.scalars(select(ReturnLine).where(ReturnLine.return_id == r.id)):
            ol = db.get(OrderLine, rl.order_line_id)
            net += ol.net_amount / ol.quantity * rl.quantity
            tax += ol.tax_amount / ol.quantity * rl.quantity
        net, tax = money(net), money(tax)
        c = {"customer_id": db.get(Order, r.order_id).customer_id}
        post_entry(db, local_date(r.completed_at), [("4020", net, 0, c), ("2100", tax, 0, c),
                                                    ("1100", 0, net + tax, c)], f"Return {r.number}",
                   ("return", r.id))
        n += 1
    return n


def pending_payments():
    from app.orders.models import Payment

    return select(Payment).where(Payment.status == "completed", not_posted(Payment, "payment"))


def post_payments(db: Session) -> int:
    n = 0
    for p in db.scalars(pending_payments()):
        c = {"customer_id": p.customer_id}
        cash = CASH_ACCOUNT.get(p.method, "1010")
        lines = [(cash, p.amount, 0, c), ("1100", 0, p.amount, c)]
        if p.kind == "refund":
            lines = [(cash, 0, p.amount, c), ("1100", p.amount, 0, c)]
        post_entry(db, p.payment_date, lines, f"{p.kind.title()} {p.number}", ("payment", p.id))
        n += 1
    return n


def pending_stock():
    from app.inventory.models import StockMovement as M

    return select(M).where(M.unit_cost.is_not(None), M.unit_cost != 0, not_posted(M, "stock_movement"))


def post_stock(db: Session) -> int:
    from app.inventory.models import StockMovement as M

    n = 0
    for m in db.scalars(pending_stock().order_by(M.id)):
        value = money(abs(m.quantity) * m.unit_cost)
        counter = STOCK_COUNTER.get(m.reason, "5030")
        lines = [("1200", value, 0, {}), (counter, 0, value, {})] if m.quantity > 0 else \
            [(counter, value, 0, {}), ("1200", 0, value, {})]
        post_entry(db, m.movement_date, lines, f"Stock {m.reason} {m.reference_number or ''}".strip(),
                   ("stock_movement", m.id))
        n += 1
    return n


def pending_production():
    from app.production.models import ProductionOrder as P

    return select(P).where(P.status == "completed", not_posted(P, "production_order"))


def post_production(db: Session) -> int:
    """Labour and overhead added to finished goods cost are moved out of P&L into work in progress."""
    n = 0
    for p in db.scalars(pending_production()):
        absorbed = (p.labour_cost or ZERO) + (p.overhead_cost or ZERO)
        post_entry(db, local_date(p.completed_at), [("1220", absorbed, 0, {}), ("5040", 0, absorbed, {})],
                   f"Labour & overhead {p.number}", ("production_order", p.id))
        n += 1
    return n


def pending_bills():
    from app.purchasing.models import SupplierBill as B

    return select(B).where(B.status != "cancelled", not_posted(B, "supplier_bill"))


def pending_bill_cancels():
    from app.purchasing.models import SupplierBill as B

    return select(B).where(B.status == "cancelled", posted_main("supplier_bill", B),
                           not_posted(B, "supplier_bill", "reverse"))


def pending_supplier_payments():
    from app.purchasing.models import SupplierPayment as SP

    return select(SP).where(not_posted(SP, "supplier_payment"))


def post_bills(db: Session) -> int:
    from app.purchasing.models import SupplierBillLine

    n = 0
    for b in db.scalars(pending_bills()):
        s = {"supplier_id": b.supplier_id}
        by_acct: dict[str, Decimal] = defaultdict(lambda: ZERO)
        for ln in db.scalars(select(SupplierBillLine).where(SupplierBillLine.bill_id == b.id)):
            by_acct["2010" if ln.po_line_id else "6000"] += ln.line_total - ln.tax_amount
        lines = [(a, v, 0, s) for a, v in by_acct.items()]
        lines += [("1300", b.tax_total, 0, s), ("2000", 0, b.grand_total - b.withholding_tax, s),
                  ("2110", 0, b.withholding_tax, s)]
        post_entry(db, b.bill_date, lines, f"Supplier bill {b.number}", ("supplier_bill", b.id))
        n += 1
    for b in db.scalars(pending_bill_cancels()):
        main = db.scalar(select(JournalEntry).where(JournalEntry.source_type == "supplier_bill",
                                                    JournalEntry.source_id == b.id, JournalEntry.kind == "main"))
        reverse(db, main, memo=f"{b.number} cancelled")
        n += 1
    for p in db.scalars(pending_supplier_payments()):
        s = {"supplier_id": p.supplier_id}
        post_entry(db, p.payment_date, [("2000", p.amount, 0, s), (CASH_ACCOUNT.get(p.method, "1010"), 0, p.amount, s)],
                   f"Supplier payment {p.number}", ("supplier_payment", p.id))
        n += 1
    return n


def pending_expenses():
    from app.expenses import Expense

    return select(Expense).where(Expense.status == "approved", not_posted(Expense, "expense"))


def post_expenses(db: Session) -> int:
    from app.expenses import ExpenseCategory

    n = 0
    for e in db.scalars(pending_expenses()):
        cat = db.get(ExpenseCategory, e.category_id)
        acct = cat.account_id or "6000"
        paid_from = CASH_ACCOUNT.get(e.payment_method, "2200") if e.payment_method else "2200"
        extra = {"cost_centre_id": e.cost_centre_id, "supplier_id": e.supplier_id}
        post_entry(db, e.expense_date, [(acct, e.amount - e.tax_amount, 0, extra), ("1300", e.tax_amount, 0, extra),
                                        (paid_from, 0, e.amount, {"supplier_id": e.supplier_id})],
                   f"Expense {e.number}: {e.description[:80]}", ("expense", e.id))
        n += 1
    return n


POSTERS = (post_orders, post_documents, post_returns, post_payments, post_stock, post_production, post_bills,
           post_expenses)


PENDING = (pending_orders, pending_documents, pending_document_cancels, pending_returns, pending_payments,
           pending_stock, pending_production, pending_bills, pending_bill_cancels, pending_supplier_payments,
           pending_expenses)


def post_pending(db: Session) -> dict[str, int]:
    """Runs before every report, so the usual case (nothing new) is one EXISTS probe instead of every poster."""
    if not db.scalar(select(or_(*(q().exists() for q in PENDING)))):
        return {fn.__name__.removeprefix("post_"): 0 for fn in POSTERS}
    # no per-poster savepoint: an error propagates and the caller's transaction rolls back as a whole
    return {fn.__name__.removeprefix("post_"): fn(db) for fn in POSTERS}
