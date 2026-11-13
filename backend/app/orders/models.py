from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger, Boolean, Date, DateTime, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, Entity, Money, Qty

ORDER_TYPES = ("retail", "wholesale", "corporate", "cafe", "stall", "sample", "promotional", "replacement")
ORDER_STATUSES = ("draft", "confirmed", "processing", "packed", "dispatched", "delivered", "cancelled", "returned",
                  "refunded")
PAYMENT_STATUSES = ("unpaid", "partially_paid", "paid", "cod_pending", "refunded", "failed")
PAYMENT_METHODS = ("cash", "card", "bank_transfer", "cod", "online", "cheque", "other")

# status -> statuses it may move to (returns/refunds are driven by the returns module later)
TRANSITIONS: dict[str, tuple[str, ...]] = {
    "draft": ("confirmed", "cancelled"),
    "confirmed": ("draft", "processing", "packed", "dispatched", "delivered", "cancelled"),
    "processing": ("packed", "dispatched", "cancelled"),
    "packed": ("processing", "dispatched", "cancelled"),
    "dispatched": ("delivered", "returned"),
    "delivered": ("returned", "refunded"),
    "returned": ("refunded",),
    "cancelled": (),
    "refunded": (),
}


class Order(Entity, Base):
    __tablename__ = "orders"
    __table_args__ = (UniqueConstraint("source", "external_id", name="uq_orders_source_external_id"),)

    number: Mapped[str] = mapped_column(String(30), unique=True)
    order_date: Mapped[date] = mapped_column(Date, index=True)
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("customers.id"), index=True)
    customer_name: Mapped[str | None] = mapped_column(String(200))  # snapshot for search/printing
    customer_phone: Mapped[str | None] = mapped_column(String(30))
    order_type: Mapped[str] = mapped_column(String(20), default="retail")
    channel: Mapped[str | None] = mapped_column(String(30), index=True)
    source: Mapped[str] = mapped_column(String(20), default="manual")  # manual | shopify | pos | import
    external_id: Mapped[str | None] = mapped_column(String(100))
    price_list_id: Mapped[int | None] = mapped_column(ForeignKey("price_lists.id"))
    branch_id: Mapped[int | None] = mapped_column(ForeignKey("branches.id"))
    warehouse_id: Mapped[int | None] = mapped_column(ForeignKey("warehouses.id"))
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    fulfilment_status: Mapped[str] = mapped_column(String(20), default="unfulfilled",
                                                   server_default="unfulfilled")  # unfulfilled|partial|fulfilled
    payment_status: Mapped[str] = mapped_column(String(20), default="unpaid", index=True)
    payment_method: Mapped[str | None] = mapped_column(String(20))
    delivery_method: Mapped[str] = mapped_column(String(20), default="delivery")  # delivery | pickup
    shipping_address: Mapped[dict | None] = mapped_column(JSONB)  # snapshot
    billing_address: Mapped[dict | None] = mapped_column(JSONB)
    discount_code_id: Mapped[int | None] = mapped_column(ForeignKey("discount_codes.id"))
    order_discount_pct: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal(0))
    order_discount_amount: Mapped[Money] = mapped_column(default=Decimal(0))
    subtotal: Mapped[Money] = mapped_column(default=Decimal(0))
    discount_total: Mapped[Money] = mapped_column(default=Decimal(0))
    tax_total: Mapped[Money] = mapped_column(default=Decimal(0))
    net_total: Mapped[Money] = mapped_column(default=Decimal(0))
    delivery_charge: Mapped[Money] = mapped_column(default=Decimal(0))
    rounding: Mapped[Money] = mapped_column(default=Decimal(0))
    grand_total: Mapped[Money] = mapped_column(default=Decimal(0))
    paid_total: Mapped[Money] = mapped_column(default=Decimal(0))
    notes: Mapped[str | None] = mapped_column(Text)  # shown to the customer
    internal_notes: Mapped[str | None] = mapped_column(Text)
    customer_instructions: Mapped[str | None] = mapped_column(Text)
    courier: Mapped[str | None] = mapped_column(String(80))
    tracking_number: Mapped[str | None] = mapped_column(String(100))
    delivery_status: Mapped[str | None] = mapped_column(String(50))  # free text from courier
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_reason: Mapped[str | None] = mapped_column(Text)

    @property
    def balance_due(self) -> Decimal:
        return self.grand_total - self.paid_total


