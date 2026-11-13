from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import BigInteger, Date, DateTime, ForeignKey, Index, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, Entity, Money, Qty

DOC_TYPES = ("invoice", "quotation", "proforma", "receipt", "credit_note", "debit_note", "delivery_challan")

# status values per document type
STATUSES = {
    "invoice": ("draft", "issued", "partially_paid", "paid", "overdue", "cancelled", "credited"),
    "quotation": ("draft", "issued", "accepted", "rejected", "expired", "converted"),
    "proforma": ("draft", "issued", "cancelled"),
    "receipt": ("issued", "cancelled"),
    "credit_note": ("draft", "issued", "cancelled"),
    "debit_note": ("draft", "issued", "cancelled"),
    "delivery_challan": ("draft", "issued", "cancelled"),
}


class SalesDocument(Entity, Base):
    """Invoices, quotations, pro-formas, receipts, credit/debit notes and delivery challans.

    Drafts have no number. Issuing assigns the number and freezes the document; corrections are made with
    credit/debit notes, never by editing.
    """

    __tablename__ = "sales_documents"
    __table_args__ = (Index("ix_sales_documents_type_status", "doc_type", "status"),)

    doc_type: Mapped[str] = mapped_column(String(20))
    number: Mapped[str | None] = mapped_column(String(30), unique=True)
    status: Mapped[str] = mapped_column(String(20), default="draft")
    doc_date: Mapped[date] = mapped_column(Date, index=True)
    due_date: Mapped[date | None] = mapped_column(Date)
    valid_until: Mapped[date | None] = mapped_column(Date)  # quotations
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"), index=True)
    payment_id: Mapped[int | None] = mapped_column(ForeignKey("payments.id", use_alter=True))  # receipts
    related_document_id: Mapped[int | None] = mapped_column(ForeignKey("sales_documents.id"), index=True)
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("customers.id"), index=True)
    customer_name: Mapped[str | None] = mapped_column(String(200))
    customer_phone: Mapped[str | None] = mapped_column(String(30))
    customer_email: Mapped[str | None] = mapped_column(String(254))
    customer_ntn: Mapped[str | None] = mapped_column(String(50))
    customer_strn: Mapped[str | None] = mapped_column(String(50))
    billing_address: Mapped[dict | None] = mapped_column(JSONB)
    shipping_address: Mapped[dict | None] = mapped_column(JSONB)
    order_discount_pct: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal(0))
    order_discount_amount: Mapped[Money] = mapped_column(default=Decimal(0))
    delivery_charge: Mapped[Money] = mapped_column(default=Decimal(0))
    other_charges: Mapped[list] = mapped_column(JSONB, default=list)  # [{"label": "...", "amount": "100.00"}]
    subtotal: Mapped[Money] = mapped_column(default=Decimal(0))
    discount_total: Mapped[Money] = mapped_column(default=Decimal(0))
    tax_total: Mapped[Money] = mapped_column(default=Decimal(0))
    net_total: Mapped[Money] = mapped_column(default=Decimal(0))
    charges_total: Mapped[Money] = mapped_column(default=Decimal(0))  # delivery + other charges
    rounding: Mapped[Money] = mapped_column(default=Decimal(0))
    grand_total: Mapped[Money] = mapped_column(default=Decimal(0))
    paid_total: Mapped[Money] = mapped_column(default=Decimal(0))
    credited_total: Mapped[Money] = mapped_column(default=Decimal(0))
    notes: Mapped[str | None] = mapped_column(Text)
    terms: Mapped[str | None] = mapped_column(Text)
    issued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_reason: Mapped[str | None] = mapped_column(Text)

    @property
    def balance_due(self) -> Decimal:
        return self.grand_total - self.paid_total - self.credited_total


class SalesDocumentLine(Base):
    __tablename__ = "sales_document_lines"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    document_id: Mapped[int] = mapped_column(ForeignKey("sales_documents.id", ondelete="CASCADE"), index=True)
    line_no: Mapped[int] = mapped_column(Integer)
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"))  # null for free-text lines
    sku: Mapped[str | None] = mapped_column(String(60))
    description: Mapped[str] = mapped_column(String(255))
    quantity: Mapped[Qty]
    unit_price: Mapped[Money]
    discount_pct: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal(0))
    discount_amount: Mapped[Money] = mapped_column(default=Decimal(0))
    line_discount: Mapped[Money] = mapped_column(default=Decimal(0))
    order_discount_share: Mapped[Money] = mapped_column(default=Decimal(0))
    tax_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2))
    tax_amount: Mapped[Money]
    net_amount: Mapped[Money]
    line_total: Mapped[Money]
