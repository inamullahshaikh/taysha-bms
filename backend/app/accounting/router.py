"""Chart of accounts, journal (automatic + approved manual entries), financial statements, budgets."""

from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.accounting.models import ACCOUNT_TYPES, Account, Budget, BudgetLine, JournalEntry, JournalLine
from app.accounting.posting import is_closed, post_entry, post_pending, reverse
from app.audit import audit
from app.auth.access import require_access
from app.auth.models import User
from app.clock import local_today, utcnow
from app.company import approvals_on
from app.crud import RecordOut, crud_router, get_or_404
from app.db import DB
from app.errors import AppError
from app.expenses import Expense
from app.listing import ListParams, Page, apply_filters, export_response, paginate
from app.numbering import next_number
from app.reports import Range, period

ZERO = Decimal(0)
VIEW, CREATE, APPROVE, EXPORT = (require_access("accounting", a) for a in ("view", "create", "approve", "export"))
Fmt = Literal["json", "csv", "xlsx"]

router = APIRouter(prefix="/accounting", tags=["accounting"])


# ---------- journal ----------

class JLineIn(BaseModel):
    account_id: int
    debit: Decimal = Field(ZERO, ge=0)
    credit: Decimal = Field(ZERO, ge=0)
    customer_id: int | None = None
    supplier_id: int | None = None
    cost_centre_id: int | None = None
    memo: str | None = None


class JEIn(BaseModel):
    entry_date: date
    memo: str = Field(min_length=3)
    lines: list[JLineIn] = Field(min_length=2)

    @model_validator(mode="after")
    def _balanced(self):
        if sum(ln.debit for ln in self.lines) != sum(ln.credit for ln in self.lines):
            raise ValueError("debits and credits must be equal")
        if any(ln.debit and ln.credit for ln in self.lines):
            raise ValueError("a line is either a debit or a credit")
        return self


class JEOut(RecordOut):
    number: str | None
    entry_date: date
    status: str
    source_type: str | None
    source_id: int | None
    kind: str
    memo: str | None
    is_manual: bool
    created_by_id: int | None
    approved_by_id: int | None
    created_at: datetime
    lines: list[dict] = []


def je_outs(db: Session, entries: list[JournalEntry]) -> list[JEOut]:
    """Entries with their lines, all lines in one query."""
    lines: dict[int, list[dict]] = {e.id: [] for e in entries}
    for ln, a in db.execute(select(JournalLine, Account).join(Account)
                            .where(JournalLine.entry_id.in_(lines)).order_by(JournalLine.id)):
        lines[ln.entry_id].append({
            "account_id": ln.account_id, "account": f"{a.code} {a.name}", "debit": ln.debit, "credit": ln.credit,
            "customer_id": ln.customer_id, "supplier_id": ln.supplier_id, "cost_centre_id": ln.cost_centre_id,
            "memo": ln.memo})
    out = []
    for e in entries:
        o = JEOut.model_validate(e)
        o.lines = lines[e.id]
        out.append(o)
    return out


def je_out(db: Session, e: JournalEntry) -> JEOut:
    return je_outs(db, [e])[0]


@router.post("/sync")
def sync(db: DB, _: User = VIEW):
    """Post anything not yet in the ledger (also runs every few minutes)."""
    return post_pending(db)


@router.get("/journal", response_model=Page[JEOut])
def list_journal(db: DB, p: Annotated[ListParams, Depends()], date_from: date | None = None,
                 date_to: date | None = None, account_id: int | None = None, source_type: str | None = None,
                 status: str | None = None, manual_only: bool = False, _: User = VIEW):
    q = apply_filters(select(JournalEntry), JournalEntry, p, (JournalEntry.number, JournalEntry.memo),
                      {"entry_date": JournalEntry.entry_date}, JournalEntry.id.desc())
    if date_from:
        q = q.where(JournalEntry.entry_date >= date_from)
    if date_to:
        q = q.where(JournalEntry.entry_date <= date_to)
    if account_id:
        q = q.where(JournalEntry.id.in_(select(JournalLine.entry_id).where(JournalLine.account_id == account_id)))
    if source_type:
        q = q.where(JournalEntry.source_type == source_type)
    if status:
        q = q.where(JournalEntry.status == status)
    if manual_only:
        q = q.where(JournalEntry.is_manual)
    page = paginate(db, q, p)
    page["items"] = je_outs(db, page["items"])
    return page


@router.get("/journal/{entry_id}", response_model=JEOut)
def read_entry(entry_id: int, db: DB, _: User = VIEW):
    return je_out(db, get_or_404(db, JournalEntry, entry_id, "Journal entry"))


