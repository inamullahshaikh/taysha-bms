from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger, Date, DateTime, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, Entity, Qty

DEFAULT_STAGES = ("Mixing", "Filling", "Packing", "Labelling", "Quality Check")


class Recipe(Entity, Base):
    """Bill of materials for one batch of a product. Versions are never edited once active."""

    __tablename__ = "recipes"
    __table_args__ = (
        UniqueConstraint("product_id", "version"),
        Index("uq_recipes_one_active", "product_id", unique=True, postgresql_where="status = 'active'"),
    )
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default="draft")  # draft | active | superseded
    yield_quantity: Mapped[Qty]  # output per batch, in the product's base unit
    expected_wastage_pct: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal(0))
    labour_minutes: Mapped[int | None] = mapped_column(Integer)  # standard labour per batch
    instructions: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    approved_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RecipeLine(Base):
    __tablename__ = "recipe_lines"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    recipe_id: Mapped[int] = mapped_column(ForeignKey("recipes.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))  # ingredient / packaging
    quantity: Mapped[Qty]  # per batch, in `unit`
    unit: Mapped[str | None] = mapped_column(String(40))
    base_quantity: Mapped[Qty]  # in the component's base unit
    wastage_pct: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal(0))
    note: Mapped[str | None] = mapped_column(String(255))


class ProductionOrder(Entity, Base):
    __tablename__ = "production_orders"
    number: Mapped[str] = mapped_column(String(30), unique=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    recipe_id: Mapped[int] = mapped_column(ForeignKey("recipes.id"))
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"))
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    # draft -> released (materials reserved) -> in_progress (materials issued) -> completed | cancelled
    planned_quantity: Mapped[Qty]
    planned_start: Mapped[date | None] = mapped_column(Date, index=True)
    due_date: Mapped[date | None] = mapped_column(Date)
    assigned_to_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    output_quantity: Mapped[Decimal | None] = mapped_column(Numeric(14, 3))
    rejected_quantity: Mapped[Decimal | None] = mapped_column(Numeric(14, 3))
    wastage_quantity: Mapped[Decimal | None] = mapped_column(Numeric(14, 3))
    labour_minutes: Mapped[int | None] = mapped_column(Integer)
    batch_id: Mapped[int | None] = mapped_column(ForeignKey("batches.id"))
    planned_cost: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    material_cost: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    labour_cost: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    overhead_cost: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    actual_cost: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    source: Mapped[str | None] = mapped_column(String(30))  # manual | suggestion | backorder
    notes: Mapped[str | None] = mapped_column(Text)
    cancelled_reason: Mapped[str | None] = mapped_column(Text)


class ProductionMaterial(Base):
    __tablename__ = "production_materials"
    __table_args__ = (UniqueConstraint("production_order_id", "product_id"),)
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    production_order_id: Mapped[int] = mapped_column(ForeignKey("production_orders.id", ondelete="CASCADE"),
                                                     index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    required_quantity: Mapped[Qty]  # base unit, incl. expected wastage
    issued_quantity: Mapped[Qty] = mapped_column(default=Decimal(0))
    actual_quantity: Mapped[Decimal | None] = mapped_column(Numeric(14, 3))  # recorded at completion


class ProductionStage(Base):
    __tablename__ = "production_stages"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    production_order_id: Mapped[int] = mapped_column(ForeignKey("production_orders.id", ondelete="CASCADE"),
                                                     index=True)
    seq: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(60))
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending | in_progress | done
    assigned_to_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    note: Mapped[str | None] = mapped_column(Text)


class QCTemplate(Entity, Base):
    __tablename__ = "qc_templates"
    name: Mapped[str] = mapped_column(String(120), unique=True)
    stage: Mapped[str] = mapped_column(String(20))  # incoming | production | finished
    checks: Mapped[list] = mapped_column(JSONB)  # [{"name", "type": pass_fail|number|text, "min", "max", "unit"}]


class QCCheck(Entity, Base):
    __tablename__ = "qc_checks"
    template_id: Mapped[int | None] = mapped_column(ForeignKey("qc_templates.id"))
    stage: Mapped[str] = mapped_column(String(20))
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"), index=True)
    batch_id: Mapped[int | None] = mapped_column(ForeignKey("batches.id"), index=True)
    production_order_id: Mapped[int | None] = mapped_column(ForeignKey("production_orders.id"), index=True)
    goods_receipt_id: Mapped[int | None] = mapped_column(ForeignKey("goods_receipts.id"))
    results: Mapped[list] = mapped_column(JSONB, default=list)  # [{"name", "value", "passed"}]
    result: Mapped[str] = mapped_column(String(10))  # pass | fail
    defects: Mapped[str | None] = mapped_column(Text)
    corrective_action: Mapped[str | None] = mapped_column(Text)


class Recall(Entity, Base):
    __tablename__ = "recalls"
    number: Mapped[str] = mapped_column(String(30), unique=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("batches.id"))
    reason: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="open")  # open | closed
    affected: Mapped[dict] = mapped_column(JSONB, default=dict)  # snapshot of the trace at recall time
    disposal_decision: Mapped[str | None] = mapped_column(Text)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class FoodSafetyRecord(Entity, Base):
    __tablename__ = "food_safety_records"
    kind: Mapped[str] = mapped_column(String(30), index=True)  # procedure|cleaning|inspection|temperature|pest_control|training
    title: Mapped[str] = mapped_column(String(200))
    record_date: Mapped[date] = mapped_column(Date, index=True)
    performed_by: Mapped[str | None] = mapped_column(String(120))
    area: Mapped[str | None] = mapped_column(String(120))
    result: Mapped[str | None] = mapped_column(String(20))  # ok | issue | n/a
    notes: Mapped[str | None] = mapped_column(Text)
    next_due_date: Mapped[date | None] = mapped_column(Date, index=True)
