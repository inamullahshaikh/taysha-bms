"""Expenses: categories, cost centres, submit -> approve/reject. Receipts are attachments (entity_type=expenses)."""

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import Date, DateTime, ForeignKey, Index, String, Text, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.attachments import Attachment
from app.audit import audit, snapshot
from app.auth.access import can, require_access
from app.auth.deps import CurrentUser
from app.auth.models import User
from app.clock import local_today, utcnow
from app.company import get_company
from app.crud import RecordOut, crud_router, get_or_404
from app.db import DB, Base, Entity, Money
from app.errors import AppError
from app.listing import ListParams, Page, apply_filters, export_response, paginate
from app.numbering import next_number


class ExpenseCategory(Entity, Base):
    __tablename__ = "expense_categories"
    name: Mapped[str] = mapped_column(String(120))
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("expense_categories.id"))  # subcategories
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id"))  # ledger account (default 6000)


class CostCentre(Entity, Base):
    __tablename__ = "cost_centres"
    code: Mapped[str] = mapped_column(String(20), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    department_id: Mapped[int | None] = mapped_column(ForeignKey("departments.id"))


class Expense(Entity, Base):
    __tablename__ = "expenses"
    __table_args__ = (Index("ix_expenses_created_by_id", "created_by_id"),)  # "my expenses"

    number: Mapped[str] = mapped_column(String(30), unique=True)
    expense_date: Mapped[date] = mapped_column(Date, index=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("expense_categories.id"), index=True)
    cost_centre_id: Mapped[int | None] = mapped_column(ForeignKey("cost_centres.id"))
    department_id: Mapped[int | None] = mapped_column(ForeignKey("departments.id"))
    branch_id: Mapped[int | None] = mapped_column(ForeignKey("branches.id"))
    supplier_id: Mapped[int | None] = mapped_column(ForeignKey("suppliers.id"))
    event_id: Mapped[int | None] = mapped_column(ForeignKey("pos_events.id"), index=True)  # stall/event costs
    payee: Mapped[str | None] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text)
    amount: Mapped[Money]  # total paid, incl. tax
    tax_amount: Mapped[Money] = mapped_column(default=Decimal(0))
    payment_method: Mapped[str | None] = mapped_column(String(20))
    reference: Mapped[str | None] = mapped_column(String(100))
    status: Mapped[str] = mapped_column(String(20), default="submitted", index=True)
    decided_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decision_note: Mapped[str | None] = mapped_column(Text)


# ---------- schemas ----------

class CategoryIn(BaseModel):
    name: str = Field(min_length=1)
    parent_id: int | None = None
    account_id: int | None = None


class CategoryOut(RecordOut, CategoryIn):
    pass


class CostCentreIn(BaseModel):
    code: str = Field(min_length=1, max_length=20)
    name: str = Field(min_length=1)
    department_id: int | None = None


class CostCentrePatch(BaseModel):
    name: str | None = None
    department_id: int | None = None


class CostCentreOut(RecordOut, CostCentreIn):
    pass


class ExpenseIn(BaseModel):
    expense_date: date | None = None
    category_id: int
    cost_centre_id: int | None = None
    department_id: int | None = None
    branch_id: int | None = None
    supplier_id: int | None = None
    event_id: int | None = None
    payee: str | None = None
    description: str = Field(min_length=1)
    amount: Decimal = Field(gt=0, decimal_places=2)
    tax_amount: Decimal = Field(Decimal(0), ge=0, decimal_places=2)
    payment_method: Literal["cash", "card", "bank_transfer", "cheque", "online", "other"] | None = None
    reference: str | None = None


class ExpenseOut(RecordOut, ExpenseIn):
    number: str
    expense_date: date
    status: str
    created_by_id: int | None
    created_at: datetime
    decided_by_id: int | None
    decided_at: datetime | None
    decision_note: str | None
    has_receipt: bool = False


class DecisionIn(BaseModel):
    note: str | None = None


# ---------- routes ----------

