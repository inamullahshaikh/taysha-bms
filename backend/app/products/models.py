from datetime import date
from decimal import Decimal

from sqlalchemy import BigInteger, Boolean, Date, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, Entity, Money, Qty

PRODUCT_TYPES = ("finished", "raw", "packaging", "consumable", "spare")
PRODUCT_KINDS = ("standard", "bundle", "sample", "promo")
PRODUCT_STATUSES = ("draft", "active", "discontinued")


class SalesChannel(Entity, Base):
    __tablename__ = "sales_channels"
    code: Mapped[str] = mapped_column(String(30), unique=True)
    name: Mapped[str] = mapped_column(String(80))


class PriceList(Entity, Base):
    """Retail, wholesale, cafe, distributor... and later customer-specific lists. Prices are tax-inclusive."""

    __tablename__ = "price_lists"
    code: Mapped[str] = mapped_column(String(30), unique=True)
    name: Mapped[str] = mapped_column(String(80))
    customer_id: Mapped[int | None] = mapped_column(BigInteger)  # set for customer-specific lists (FK added later)


class ProductCategory(Entity, Base):
    __tablename__ = "product_categories"
    name: Mapped[str] = mapped_column(String(120), unique=True)
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("product_categories.id"))


class Product(Entity, Base):
    __tablename__ = "products"

    sku: Mapped[str] = mapped_column(String(60), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    category_id: Mapped[int | None] = mapped_column(ForeignKey("product_categories.id"), index=True)
    type: Mapped[str] = mapped_column(String(20), default="finished")  # PRODUCT_TYPES
    kind: Mapped[str] = mapped_column(String(20), default="standard")  # PRODUCT_KINDS
    status: Mapped[str] = mapped_column(String(20), default="active")  # PRODUCT_STATUSES
    barcode: Mapped[str | None] = mapped_column(String(64), unique=True)
    unit_id: Mapped[int] = mapped_column(ForeignKey("units.id"))  # stock/base unit
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"), index=True)  # set on variants
    variant_attributes: Mapped[dict | None] = mapped_column(JSONB)  # {"size": "250 g"}
    tax_rate_id: Mapped[int | None] = mapped_column(ForeignKey("tax_rates.id"))  # null = company default
    channels: Mapped[list] = mapped_column(JSONB, default=list)  # sales channel codes it's sold on
    track_stock: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    track_batches: Mapped[bool] = mapped_column(Boolean, default=True)
    shelf_life_days: Mapped[int | None] = mapped_column(Integer)
    launch_date: Mapped[date | None] = mapped_column(Date)
    packaging_spec: Mapped[str | None] = mapped_column(Text)
    label_info: Mapped[str | None] = mapped_column(Text)


class ProductUnit(Base):
    """Product-specific pack sizes, e.g. 1 carton = 24 pcs. factor is in the product's base unit."""

    __tablename__ = "product_units"
    __table_args__ = (UniqueConstraint("product_id", "name"),)
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(40))
    factor: Mapped[Qty]
    barcode: Mapped[str | None] = mapped_column(String(64), unique=True)


class BundleComponent(Base):
    __tablename__ = "bundle_components"
    bundle_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), primary_key=True)
    component_id: Mapped[int] = mapped_column(ForeignKey("products.id"), primary_key=True)
    quantity: Mapped[Qty]


class ProductPrice(Entity, Base):
    """Never updated: a price change is a new row with a later effective_from."""

    __tablename__ = "product_prices"
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    price_list_id: Mapped[int] = mapped_column(ForeignKey("price_lists.id"))
    price: Mapped[Money]  # tax-inclusive
    effective_from: Mapped[date] = mapped_column(Date)
    note: Mapped[str | None] = mapped_column(String(255))


class ProductCost(Entity, Base):
    """Standard cost per base unit; history kept by effective_from like prices."""

    __tablename__ = "product_costs"
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    effective_from: Mapped[date] = mapped_column(Date)
    materials: Mapped[Decimal] = mapped_column(Numeric(14, 4), default=Decimal(0))
    packaging: Mapped[Decimal] = mapped_column(Numeric(14, 4), default=Decimal(0))
    labour: Mapped[Decimal] = mapped_column(Numeric(14, 4), default=Decimal(0))
    overhead: Mapped[Decimal] = mapped_column(Numeric(14, 4), default=Decimal(0))
    delivery: Mapped[Decimal] = mapped_column(Numeric(14, 4), default=Decimal(0))
    other: Mapped[Decimal] = mapped_column(Numeric(14, 4), default=Decimal(0))
    note: Mapped[str | None] = mapped_column(String(255))

    @property
    def total(self) -> Decimal:
        return self.materials + self.packaging + self.labour + self.overhead + self.delivery + self.other
