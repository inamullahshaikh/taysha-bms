from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger, Date, DateTime, ForeignKey, Index, Numeric, String, Text, UniqueConstraint, func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, Entity, Qty

# Reasons a stock movement can have. Positive = stock in, negative = stock out.
REASONS = (
    "receipt", "purchase_receipt", "opening", "issue", "sale", "sample", "internal_use", "transfer_out",
    "transfer_in", "adjustment", "damage", "wastage", "expired", "count", "customer_return",
    "production_in", "production_out", "production_return", "supplier_return",
)
COSTED_IN = ("receipt", "purchase_receipt", "opening", "production_in")  # these carry a unit cost and move the average


class Warehouse(Entity, Base):
    __tablename__ = "warehouses"
    code: Mapped[str] = mapped_column(String(20), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    branch_id: Mapped[int | None] = mapped_column(ForeignKey("branches.id"))
    address: Mapped[str | None] = mapped_column(Text)


class Location(Entity, Base):
    """Shelf / bin inside a warehouse."""

    __tablename__ = "locations"
    __table_args__ = (UniqueConstraint("warehouse_id", "code"),)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"), index=True)
    code: Mapped[str] = mapped_column(String(30))
    name: Mapped[str | None] = mapped_column(String(120))
    barcode: Mapped[str | None] = mapped_column(String(64), unique=True)


class ReorderRule(Base):
    __tablename__ = "reorder_rules"
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), primary_key=True)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id", ondelete="CASCADE"), primary_key=True)
    min_qty: Mapped[Decimal | None] = mapped_column(Numeric(14, 3))
    reorder_point: Mapped[Decimal | None] = mapped_column(Numeric(14, 3))
    reorder_qty: Mapped[Decimal | None] = mapped_column(Numeric(14, 3))
    max_qty: Mapped[Decimal | None] = mapped_column(Numeric(14, 3))
    safety_stock: Mapped[Decimal | None] = mapped_column(Numeric(14, 3))


class Batch(Entity, Base):
    __tablename__ = "batches"
    __table_args__ = (UniqueConstraint("product_id", "number"),)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    number: Mapped[str] = mapped_column(String(60))
    mfg_date: Mapped[date | None] = mapped_column(Date)
    expiry_date: Mapped[date | None] = mapped_column(Date, index=True)
    supplier_id: Mapped[int | None] = mapped_column(ForeignKey("suppliers.id"))
    supplier_batch_no: Mapped[str | None] = mapped_column(String(60))
    status: Mapped[str] = mapped_column(String(20), default="available")  # available | hold | rejected
    notes: Mapped[str | None] = mapped_column(Text)


class StockBalance(Base):
    """Current quantity per product/warehouse/location/batch. Only app.inventory.service.move() writes it."""

    __tablename__ = "stock_balances"
    __table_args__ = (
        UniqueConstraint("product_id", "warehouse_id", "location_id", "batch_id",
                         name="uq_stock_balances_key", postgresql_nulls_not_distinct=True),
    )
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"), index=True)
    location_id: Mapped[int | None] = mapped_column(ForeignKey("locations.id"))
    batch_id: Mapped[int | None] = mapped_column(ForeignKey("batches.id"), index=True)
    quantity: Mapped[Qty] = mapped_column(default=Decimal(0))


class StockMovement(Base):
    """Append-only ledger. Never updated or deleted."""

    __tablename__ = "stock_movements"
    __table_args__ = (Index("ix_stock_movements_ref", "reference_type", "reference_id"),)
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    movement_date: Mapped[date] = mapped_column(Date, index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"), index=True)
    location_id: Mapped[int | None] = mapped_column(ForeignKey("locations.id"))
    batch_id: Mapped[int | None] = mapped_column(ForeignKey("batches.id"), index=True)
    quantity: Mapped[Qty]  # signed, in the product's base unit
    unit_cost: Mapped[Decimal | None] = mapped_column(Numeric(14, 4))
    balance_after: Mapped[Qty]  # product/warehouse/location/batch balance after this movement
    reason: Mapped[str] = mapped_column(String(30), index=True)
    reference_type: Mapped[str | None] = mapped_column(String(30))
    reference_id: Mapped[int | None] = mapped_column(BigInteger)
    reference_number: Mapped[str | None] = mapped_column(String(40))
    note: Mapped[str | None] = mapped_column(Text)
    user_id: Mapped[int | None] = mapped_column(BigInteger)


class ProductStockCost(Base):
    """Weighted average cost per product (company-wide), updated by costed receipts."""

    __tablename__ = "product_stock_costs"
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), primary_key=True)
    avg_cost: Mapped[Decimal] = mapped_column(Numeric(14, 4), default=Decimal(0))


class StockReservation(Base):
    """Stock held for a sales order line or a production order's materials."""

    __tablename__ = "stock_reservations"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"), index=True)
    order_line_id: Mapped[int | None] = mapped_column(ForeignKey("order_lines.id", ondelete="CASCADE"), index=True)
    production_order_id: Mapped[int | None] = mapped_column(ForeignKey("production_orders.id", ondelete="CASCADE"),
                                                            index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"))
    quantity: Mapped[Qty]


class Transfer(Entity, Base):
    __tablename__ = "stock_transfers"
    number: Mapped[str] = mapped_column(String(30), unique=True)
    from_warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"))
    to_warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"))
    status: Mapped[str] = mapped_column(String(20), default="draft")  # draft | in_transit | received | cancelled
    shipped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    note: Mapped[str | None] = mapped_column(Text)


class TransferLine(Base):
    __tablename__ = "stock_transfer_lines"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    transfer_id: Mapped[int] = mapped_column(ForeignKey("stock_transfers.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    batch_id: Mapped[int | None] = mapped_column(ForeignKey("batches.id"))
    quantity: Mapped[Qty]
    received_quantity: Mapped[Decimal | None] = mapped_column(Numeric(14, 3))


class StockCount(Entity, Base):
    __tablename__ = "stock_counts"
    number: Mapped[str] = mapped_column(String(30), unique=True)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"))
    status: Mapped[str] = mapped_column(String(20), default="open")  # open | submitted | approved | cancelled
    note: Mapped[str | None] = mapped_column(Text)
    approved_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class StockCountLine(Base):
    __tablename__ = "stock_count_lines"
    __table_args__ = (UniqueConstraint("count_id", "product_id", "location_id", "batch_id",
                                       postgresql_nulls_not_distinct=True),)
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    count_id: Mapped[int] = mapped_column(ForeignKey("stock_counts.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    location_id: Mapped[int | None] = mapped_column(ForeignKey("locations.id"))
    batch_id: Mapped[int | None] = mapped_column(ForeignKey("batches.id"))
    system_quantity: Mapped[Qty]  # snapshot when the count started
    counted_quantity: Mapped[Decimal | None] = mapped_column(Numeric(14, 3))
    counted_by_id: Mapped[int | None] = mapped_column(BigInteger)