router = APIRouter(prefix="/expenses", tags=["expenses"])
CREATE, EDIT, APPROVE = (require_access("expenses", a) for a in ("create", "edit", "approve"))


def outs(db: Session, expenses: list[Expense]) -> list[ExpenseOut]:
    """Expenses with has_receipt, one attachment query for the whole list."""
    with_file = set(db.scalars(select(Attachment.entity_id).where(
        Attachment.entity_type == "expenses", Attachment.entity_id.in_([e.id for e in expenses]),
        Attachment.archived_at.is_(None)).distinct()))
    out_ = []
    for e in expenses:
        o = ExpenseOut.model_validate(e)
        o.has_receipt = e.id in with_file
        out_.append(o)
    return out_


def out(db: Session, e: Expense) -> ExpenseOut:
    return outs(db, [e])[0]


def get_expense(db: Session, user: User, expense_id: int) -> Expense:
    e = get_or_404(db, Expense, expense_id, "Expense")
    if e.created_by_id != user.id and not can(db, user, "expenses", "view"):
        raise AppError(403, "forbidden", "You can only see your own expenses")
    return e


def validate_refs(db: Session, body: ExpenseIn) -> None:
    cat = get_or_404(db, ExpenseCategory, body.category_id, "Expense category")
    if cat.archived_at:
        raise AppError(422, "archived_category", "That category is archived", {"category_id": "archived"})
    if body.tax_amount > body.amount:
        raise AppError(422, "tax_too_high", "Tax can't be more than the amount", {"tax_amount": "too high"})


SEARCH = (Expense.number, Expense.description, Expense.payee)
SORTS = {"expense_date": Expense.expense_date, "amount": Expense.amount, "number": Expense.number}


class ExpenseFilters:
    def __init__(self, status: Literal["submitted", "approved", "rejected", "cancelled"] | None = None,
                 category_id: int | None = None, cost_centre_id: int | None = None, department_id: int | None = None,
                 date_from: date | None = None, date_to: date | None = None, mine: bool = False):
        self.status, self.category_id, self.cost_centre_id, self.department_id = (
            status, category_id, cost_centre_id, department_id)
        self.date_from, self.date_to, self.mine = date_from, date_to, mine


def list_query(db: Session, user: User, p: ListParams, f: ExpenseFilters):
    if not f.mine and not can(db, user, "expenses", "view"):
        raise AppError(403, "forbidden", "You can only list your own expenses (mine=true)")
    q = apply_filters(select(Expense), Expense, p, SEARCH, SORTS, Expense.id.desc())
    for k in ("status", "category_id", "cost_centre_id", "department_id"):
        if getattr(f, k) is not None:
            q = q.where(getattr(Expense, k) == getattr(f, k))
    if f.date_from:
        q = q.where(Expense.expense_date >= f.date_from)
    if f.date_to:
        q = q.where(Expense.expense_date <= f.date_to)
    if f.mine:
        q = q.where(Expense.created_by_id == user.id)
    return q


@router.get("", response_model=Page[ExpenseOut])
def list_expenses(db: DB, user: CurrentUser, p: Annotated[ListParams, Depends()],
                  f: Annotated[ExpenseFilters, Depends()]):
    page = paginate(db, list_query(db, user, p, f), p)
    page["items"] = outs(db, page["items"])
    return page


@router.get("/export")
def export_expenses(db: DB, p: Annotated[ListParams, Depends()], f: Annotated[ExpenseFilters, Depends()],
                    format: str = "csv", user: User = require_access("expenses", "export")):
    rows = [ExpenseOut.model_validate(e).model_dump() for e in db.scalars(list_query(db, user, p, f))]
    cols = [("number", "Number"), ("expense_date", "Date"), ("description", "Description"), ("payee", "Payee"),
            ("amount", "Amount"), ("tax_amount", "Tax"), ("status", "Status"), ("payment_method", "Method")]
    return export_response(db, rows, cols, format, "expenses", "expenses")