@router.post("/journal", response_model=JEOut, status_code=201)
def manual_entry(body: JEIn, db: DB, user: User = CREATE):
    """Adjustment entry. Saved as a draft that a different person with approve access posts, or posted at once
    when the company doesn't use approvals."""
    for ln in body.lines:
        get_or_404(db, Account, ln.account_id, "Account")
    e = post_entry(db, body.entry_date, [(ln.account_id, ln.debit, ln.credit,
                                          {k: getattr(ln, k) for k in ("customer_id", "supplier_id",
                                                                       "cost_centre_id", "memo")})
                                         for ln in body.lines], body.memo, manual=True, status="draft")
    audit(db, "create", e)
    if not approvals_on(db):
        post_draft(db, e, user)
    return je_out(db, e)


@router.post("/journal/{entry_id}/approve", response_model=JEOut)
def approve_entry(entry_id: int, db: DB, user: User = APPROVE):
    e = get_or_404(db, JournalEntry, entry_id, "Journal entry")
    if e.status != "draft":
        raise AppError(409, "not_draft", f"Entry is {e.status}")
    if e.created_by_id == user.id and approvals_on(db):
        raise AppError(403, "own_entry", "Someone else must approve your journal entry")
    post_draft(db, e, user)
    return je_out(db, e)


def post_draft(db: Session, e: JournalEntry, user: User) -> None:
    if is_closed(db, e.entry_date):
        raise AppError(409, "period_closed", "That accounting period is closed")
    e.status, e.number, e.approved_by_id, e.approved_at = "posted", next_number(db, "journal"), user.id, utcnow()
    audit(db, "approve", entity_type="journal_entries", entity_id=e.id)


@router.post("/journal/{entry_id}/reject", response_model=JEOut)
def reject_entry(entry_id: int, db: DB, _: User = APPROVE):
    e = get_or_404(db, JournalEntry, entry_id, "Journal entry")
    if e.status != "draft":
        raise AppError(409, "not_draft", f"Entry is {e.status}")
    e.status = "rejected"
    audit(db, "reject", entity_type="journal_entries", entity_id=e.id)
    return je_out(db, e)


class ReverseIn(BaseModel):
    entry_date: date | None = None
    memo: str | None = None


@router.post("/journal/{entry_id}/reverse", response_model=JEOut)
def reverse_manual(entry_id: int, body: ReverseIn, db: DB, _: User = APPROVE):
    e = get_or_404(db, JournalEntry, entry_id, "Journal entry")
    if not e.is_manual or e.status != "posted":
        raise AppError(422, "not_reversible", "Only posted manual entries are reversed here; automatic entries "
                                              "follow their source document")
    if db.scalar(select(JournalEntry.id).where(JournalEntry.memo == f"Reversal of {e.number}")):
        raise AppError(409, "already_reversed", "Already reversed")
    r = reverse(db, e, body.entry_date, body.memo or f"Reversal of {e.number}", kind="extra")
    r.source_type, r.source_id = None, None
    return je_out(db, r)


# ---------- balances & statements ----------

def balances(db: Session, date_from: date | None, date_to: date, types: tuple = ACCOUNT_TYPES,
             extra_where=None) -> list[dict]:
    """Per account: debit, credit, balance (natural sign: assets/expenses debit-positive)."""
    q = (select(Account.id, Account.code, Account.name, Account.type,
                func.coalesce(func.sum(JournalLine.debit), 0), func.coalesce(func.sum(JournalLine.credit), 0))
         .join(JournalLine, JournalLine.account_id == Account.id)
         .join(JournalEntry, JournalEntry.id == JournalLine.entry_id)
         .where(JournalEntry.status == "posted", JournalEntry.entry_date <= date_to, Account.type.in_(types))
         .group_by(Account.id).order_by(Account.code))
    if date_from:
        q = q.where(JournalEntry.entry_date >= date_from)
    if extra_where is not None:
        q = q.where(extra_where)
    out = []
    for aid, code, name, typ, dr, cr in db.execute(q):
        bal = dr - cr if typ in ("asset", "expense") else cr - dr
        out.append({"account_id": aid, "code": code, "name": name, "type": typ, "debit": dr, "credit": cr,
                    "balance": bal})
    return out


def out_fmt(db, rows, cols, fmt, name, extra):
    if fmt == "json":
        return {**extra, "rows": rows}
    return export_response(db, rows, cols, fmt, name, "journal_entries")


