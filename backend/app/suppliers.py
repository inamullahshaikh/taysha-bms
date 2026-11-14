"""Suppliers: profile, contacts, supplied items. Documents (agreements, price lists) via attachments."""

from datetime import datetime
from decimal import Decimal

from fastapi import APIRouter
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import Boolean, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint, delete, select
from sqlalchemy.orm import Mapped, mapped_column

from app.audit import audit
from app.auth.access import require_access
from app.auth.models import User
from app.crud import RecordOut, crud_router, get_or_404
from app.customers import clean_phone
from app.db import DB, Base, Entity
from app.products.models import Product


class Supplier(Entity, Base):
    __tablename__ = "suppliers"

    name: Mapped[str] = mapped_column(String(200), index=True)
    phone: Mapped[str | None] = mapped_column(String(30))
    email: Mapped[str | None] = mapped_column(String(254))
    address: Mapped[str | None] = mapped_column(Text)
    city: Mapped[str | None] = mapped_column(String(100))
    ntn: Mapped[str | None] = mapped_column(String(50))
    strn: Mapped[str | None] = mapped_column(String(50))
    payment_terms_days: Mapped[int] = mapped_column(Integer, default=0)
    bank_details: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)


class SupplierContact(Base):
    __tablename__ = "supplier_contacts"
    id: Mapped[int] = mapped_column(primary_key=True)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    role: Mapped[str | None] = mapped_column(String(80))
    phone: Mapped[str | None] = mapped_column(String(30))
    email: Mapped[str | None] = mapped_column(String(254))


class SupplierItem(Base):
    """What a supplier can supply, with their code, lead time and minimum order."""

    __tablename__ = "supplier_items"
    __table_args__ = (UniqueConstraint("supplier_id", "product_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    supplier_sku: Mapped[str | None] = mapped_column(String(60))
    lead_time_days: Mapped[int | None] = mapped_column(Integer)
    min_order_qty: Mapped[Decimal | None] = mapped_column(Numeric(14, 3))
    is_preferred: Mapped[bool] = mapped_column(Boolean, default=False)


class SupplierIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    phone: str | None = None
    email: EmailStr | None = None
    address: str | None = None
    city: str | None = None
    ntn: str | None = None
    strn: str | None = None
    payment_terms_days: int = Field(0, ge=0)
    bank_details: str | None = None
    notes: str | None = None

    def model_dump(self, **kw):
        d = super().model_dump(**kw)
        if "phone" in d:
            d["phone"] = clean_phone(d["phone"])
        return d


class SupplierPatch(SupplierIn):
    name: str | None = Field(None, min_length=1, max_length=200)
    payment_terms_days: int | None = Field(None, ge=0)


class SupplierOut(RecordOut, SupplierIn):
    email: str | None = None
    created_at: datetime


class ContactIn(BaseModel):
    name: str = Field(min_length=1)
    role: str | None = None
    phone: str | None = None
    email: EmailStr | None = None


class ContactOut(ContactIn):
    model_config = {"from_attributes": True}
    id: int
    email: str | None = None


class ItemIn(BaseModel):
    product_id: int
    supplier_sku: str | None = None
    lead_time_days: int | None = Field(None, ge=0)
    min_order_qty: Decimal | None = Field(None, gt=0)
    is_preferred: bool = False


class ItemOut(ItemIn):
    model_config = {"from_attributes": True}
    id: int
    supplier_id: int
    product_sku: str = ""
    product_name: str = ""


VIEW, EDIT = require_access("suppliers", "view"), require_access("suppliers", "edit")
crud_routers = [crud_router(
    Supplier, prefix="/suppliers", feature="suppliers", create=SupplierIn, update=SupplierPatch, out=SupplierOut,
    search=(Supplier.name, Supplier.phone, Supplier.email), sorts={"name": Supplier.name},
    filters={"city": Supplier.city}, default_sort=Supplier.name,
)]
router = APIRouter(prefix="/suppliers", tags=["suppliers"])


@router.get("/{supplier_id}/contacts", response_model=list[ContactOut])
def get_contacts(supplier_id: int, db: DB, _: User = VIEW):
    return db.scalars(select(SupplierContact).where(SupplierContact.supplier_id == supplier_id)
                      .order_by(SupplierContact.id)).all()


@router.put("/{supplier_id}/contacts", response_model=list[ContactOut])
def set_contacts(supplier_id: int, body: list[ContactIn], db: DB, _: User = EDIT):
    get_or_404(db, Supplier, supplier_id, "Supplier")
    db.execute(delete(SupplierContact).where(SupplierContact.supplier_id == supplier_id))
    db.add_all(SupplierContact(supplier_id=supplier_id, **{**c.model_dump(), "phone": clean_phone(c.phone)})
               for c in body)
    audit(db, "update", entity_type="suppliers", entity_id=supplier_id, note="contacts",
          after={"contacts": [c.name for c in body]})
    db.flush()
    return get_contacts(supplier_id, db)


def items_out(db, where) -> list[ItemOut]:
    rows = db.execute(select(SupplierItem, Product).join(Product, Product.id == SupplierItem.product_id)
                      .where(where).order_by(Product.name))
    return [ItemOut(**{c: getattr(i, c) for c in ItemOut.model_fields if hasattr(i, c)},
                    product_sku=p.sku, product_name=p.name) for i, p in rows]


@router.get("/{supplier_id}/items", response_model=list[ItemOut])
def get_items(supplier_id: int, db: DB, _: User = VIEW):
    return items_out(db, SupplierItem.supplier_id == supplier_id)


@router.put("/{supplier_id}/items", response_model=list[ItemOut])
def set_items(supplier_id: int, body: list[ItemIn], db: DB, _: User = EDIT):
    get_or_404(db, Supplier, supplier_id, "Supplier")
    for i in body:
        get_or_404(db, Product, i.product_id, "Product")
    db.execute(delete(SupplierItem).where(SupplierItem.supplier_id == supplier_id))
    db.add_all(SupplierItem(supplier_id=supplier_id, **i.model_dump()) for i in body)
    audit(db, "update", entity_type="suppliers", entity_id=supplier_id, note="supplied items",
          after={"products": [i.product_id for i in body]})
    db.flush()
    return get_items(supplier_id, db)


products_router = APIRouter(prefix="/products", tags=["products"])


@products_router.get("/{product_id}/suppliers", response_model=list[ItemOut])
def product_suppliers(product_id: int, db: DB, _: User = VIEW):
    """Who supplies this product (for purchasing)."""
    return items_out(db, SupplierItem.product_id == product_id)

routers = [router, *crud_routers, products_router]