class OrderLine(Base):
    __tablename__ = "order_lines"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"), index=True)
    line_no: Mapped[int] = mapped_column(Integer)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    sku: Mapped[str] = mapped_column(String(60))  # snapshots
    description: Mapped[str] = mapped_column(String(255))
    quantity: Mapped[Qty]
    unit_price: Mapped[Money]  # tax-inclusive
    list_price: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))  # price-list price at the time
    price_overridden: Mapped[bool] = mapped_column(Boolean, default=False)
    discount_pct: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal(0))
    discount_amount: Mapped[Money] = mapped_column(default=Decimal(0))
    line_discount: Mapped[Money] = mapped_column(default=Decimal(0))
    order_discount_share: Mapped[Money] = mapped_column(default=Decimal(0))
    tax_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2))
    tax_amount: Mapped[Money]
    net_amount: Mapped[Money]
    line_total: Mapped[Money]  # incl. tax, after all discounts
    unit_cost: Mapped[Decimal | None] = mapped_column(Numeric(14, 4))  # standard cost, then actual once shipped
    cost_from_stock: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    shipped_qty: Mapped[Qty] = mapped_column(default=Decimal(0), server_default="0")


class OrderStatusHistory(Base):
    __tablename__ = "order_status_history"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"), index=True)
    from_status: Mapped[str | None] = mapped_column(String(20))
    to_status: Mapped[str] = mapped_column(String(20))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    user_id: Mapped[int | None] = mapped_column(BigInteger)
    note: Mapped[str | None] = mapped_column(Text)


class Payment(Entity, Base):
    """Money received from (kind=payment) or returned to (kind=refund) a customer."""

    __tablename__ = "payments"
    __table_args__ = (Index("ix_payments_order", "order_id"),)

    number: Mapped[str] = mapped_column(String(30), unique=True)
    kind: Mapped[str] = mapped_column(String(10), default="payment")  # payment | refund
    status: Mapped[str] = mapped_column(String(10), default="completed")  # completed | failed
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("customers.id"), index=True)
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"))
    invoice_id: Mapped[int | None] = mapped_column(ForeignKey("sales_documents.id"), index=True)
    payment_date: Mapped[date] = mapped_column(Date)
    method: Mapped[str] = mapped_column(String(20))
    amount: Mapped[Money]  # always positive
    reference: Mapped[str | None] = mapped_column(String(100))
    note: Mapped[str | None] = mapped_column(Text)


class DiscountCode(Entity, Base):
    __tablename__ = "discount_codes"

    code: Mapped[str] = mapped_column(String(40), unique=True)  # stored upper-case
    description: Mapped[str | None] = mapped_column(String(255))
    kind: Mapped[str] = mapped_column(String(10))  # percent | fixed
    value: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    valid_from: Mapped[date | None] = mapped_column(Date)
    valid_to: Mapped[date | None] = mapped_column(Date)
    min_order_amount: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    max_uses: Mapped[int | None] = mapped_column(Integer)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Shipment(Entity, Base):
    __tablename__ = "shipments"

    number: Mapped[str] = mapped_column(String(30), unique=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    warehouse_id: Mapped[int | None] = mapped_column(ForeignKey("warehouses.id"))
    status: Mapped[str] = mapped_column(String(20), default="dispatched")  # dispatched | delivered | returned
    courier: Mapped[str | None] = mapped_column(String(80))
    tracking_number: Mapped[str | None] = mapped_column(String(100))
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    proof_of_delivery_id: Mapped[int | None] = mapped_column(BigInteger)  # attachment id


class ShipmentLine(Base):
    __tablename__ = "shipment_lines"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    shipment_id: Mapped[int] = mapped_column(ForeignKey("shipments.id", ondelete="CASCADE"), index=True)
    order_line_id: Mapped[int] = mapped_column(ForeignKey("order_lines.id"))
    quantity: Mapped[Qty]
