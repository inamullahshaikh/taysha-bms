from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import BigInteger, Boolean, CheckConstraint, Date, DateTime, ForeignKey, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, Entity, Money

ACCOUNT_TYPES = ("asset", "liability", "equity", "income", "expense")

# code -> (name, type). System accounts the automatic postings use; more can be added freely.
SYSTEM_ACCOUNTS: dict[str, tuple[str, str]] = {
    "1000": ("Cash in hand", "asset"),
    "1010": ("Bank", "asset"),
    "1020": ("Card & online payments clearing", "asset"),
    "1100": ("Accounts receivable", "asset"),
    "1200": ("Inventory", "asset"),
    "1210": ("Inventory in transit", "asset"),
    "1220": ("Work in progress", "asset"),
    "1300": ("Input sales tax", "asset"),
    "1400": ("Fixed assets", "asset"),
    "1410": ("Accumulated depreciation", "asset"),
    "2000": ("Accounts payable", "liability"),
    "2010": ("Goods received not invoiced", "liability"),
    "2100": ("Sales tax payable", "liability"),
    "2110": ("Withholding tax payable", "liability"),
    "2200": ("Expense claims payable", "liability"),
    "2300": ("Partner loans", "liability"),
    "3000": ("Partner capital", "equity"),
    "3100": ("Opening balance equity", "equity"),
    "3200": ("Retained earnings", "equity"),
    "3300": ("Partner drawings & distributions", "equity"),
    "4000": ("Sales", "income"),
    "4010": ("Delivery income", "income"),
    "4020": ("Sales returns", "income"),
    "4900": ("Rounding", "income"),
    "4910": ("Inventory gains", "income"),
    "5000": ("Cost of goods sold", "expense"),
    "5010": ("Inventory write-offs", "expense"),
    "5020": ("Samples & promotions", "expense"),
    "5030": ("Stock count differences", "expense"),
    "5040": ("Production labour & overhead absorbed", "expense"),
    "6000": ("General expenses", "expense"),
    "6100": ("Depreciation", "expense"),
}


class Account(Entity, Base):
    __tablename__ = "accounts"
    code: Mapped[str] = mapped_column(String(20), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    type: Mapped[str] = mapped_column(String(20))  # ACCOUNT_TYPES
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id"))
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)
    description: Mapped[str | None] = mapped_column(Text)


class JournalEntry(Entity, Base):
    __tablename__ = "journal_entries"
    __table_args__ = (
        Index("uq_journal_source", "source_type", "source_id", "kind", unique=True,
              postgresql_where="source_type IS NOT NULL"),
    )
    number: Mapped[str | None] = mapped_column(String(30), unique=True)
    entry_date: Mapped[date] = mapped_column(Date, index=True)
    status: Mapped[str] = mapped_column(String(10), default="posted")  # draft | posted | rejected
    source_type: Mapped[str | None] = mapped_column(String(30))  # order, invoice, payment, stock_movement, ...
    source_id: Mapped[int | None] = mapped_column(BigInteger)
    kind: Mapped[str] = mapped_column(String(10), default="main")  # main | reverse | extra
    memo: Mapped[str | None] = mapped_column(Text)
    is_manual: Mapped[bool] = mapped_column(Boolean, default=False)
    approved_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class JournalLine(Base):
    __tablename__ = "journal_lines"
    __table_args__ = (CheckConstraint("debit >= 0 AND credit >= 0", name="non_negative"),)
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    entry_id: Mapped[int] = mapped_column(ForeignKey("journal_entries.id", ondelete="CASCADE"), index=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), index=True)
    debit: Mapped[Money] = mapped_column(default=Decimal(0))
    credit: Mapped[Money] = mapped_column(default=Decimal(0))
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("customers.id"), index=True)
    supplier_id: Mapped[int | None] = mapped_column(ForeignKey("suppliers.id"), index=True)
    cost_centre_id: Mapped[int | None] = mapped_column(ForeignKey("cost_centres.id"))
    memo: Mapped[str | None] = mapped_column(String(255))


class Budget(Entity, Base):
    __tablename__ = "budgets"
    name: Mapped[str] = mapped_column(String(120))
    period_start: Mapped[date] = mapped_column(Date)
    period_end: Mapped[date] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)


class BudgetLine(Base):
    __tablename__ = "budget_lines"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    budget_id: Mapped[int] = mapped_column(ForeignKey("budgets.id", ondelete="CASCADE"), index=True)
    category_id: Mapped[int | None] = mapped_column(ForeignKey("expense_categories.id"))
    cost_centre_id: Mapped[int | None] = mapped_column(ForeignKey("cost_centres.id"))
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id"))
    amount: Mapped[Money]
    hard_limit: Mapped[bool] = mapped_column(Boolean, default=False)  # block approvals beyond it (owners excepted)