@router.get("/trial-balance")
def trial_balance(db: DB, as_of: date | None = None, format: Fmt = "json", _: User = VIEW):
    post_pending(db)
    as_of = as_of or local_today()
    rows = balances(db, None, as_of)
    tdr, tcr = sum((r["debit"] for r in rows), ZERO), sum((r["credit"] for r in rows), ZERO)
    return out_fmt(db, rows, [("code", "Code"), ("name", "Account"), ("debit", "Debit"), ("credit", "Credit")],
                   format, "trial-balance", {"as_of": as_of, "total_debit": tdr, "total_credit": tcr,
                                             "balanced": tdr == tcr})


@router.get("/ledger/{account_id}")
def ledger(account_id: int, db: DB, date_from: date | None = None, date_to: date | None = None,
           customer_id: int | None = None, supplier_id: int | None = None, format: Fmt = "json", _: User = VIEW):
    post_pending(db)
    a = get_or_404(db, Account, account_id, "Account")
    end = date_to or local_today()
    start = date_from or end.replace(month=1, day=1)
    sign = 1 if a.type in ("asset", "expense") else -1
    base = (select(JournalLine, JournalEntry).join(JournalEntry)
            .where(JournalLine.account_id == a.id, JournalEntry.status == "posted"))
    if customer_id:
        base = base.where(JournalLine.customer_id == customer_id)
    if supplier_id:
        base = base.where(JournalLine.supplier_id == supplier_id)
    opening = sum(((ln.debit - ln.credit) * sign for ln, e in db.execute(base.where(JournalEntry.entry_date < start))),
                  ZERO)
    running, rows = opening, []
    for ln, e in db.execute(base.where(JournalEntry.entry_date.between(start, end))
                            .order_by(JournalEntry.entry_date, JournalEntry.id)):
        running += (ln.debit - ln.credit) * sign
        rows.append({"date": e.entry_date, "entry": e.number, "memo": ln.memo or e.memo, "debit": ln.debit,
                     "credit": ln.credit, "balance": running, "source_type": e.source_type,
                     "source_id": e.source_id})
    return out_fmt(db, rows, [("date", "Date"), ("entry", "Entry"), ("memo", "Memo"), ("debit", "Debit"),
                              ("credit", "Credit"), ("balance", "Balance")], format, f"ledger-{a.code}",
                   {"account": f"{a.code} {a.name}", "from": start, "to": end, "opening_balance": opening,
                    "closing_balance": running})


@router.get("/profit-loss")
def profit_loss(db: DB, range: Range = "month", date_from: date | None = None, date_to: date | None = None,
                format: Fmt = "json", _: User = VIEW):
    post_pending(db)
    start, end = period(range, date_from, date_to)
    rows = balances(db, start, end, ("income", "expense"))
    income = sum((r["balance"] for r in rows if r["type"] == "income"), ZERO)
    expense = sum((r["balance"] for r in rows if r["type"] == "expense"), ZERO)
    cogs = sum((r["balance"] for r in rows if r["code"] in ("5000",)), ZERO)
    return out_fmt(db, rows, [("code", "Code"), ("name", "Account"), ("type", "Type"), ("balance", "Amount")],
                   format, "profit-loss", {"from": start, "to": end, "income": income, "cost_of_sales": cogs,
                                           "gross_profit": income - cogs, "expenses": expense,
                                           "net_profit": income - expense})


@router.get("/balance-sheet")
def balance_sheet(db: DB, as_of: date | None = None, format: Fmt = "json", _: User = VIEW):
    post_pending(db)
    as_of = as_of or local_today()
    rows = balances(db, None, as_of, ("asset", "liability", "equity"))
    pl = balances(db, None, as_of, ("income", "expense"))
    earnings = sum((r["balance"] if r["type"] == "income" else -r["balance"] for r in pl), ZERO)
    rows.append({"account_id": None, "code": "", "name": "Profit to date (not yet closed)", "type": "equity",
                 "debit": ZERO, "credit": ZERO, "balance": earnings})
    tot = {t: sum((r["balance"] for r in rows if r["type"] == t), ZERO) for t in ("asset", "liability", "equity")}
    return out_fmt(db, rows, [("code", "Code"), ("name", "Account"), ("type", "Type"), ("balance", "Balance")],
                   format, "balance-sheet", {"as_of": as_of, "total_assets": tot["asset"],
                                             "total_liabilities": tot["liability"], "total_equity": tot["equity"],
                                             "balanced": tot["asset"] == tot["liability"] + tot["equity"]})


CASH_CODES = ("1000", "1010", "1020")


