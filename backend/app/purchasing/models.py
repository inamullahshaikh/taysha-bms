from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import BigInteger, Date, DateTime, ForeignKey, Integer, Numeric, SmallInteger, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, Entity, Money, Qty

PO_STATUSES = ("draft", "requested", "approved", "ordered", "partially_received", "received", "cancelled")


class PurchaseRequest(Entity, Base):
    __tablename__ = "purchase_requests"
    number: Mapped[str] = mapped_column(String(30), unique=True)
    status: Mapped[str] = mapped_column(String(20), default="requested")  # requested|approved|rejected|converted|cancelled
    needed_by: Mapped[date | None] = mapped_column(Date)
    warehouse_id: Mapped[int | None] = mapped_column(ForeignKey("warehouses.id"))
    note: Mapped[str | None] = mapped_column(Text)
    estimated_total: Mapped[Money] = mapped_column(default=Decimal(0))
    decided_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decision_note: Mapped[str | None] = mapped_column(Text)


class PurchaseRequestLine(Base):
    __tablename__ = "purchase_request_lines"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey("purchase_requests.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    quantity: Mapped[Qty]
    unit: Mapped[str | None] = mapped_column(String(40))
    estimated_unit_cost: Mapped[Decimal | None] = mapped_column(Numeric(14, 4))
    suggested_supplier_id: Mapped[int | None] = mapped_column(ForeignKey("suppliers.id"))
    note: Mapped[str | None] = mapped_column(String(255))


class PurchaseOrder(Entity, Base):
    __tablename__ = "purchase_orders"
    number: Mapped[str] = mapped_column(String(30), unique=True)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    order_date: Mapped[date] = mapped_column(Date, index=True)
    expected_date: Mapped[date | None] = mapped_column(Date)
    warehouse_id: Mapped[int | None] = mapped_column(ForeignKey("warehouses.id"))
    purchase_request_id: Mapped[int | None] = mapped_column(ForeignKey("purchase_requests.id"))
    subtotal: Mapped[Money] = mapped_column(default=Decimal(0))  # excl. tax
    tax_total: Mapped[Money] = mapped_column(default=Decimal(0))
    grand_total: Mapped[Money] = mapped_column(default=Decimal(0))
    notes: Mapped[str | None] = mapped_column(Text)
    terms: Mapped[str | None] = mapped_column(Text)
    approved_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ordered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_reason: Mapped[str | None] = mapped_column(Text)


class PurchaseOrderLine(Base):
    __tablename__ = "purchase_order_lines"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    purchase_order_id: Mapped[int] = mapped_column(ForeignKey("purchase_orders.id", ondelete="CASCADE"), index=True)
    line_no: Mapped[int] = mapped_column(Integer)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    description: Mapped[str] = mapped_column(String(255))
    quantity: Mapped[Qty]  # in `unit`
    unit: Mapped[str | None] = mapped_column(String(40))
    base_quantity: Mapped[Qty]  # in the product's stock unit
    unit_cost: Mapped[Decimal] = mapped_column(Numeric(14, 4))  # per `unit`, excl. tax
    tax_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal(0))
    tax_amount: Mapped[Money]
    line_total: Mapped[Money]  # incl. tax
    received_base_qty: Mapped[Qty] = mapped_column(default=Decimal(0))
    billed_quantity: Mapped[Qty] = mapped_column(default=Decimal(0))  # in `unit`


class GoodsReceipt(Entity, Base):
    __tablename__ = "goods_receipts"
    number: Mapped[str] = mapped_column(String(30), unique=True)
    purchase_order_id: Mapped[int | None] = mapped_column(ForeignKey("purchase_orders.id"), index=True)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"), index=True)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"))
    received_date: Mapped[date] = mapped_column(Date)
    supplier_delivery_note: Mapped[str | None] = mapped_column(String(100))
    note: Mapped[str | None] = mapped_column(Text)


