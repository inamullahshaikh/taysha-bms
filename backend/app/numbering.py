"""Gap-free, unique document numbers (INV-2026-00001). The row lock serialises concurrent requests and a
rollback gives the number back, so numbers are never skipped or reused."""

from sqlalchemy import Boolean, Integer, String, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.clock import local_today
from app.db import Base

# doc_type -> (prefix, label)
DOC_TYPES: dict[str, tuple[str, str]] = {
    "order": ("SO-", "Sales order"),
    "invoice": ("INV-", "Invoice"),
    "quotation": ("QT-", "Quotation"),
    "proforma": ("PI-", "Pro-forma invoice"),
    "receipt": ("RCT-", "Receipt"),
    "credit_note": ("CN-", "Credit note"),
    "debit_note": ("DN-", "Debit note"),
    "delivery_challan": ("DC-", "Delivery challan"),
    "payment": ("PAY-", "Payment"),
    "expense": ("EXP-", "Expense"),
    "purchase_request": ("PR-", "Purchase request"),
    "purchase_order": ("PO-", "Purchase order"),
    "goods_receipt": ("GRN-", "Goods receipt"),
    "supplier_bill": ("BILL-", "Supplier bill"),
    "supplier_payment": ("SPAY-", "Supplier payment"),
    "stock_transfer": ("TRF-", "Stock transfer"),
    "stock_adjustment": ("ADJ-", "Stock adjustment"),
    "stock_count": ("CNT-", "Stock count"),
    "shipment": ("SHP-", "Shipment"),
    "return": ("RET-", "Return"),
    "complaint": ("CMP-", "Complaint"),
    "production_order": ("MO-", "Production order"),
    "batch": ("B-", "Batch / lot"),
    "pos_sale": ("POS-", "POS sale"),
    "recall": ("RCL-", "Recall"),
    "route": ("RT-", "Delivery route"),
}


class NumberSequence(Base):
    __tablename__ = "number_sequences"

    doc_type: Mapped[str] = mapped_column(String(30), primary_key=True)
    prefix: Mapped[str] = mapped_column(String(20))
    padding: Mapped[int] = mapped_column(Integer, default=5)
    yearly_reset: Mapped[bool] = mapped_column(Boolean, default=True)  # adds the year: INV-2026-00001
    year: Mapped[int | None] = mapped_column(Integer)
    next_value: Mapped[int] = mapped_column(Integer, default=1)


def get_sequence(db: Session, doc_type: str, lock: bool = False) -> NumberSequence:
    if doc_type not in DOC_TYPES:
        raise ValueError(f"Unknown document type {doc_type}")
    db.execute(insert(NumberSequence).values(doc_type=doc_type, prefix=DOC_TYPES[doc_type][0], padding=5,
                                             yearly_reset=True, next_value=1).on_conflict_do_nothing())
    q = select(NumberSequence).where(NumberSequence.doc_type == doc_type)
    return db.scalar(q.with_for_update() if lock else q)


def format_number(seq: NumberSequence, n: int, year: int) -> str:
    return f"{seq.prefix}{year}-{n:0{seq.padding}d}" if seq.yearly_reset else f"{seq.prefix}{n:0{seq.padding}d}"


def next_number(db: Session, doc_type: str) -> str:
    seq = get_sequence(db, doc_type, lock=True)
    year = local_today().year
    if seq.yearly_reset and seq.year != year:
        seq.year, seq.next_value = year, 1
    n = seq.next_value
    seq.next_value = n + 1
    db.flush()
    return format_number(seq, n, year)