@router.get("/cash-flow")
def cash_flow(db: DB, range: Range = "month", date_from: date | None = None, date_to: date | None = None,
              _: User = VIEW):
    """Money in and out of cash/bank accounts, grouped by what was on the other side of each entry."""
    post_pending(db)
    start, end = period(range, date_from, date_to)
    cash_ids = set(db.scalars(select(Account.id).where(Account.code.in_(CASH_CODES))))
    accts = {a.id: a for a in db.scalars(select(Account))}

    def cash_total(until: date) -> Decimal:
        return db.scalar(select(func.coalesce(func.sum(JournalLine.debit - JournalLine.credit), 0)).join(JournalEntry)
                         .where(JournalLine.account_id.in_(cash_ids), JournalEntry.status == "posted",
                                JournalEntry.entry_date <= until))

    groups: dict[str, dict[str, Decimal]] = {"operating": {}, "investing": {}, "financing": {}}
    entries = select(JournalEntry.id).where(
        JournalEntry.status == "posted", JournalEntry.entry_date.between(start, end),
        JournalEntry.id.in_(select(JournalLine.entry_id).where(JournalLine.account_id.in_(cash_ids))))
    by_entry: dict[int, list[JournalLine]] = {}
    for ln in db.scalars(select(JournalLine).where(JournalLine.entry_id.in_(entries))
                         .order_by(JournalLine.entry_id, JournalLine.id)):
        by_entry.setdefault(ln.entry_id, []).append(ln)
    for lines in by_entry.values():
        cash = sum((ln.debit - ln.credit for ln in lines if ln.account_id in cash_ids), ZERO)
        others = [ln for ln in lines if ln.account_id not in cash_ids]
        if not others or cash == 0:
            continue  # transfers between cash accounts
        main = accts[max(others, key=lambda ln: ln.debit + ln.credit).account_id]
        g = "investing" if main.code.startswith("14") else "financing" if (
            main.type == "equity" or main.code == "2300") else "operating"
        label = f"{main.code} {main.name}"
        groups[g][label] = groups[g].get(label, ZERO) + cash
    opening = cash_total(start - timedelta(days=1))
    net = sum((v for g in groups.values() for v in g.values()), ZERO)
    return {"from": start, "to": end, "opening_cash": opening,
            **{g: {"lines": [{"account": k, "amount": v} for k, v in sorted(d.items())],
                   "total": sum(d.values(), ZERO)} for g, d in groups.items()},
            "net_change": net, "closing_cash": opening + net}


@router.get("/tax")
def tax_report(db: DB, range: Range = "month", date_from: date | None = None, date_to: date | None = None,
               _: User = VIEW):
    """Sales tax collected vs paid on purchases/expenses, and withholding tax held for the government."""
    post_pending(db)
    start, end = period(range, date_from, date_to)
    b = {r["code"]: r for r in balances(db, start, end, ("asset", "liability"))}
    output = b.get("2100", {}).get("balance", ZERO)
    inp = b.get("1300", {}).get("balance", ZERO)
    return {"from": start, "to": end, "output_tax": output, "input_tax": inp, "net_payable": output - inp,
            "withholding_tax_deducted": b.get("2110", {}).get("credit", ZERO)}


@router.get("/party-balances")
def party_balances(db: DB, kind: Literal["customers", "suppliers"] = "customers", as_of: date | None = None,
                   _: User = VIEW):
    """Sales ledger (receivables by customer) or purchase ledger (payables by supplier)."""
    post_pending(db)
    as_of = as_of or local_today()
    code, col = ("1100", JournalLine.customer_id) if kind == "customers" else ("2000", JournalLine.supplier_id)
    sign = 1 if kind == "customers" else -1
    rows = db.execute(select(col, func.sum(JournalLine.debit - JournalLine.credit)).join(JournalEntry)
                      .join(Account).where(Account.code == code, JournalEntry.status == "posted",
                                           JournalEntry.entry_date <= as_of)
                      .group_by(col).having(func.sum(JournalLine.debit - JournalLine.credit) != 0))
    return [{"party_id": pid, "balance": bal * sign} for pid, bal in rows]


# ---------- budgets ----------

class BudgetLineIn(BaseModel):
    category_id: int | None = None
    cost_centre_id: int | None = None
    account_id: int | None = None
    amount: Decimal = Field(ge=0)
    hard_limit: bool = False

    @model_validator(mode="after")
    def _target(self):
        if not (self.category_id or self.cost_centre_id or self.account_id):
            raise ValueError("a budget line needs a category, cost centre or account")
        return self