@router.get("/{expense_id}", response_model=ExpenseOut)
def read_expense(expense_id: int, db: DB, user: CurrentUser):
    return out(db, get_expense(db, user, expense_id))


@router.post("", response_model=ExpenseOut, status_code=201)
def submit_expense(body: ExpenseIn, db: DB, _: User = CREATE):
    validate_refs(db, body)
    e = Expense(number=next_number(db, "expense"), status="submitted",
                **{**body.model_dump(), "expense_date": body.expense_date or local_today()})
    db.add(e)
    audit(db, "create", e)
    return out(db, e)


@router.put("/{expense_id}", response_model=ExpenseOut)
def update_expense(expense_id: int, body: ExpenseIn, db: DB, user: CurrentUser):
    e = get_expense(db, user, expense_id)
    if e.status != "submitted":
        raise AppError(409, "decided", f"This expense is already {e.status}")
    if e.created_by_id != user.id and not can(db, user, "expenses", "edit"):
        raise AppError(403, "forbidden", "Only the submitter or an editor can change this expense")
    validate_refs(db, body)
    before = snapshot(e)
    for k, v in body.model_dump().items():
        setattr(e, k, v if not (k == "expense_date" and v is None) else e.expense_date)
    audit(db, "update", e, before=before)
    return out(db, e)


def decide(db: Session, user: User, e: Expense, status: str, note: str | None) -> None:
    if e.status != "submitted":
        raise AppError(409, "decided", f"This expense is already {e.status}")
    if e.created_by_id == user.id:
        raise AppError(403, "own_expense", "You can't approve or reject your own expense")
    limit = get_company(db).expense_approval_limit
    if status == "approved" and limit is not None and e.amount > limit and not user.is_owner:
        raise AppError(403, "over_limit", f"Expenses over {limit} need an owner's approval")
    if status == "approved":
        from app.accounting.router import check_budget  # accounting builds on expenses

        check_budget(db, user, e)
    e.status, e.decided_by_id, e.decided_at, e.decision_note = status, user.id, utcnow(), note
    audit(db, status, entity_type="expenses", entity_id=e.id, note=note)


@router.post("/{expense_id}/approve", response_model=ExpenseOut)
def approve(expense_id: int, body: DecisionIn, db: DB, user: User = APPROVE):
    e = get_expense(db, user, expense_id)
    decide(db, user, e, "approved", body.note)
    return out(db, e)


@router.post("/{expense_id}/reject", response_model=ExpenseOut)
def reject(expense_id: int, body: DecisionIn, db: DB, user: User = APPROVE):
    if not body.note:
        raise AppError(422, "reason_required", "Say why it's rejected", {"note": "required"})
    e = get_expense(db, user, expense_id)
    decide(db, user, e, "rejected", body.note)
    return out(db, e)


@router.post("/{expense_id}/cancel", response_model=ExpenseOut)
def cancel(expense_id: int, db: DB, user: CurrentUser):
    e = get_expense(db, user, expense_id)
    if e.status != "submitted" or (e.created_by_id != user.id and not can(db, user, "expenses", "edit")):
        raise AppError(409, "not_cancellable", "Only your own submitted expenses can be cancelled")
    e.status = "cancelled"
    audit(db, "cancel", entity_type="expenses", entity_id=e.id)
    return out(db, e)


crud_routers = [
    crud_router(ExpenseCategory, prefix="/expense-categories", feature="settings", create=CategoryIn,
                update=CategoryIn, out=CategoryOut, search=(ExpenseCategory.name,),
                filters={"parent_id": ExpenseCategory.parent_id}, default_sort=ExpenseCategory.name,
                tags=["expenses"]),
    crud_router(CostCentre, prefix="/cost-centres", feature="settings", create=CostCentreIn, update=CostCentrePatch,
                out=CostCentreOut, search=(CostCentre.code, CostCentre.name), default_sort=CostCentre.code,
                tags=["expenses"]),
]
routers = [router, *crud_routers]