class GoodsReceiptLine(Base):
    __tablename__ = "goods_receipt_lines"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    receipt_id: Mapped[int] = mapped_column(ForeignKey("goods_receipts.id", ondelete="CASCADE"), index=True)
    po_line_id: Mapped[int | None] = mapped_column(ForeignKey("purchase_order_lines.id"))
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    quantity: Mapped[Qty]
    unit: Mapped[str | None] = mapped_column(String(40))
    base_quantity: Mapped[Qty]
    unit_cost: Mapped[Decimal | None] = mapped_column(Numeric(14, 4))  # per base unit, excl. tax
    batch_id: Mapped[int | None] = mapped_column(ForeignKey("batches.id"))
    supplier_batch_no: Mapped[str | None] = mapped_column(String(60))
    expiry_date: Mapped[date | None] = mapped_column(Date)
    qc_result: Mapped[str] = mapped_column(String(10), default="pass")  # pass | fail | pending
    qc_note: Mapped[str | None] = mapped_column(Text)


class SupplierBill(Entity, Base):
    __tablename__ = "supplier_bills"
    number: Mapped[str] = mapped_column(String(30), unique=True)
    supplier_invoice_number: Mapped[str | None] = mapped_column(String(60))
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"), index=True)
    purchase_order_id: Mapped[int | None] = mapped_column(ForeignKey("purchase_orders.id"), index=True)
    bill_date: Mapped[date] = mapped_column(Date, index=True)
    due_date: Mapped[date | None] = mapped_column(Date, index=True)
    subtotal: Mapped[Money] = mapped_column(default=Decimal(0))
    tax_total: Mapped[Money] = mapped_column(default=Decimal(0))
    withholding_tax: Mapped[Money] = mapped_column(default=Decimal(0))
    grand_total: Mapped[Money] = mapped_column(default=Decimal(0))
    paid_total: Mapped[Money] = mapped_column(default=Decimal(0))
    status: Mapped[str] = mapped_column(String(20), default="unpaid", index=True)
    notes: Mapped[str | None] = mapped_column(Text)
    cancelled_reason: Mapped[str | None] = mapped_column(Text)

    @property
    def balance_due(self) -> Decimal:
        return self.grand_total - self.withholding_tax - self.paid_total


class SupplierBillLine(Base):
    __tablename__ = "supplier_bill_lines"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    bill_id: Mapped[int] = mapped_column(ForeignKey("supplier_bills.id", ondelete="CASCADE"), index=True)
    po_line_id: Mapped[int | None] = mapped_column(ForeignKey("purchase_order_lines.id"))
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"))
    description: Mapped[str] = mapped_column(String(255))
    quantity: Mapped[Qty]
    unit_cost: Mapped[Decimal] = mapped_column(Numeric(14, 4))
    tax_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal(0))
    tax_amount: Mapped[Money]
    line_total: Mapped[Money]


class SupplierPayment(Entity, Base):
    __tablename__ = "supplier_payments"
    number: Mapped[str] = mapped_column(String(30), unique=True)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"), index=True)
    bill_id: Mapped[int | None] = mapped_column(ForeignKey("supplier_bills.id"), index=True)
    payment_date: Mapped[date] = mapped_column(Date)
    method: Mapped[str] = mapped_column(String(20))
    amount: Mapped[Money]
    reference: Mapped[str | None] = mapped_column(String(100))
    note: Mapped[str | None] = mapped_column(Text)


class SupplierRating(Entity, Base):
    __tablename__ = "supplier_ratings"
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"), index=True)
    rated_on: Mapped[date] = mapped_column(Date)
    price: Mapped[int] = mapped_column(SmallInteger)  # 1..5
    quality: Mapped[int] = mapped_column(SmallInteger)
    delivery: Mapped[int] = mapped_column(SmallInteger)
    reliability: Mapped[int] = mapped_column(SmallInteger)
    note: Mapped[str | None] = mapped_column(Text)