def budget_actual(db: Session, b: Budget, ln: BudgetLine, exclude_expense_id: int | None = None) -> Decimal:
    if ln.account_id:
        r = balances(db, b.period_start, b.period_end, extra_where=JournalLine.account_id == ln.account_id)
        return r[0]["balance"] if r else ZERO
    q = select(func.coalesce(func.sum(Expense.amount - Expense.tax_amount), 0)).where(
        Expense.status == "approved", Expense.expense_date.between(b.period_start, b.period_end))
    if ln.category_id:
        q = q.where(Expense.category_id == ln.category_id)
    if ln.cost_centre_id:
        q = q.where(Expense.cost_centre_id == ln.cost_centre_id)
    if exclude_expense_id:
        q = q.where(Expense.id != exclude_expense_id)
    return db.scalar(q)


def check_budget(db: Session, user: User, e: Expense) -> None:
    """Called before approving an expense: hard budget limits block it (owners may still approve)."""
    if user.is_owner:
        return
    for ln, b in db.execute(select(BudgetLine, Budget).join(Budget).where(
            BudgetLine.hard_limit, Budget.archived_at.is_(None), Budget.period_start <= e.expense_date,
            Budget.period_end >= e.expense_date, BudgetLine.account_id.is_(None))):
        if (ln.category_id and ln.category_id != e.category_id) or \
                (ln.cost_centre_id and ln.cost_centre_id != e.cost_centre_id):
            continue
        spent = budget_actual(db, b, ln, e.id)
        if spent + e.amount - e.tax_amount > ln.amount:
            raise AppError(409, "over_budget", f"This would exceed the '{b.name}' budget ({spent} of {ln.amount} "
                                               "used); an owner must approve")


budgets = APIRouter(prefix="/budgets", tags=["accounting"])
B_EDIT = require_access("accounting", "create")


@budgets.put("/{budget_id}/lines")
def set_lines(budget_id: int, body: list[BudgetLineIn], db: DB, _: User = B_EDIT):
    get_or_404(db, Budget, budget_id, "Budget")
    db.query(BudgetLine).filter(BudgetLine.budget_id == budget_id).delete()
    db.add_all(BudgetLine(budget_id=budget_id, **ln.model_dump()) for ln in body)
    audit(db, "update", entity_type="budgets", entity_id=budget_id, note="lines")
    db.flush()
    return vs_actual(budget_id, db)


@budgets.get("/{budget_id}/vs-actual")
def vs_actual(budget_id: int, db: DB, _: User = VIEW):
    b = get_or_404(db, Budget, budget_id, "Budget")
    rows = []
    for ln in db.scalars(select(BudgetLine).where(BudgetLine.budget_id == b.id).order_by(BudgetLine.id)):
        actual = budget_actual(db, b, ln)
        rows.append({"id": ln.id, "category_id": ln.category_id, "cost_centre_id": ln.cost_centre_id,
                     "account_id": ln.account_id, "budget": ln.amount, "actual": actual,
                     "remaining": ln.amount - actual, "hard_limit": ln.hard_limit,
                     "used_pct": (actual / ln.amount * 100).quantize(Decimal("0.1")) if ln.amount else None})
    return {"budget": b.name, "from": b.period_start, "to": b.period_end, "lines": rows,
            "total_budget": sum((r["budget"] for r in rows), ZERO),
            "total_actual": sum((r["actual"] for r in rows), ZERO)}


# ---------- CRUD ----------

class AccountIn(BaseModel):
    code: str = Field(min_length=1, max_length=20)
    name: str = Field(min_length=1)
    type: Literal["asset", "liability", "equity", "income", "expense"]
    parent_id: int | None = None
    description: str | None = None


class AccountPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    parent_id: int | None = None


class AccountOut(RecordOut, AccountIn):
    is_system: bool


class BudgetIn(BaseModel):
    name: str = Field(min_length=1)
    period_start: date
    period_end: date
    notes: str | None = None


class BudgetPatch(BaseModel):
    name: str | None = None
    notes: str | None = None


class BudgetOut(RecordOut, BudgetIn):
    pass


crud_routers = [
    crud_router(Account, prefix="/accounting/accounts", feature="accounting", create=AccountIn, update=AccountPatch,
                out=AccountOut, search=(Account.code, Account.name), filters={"type": Account.type},
                default_sort=Account.code, tags=["accounting"]),
    crud_router(Budget, prefix="/budgets", feature="accounting", create=BudgetIn, update=BudgetPatch, out=BudgetOut,
                search=(Budget.name,), default_sort=Budget.period_start.desc(), tags=["accounting"]),
]
routers = [router, budgets, *crud_routers]
