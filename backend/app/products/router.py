from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.audit import audit, snapshot
from app.auth.access import require_access
from app.auth.models import User
from app.clock import local_today
from app.crud import RecordOut, crud_router, get_or_404
from app.db import DB
from app.errors import AppError
from app.listing import ListParams, Page, apply_filters, export_response, paginate
from app.products.models import (
    BundleComponent, PriceList, Product, ProductCategory, ProductCost, ProductPrice, ProductUnit, SalesChannel,
)
from app.products.pricing import current_cost, margin, resolve_price, tax_rate_of, valid_gtin

router = APIRouter(prefix="/products", tags=["products"])
VIEW, CREATE, EDIT, ARCHIVE, EXPORT = (require_access("products", a)
                                       for a in ("view", "create", "edit", "archive", "export"))
PRICE_EDIT = require_access("product_prices", "edit")
COST_VIEW, COST_EDIT = require_access("product_costs", "view"), require_access("product_costs", "edit")

ProductType = Literal["finished", "raw", "packaging", "consumable", "spare"]
ProductKind = Literal["standard", "bundle", "sample", "promo"]
ProductStatus = Literal["draft", "active", "discontinued"]


# ---------- schemas ----------

class ProductFields(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    category_id: int | None = None
    type: ProductType = "finished"
    kind: ProductKind = "standard"
    status: ProductStatus = "active"
    barcode: str | None = Field(None, max_length=64)
    unit_id: int
    parent_id: int | None = None
    variant_attributes: dict[str, str] | None = None
    tax_rate_id: int | None = None
    channels: list[str] = []
    track_stock: bool = True
    track_batches: bool = True
    shelf_life_days: int | None = Field(None, ge=0)
    launch_date: date | None = None
    packaging_spec: str | None = None
    label_info: str | None = None


class ProductIn(ProductFields):
    sku: str = Field(min_length=1, max_length=60)


class ProductPatch(BaseModel):
    sku: str | None = Field(None, min_length=1, max_length=60)
    name: str | None = Field(None, min_length=1, max_length=200)
    description: str | None = None
    category_id: int | None = None
    type: ProductType | None = None
    kind: ProductKind | None = None
    status: ProductStatus | None = None
    barcode: str | None = Field(None, max_length=64)
    unit_id: int | None = None
    parent_id: int | None = None
    variant_attributes: dict[str, str] | None = None
    tax_rate_id: int | None = None
    channels: list[str] | None = None
    track_stock: bool | None = None
    track_batches: bool | None = None
    shelf_life_days: int | None = Field(None, ge=0)
    launch_date: date | None = None
    packaging_spec: str | None = None
    label_info: str | None = None


class ProductOut(RecordOut, ProductIn):
    created_at: datetime
    updated_at: datetime


class CategoryIn(BaseModel):
    name: str = Field(min_length=1)
    parent_id: int | None = None


class CategoryOut(RecordOut, CategoryIn):
    pass


class CodeNameIn(BaseModel):
    code: str = Field(min_length=1, max_length=30, pattern=r"^[a-z0-9_]+$")
    name: str = Field(min_length=1)


class CodeNamePatch(BaseModel):
    name: str


class CodeNameOut(RecordOut, CodeNameIn):
    pass


class ComponentIn(BaseModel):
    component_id: int
    quantity: Decimal = Field(gt=0)


class ComponentOut(ComponentIn):
    model_config = {"from_attributes": True}
    sku: str = ""
    name: str = ""


class PackUnitIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    factor: Decimal = Field(gt=0)
    barcode: str | None = None


class PackUnitOut(PackUnitIn):
    model_config = {"from_attributes": True}
    id: int


class PriceIn(BaseModel):
    price_list_id: int
    price: Decimal = Field(ge=0, decimal_places=2)
    effective_from: date | None = None
    note: str | None = None


class PriceOut(BaseModel):
    model_config = {"from_attributes": True}
    id: int
    price_list_id: int
    price: Decimal
    effective_from: date
    note: str | None
    created_at: datetime
    created_by_id: int | None


class CostIn(BaseModel):
    effective_from: date | None = None
    materials: Decimal = Field(Decimal(0), ge=0)
    packaging: Decimal = Field(Decimal(0), ge=0)
    labour: Decimal = Field(Decimal(0), ge=0)
    overhead: Decimal = Field(Decimal(0), ge=0)
    delivery: Decimal = Field(Decimal(0), ge=0)
    other: Decimal = Field(Decimal(0), ge=0)
    note: str | None = None


class CostOut(CostIn):
    model_config = {"from_attributes": True}
    id: int
    effective_from: date
    total: Decimal
    created_at: datetime


# ---------- validation ----------

def check_barcode(db: Session, code: str | None, product_id: int | None = None) -> str | None:
    if not code:
        return None
    code = code.strip()
    if code.isdigit() and len(code) in (8, 12, 13, 14) and not valid_gtin(code):
        raise AppError(422, "invalid_barcode", "Barcode check digit is wrong", {"barcode": "check digit"})
    q = select(Product.id).where(Product.barcode == code)
    if product_id:
        q = q.where(Product.id != product_id)
    if db.scalar(q) or db.scalar(select(ProductUnit.id).where(ProductUnit.barcode == code)):
        raise AppError(409, "duplicate_barcode", "That barcode is already used", {"barcode": "duplicate"})
    return code


def check_product(db: Session, data: dict, product: Product | None = None) -> None:
    if "barcode" in data:
        data["barcode"] = check_barcode(db, data["barcode"], product.id if product else None)
    if data.get("parent_id"):
        parent = get_or_404(db, Product, data["parent_id"], "Parent product")
        if parent.parent_id or (product and parent.id == product.id):
            raise AppError(422, "invalid_parent", "A variant's parent must be a top-level product",
                           {"parent_id": "invalid"})
        if product and db.scalar(select(Product.id).where(Product.parent_id == product.id).limit(1)):
            raise AppError(422, "invalid_parent", "A product with variants can't become a variant")
    if data.get("channels"):
        known = set(db.scalars(select(SalesChannel.code).where(SalesChannel.code.in_(data["channels"]))))
        unknown = set(data["channels"]) - known
        if unknown:
            raise AppError(422, "unknown_channel", f"Unknown sales channels: {', '.join(sorted(unknown))}",
                           {"channels": "unknown"})


def get_product(db: Session, product_id: int) -> Product:
    return get_or_404(db, Product, product_id, "Product")


# ---------- products ----------

SEARCH = (Product.name, Product.sku, Product.barcode)
SORTS = {"name": Product.name, "sku": Product.sku, "created_at": Product.created_at, "status": Product.status}


def product_query(p: ListParams, category_id, type, kind, status, channel, parent_id, top_level):
    q = apply_filters(select(Product), Product, p, SEARCH, SORTS, Product.name)
    if category_id:
        q = q.where(Product.category_id == category_id)
    if type:
        q = q.where(Product.type == type)
    if kind:
        q = q.where(Product.kind == kind)
    if status:
        q = q.where(Product.status == status)
    if channel:
        q = q.where(Product.channels.contains([channel]))
    if parent_id:
        q = q.where(Product.parent_id == parent_id)
    if top_level:
        q = q.where(Product.parent_id.is_(None))
    return q


class ProductFilters:
    def __init__(self, category_id: int | None = None, type: ProductType | None = None,
                 kind: ProductKind | None = None, status: ProductStatus | None = None, channel: str | None = None,
                 parent_id: int | None = None, top_level: bool = False):
        self.args = (category_id, type, kind, status, channel, parent_id, top_level)


@router.get("", response_model=Page[ProductOut])
def list_products(db: DB, p: Annotated[ListParams, Depends()], f: Annotated[ProductFilters, Depends()],
                  _: User = VIEW):
    return paginate(db, product_query(p, *f.args), p, ProductOut)


@router.get("/export")
def export_products(db: DB, p: Annotated[ListParams, Depends()], f: Annotated[ProductFilters, Depends()],
                    format: str = "csv", _: User = EXPORT):
    rows = [ProductOut.model_validate(x).model_dump() for x in db.scalars(product_query(p, *f.args))]
    cols = [("sku", "SKU"), ("name", "Name"), ("type", "Type"), ("kind", "Kind"), ("status", "Status"),
            ("barcode", "Barcode"), ("launch_date", "Launch date")]
    return export_response(db, rows, cols, format, "products", "products")


@router.get("/lookup", response_model=ProductOut)
def lookup(barcode: str, db: DB, _: User = VIEW):
    """Exact match on a product barcode or a pack-size barcode (scanning)."""
    code = barcode.strip()
    p = db.scalar(select(Product).where(Product.barcode == code))
    if p is None:
        pid = db.scalar(select(ProductUnit.product_id).where(ProductUnit.barcode == code))
        p = db.get(Product, pid) if pid else None
    if p is None:
        raise AppError(404, "not_found", "No product with that barcode")
    return p


@router.get("/{product_id}", response_model=ProductOut)
def read_product(product_id: int, db: DB, _: User = VIEW):
    return get_product(db, product_id)


@router.post("", response_model=ProductOut, status_code=201)
def create_product(body: ProductIn, db: DB, _: User = CREATE):
    data = body.model_dump()
    check_product(db, data)
    p = Product(**data)
    db.add(p)
    audit(db, "create", p)
    return p


@router.patch("/{product_id}", response_model=ProductOut)
def update_product(product_id: int, body: ProductPatch, db: DB, _: User = EDIT):
    p = get_product(db, product_id)
    data = body.model_dump(exclude_unset=True)
    check_product(db, data, p)
    before = snapshot(p)
    for k, v in data.items():
        setattr(p, k, v)
    audit(db, "update", p, before=before)
    return p


@router.post("/{product_id}/archive", response_model=ProductOut)
def archive_product(product_id: int, db: DB, _: User = ARCHIVE):
    """Archived products keep all history; they just stop appearing in pickers and lists."""
    p = get_product(db, product_id)
    p.archived_at = func.now()
    audit(db, "archive", p)
    db.flush()
    db.refresh(p)
    return p


@router.post("/{product_id}/restore", response_model=ProductOut)
def restore_product(product_id: int, db: DB, _: User = ARCHIVE):
    p = get_product(db, product_id)
    p.archived_at = None
    audit(db, "restore", p)
    return p


# ---------- bundles & pack sizes ----------

def components_out(db: Session, bundle_id: int) -> list[ComponentOut]:
    rows = db.execute(select(BundleComponent, Product).join(Product, Product.id == BundleComponent.component_id)
                      .where(BundleComponent.bundle_id == bundle_id).order_by(Product.name))
    return [ComponentOut(component_id=c.component_id, quantity=c.quantity, sku=p.sku, name=p.name) for c, p in rows]


@router.get("/{product_id}/components", response_model=list[ComponentOut])
def get_components(product_id: int, db: DB, _: User = VIEW):
    return components_out(db, get_product(db, product_id).id)


@router.put("/{product_id}/components", response_model=list[ComponentOut])
def set_components(product_id: int, body: list[ComponentIn], db: DB, _: User = EDIT):
    bundle = get_product(db, product_id)
    if bundle.kind != "bundle":
        raise AppError(422, "not_bundle", "Only bundle products have components")
    ids = [c.component_id for c in body]
    if len(set(ids)) != len(ids) or product_id in ids:
        raise AppError(422, "invalid_components", "Components must be distinct and not the bundle itself")
    for c in body:
        comp = get_or_404(db, Product, c.component_id, "Component")
        if comp.kind == "bundle":
            raise AppError(422, "nested_bundle", "A bundle can't contain another bundle")
    before = {str(c.component_id): str(c.quantity) for c in components_out(db, product_id)}
    db.execute(delete(BundleComponent).where(BundleComponent.bundle_id == product_id))
    db.add_all(BundleComponent(bundle_id=product_id, component_id=c.component_id, quantity=c.quantity) for c in body)
    audit(db, "update", entity_type="products", entity_id=product_id, note="bundle components",
          before=before, after={str(c.component_id): str(c.quantity) for c in body})
    db.flush()
    return components_out(db, product_id)


@router.get("/{product_id}/units", response_model=list[PackUnitOut])
def get_units(product_id: int, db: DB, _: User = VIEW):
    return db.scalars(select(ProductUnit).where(ProductUnit.product_id == get_product(db, product_id).id)
                      .order_by(ProductUnit.factor)).all()


@router.put("/{product_id}/units", response_model=list[PackUnitOut])
def set_units(product_id: int, body: list[PackUnitIn], db: DB, _: User = EDIT):
    get_product(db, product_id)
    db.execute(delete(ProductUnit).where(ProductUnit.product_id == product_id))
    db.flush()
    for u in body:
        code = check_barcode(db, u.barcode)
        db.add(ProductUnit(product_id=product_id, name=u.name, factor=u.factor, barcode=code))
        db.flush()
    audit(db, "update", entity_type="products", entity_id=product_id, note="pack sizes",
          after={u.name: str(u.factor) for u in body})
    return get_units(product_id, db)


# ---------- prices ----------

@router.get("/{product_id}/prices")
def get_prices(product_id: int, db: DB, _: User = VIEW):
    """Current price per price list plus full history (newest first)."""
    get_product(db, product_id)
    today = local_today()
    current = []
    for pl in db.scalars(select(PriceList).where(PriceList.archived_at.is_(None)).order_by(PriceList.id)):
        pp = resolve_price(db, product_id, pl.id, today)
        current.append({"price_list_id": pl.id, "code": pl.code, "name": pl.name,
                        "price": pp.price if pp else None, "effective_from": pp.effective_from if pp else None})
    history = db.scalars(select(ProductPrice).where(ProductPrice.product_id == product_id)
                         .order_by(ProductPrice.effective_from.desc(), ProductPrice.id.desc())).all()
    return {"current": current, "history": [PriceOut.model_validate(h) for h in history]}


@router.post("/{product_id}/prices", response_model=PriceOut, status_code=201)
def add_price(product_id: int, body: PriceIn, db: DB, _: User = PRICE_EDIT):
    """Prices are never edited: a change is a new row. No backdating, so past documents stay explainable."""
    get_product(db, product_id)
    get_or_404(db, PriceList, body.price_list_id, "Price list")
    today = local_today()
    eff = body.effective_from or today
    if eff < today:
        raise AppError(422, "backdated_price", "A price can't start in the past", {"effective_from": "past"})
    pp = ProductPrice(product_id=product_id, price_list_id=body.price_list_id, price=body.price,
                      effective_from=eff, note=body.note)
    db.add(pp)
    audit(db, "create", pp)
    return pp


@router.get("/{product_id}/price")
def get_price(product_id: int, price_list: str, db: DB, on: date | None = None, _: User = VIEW):
    pl = db.scalar(select(PriceList).where(PriceList.code == price_list))
    if pl is None:
        raise AppError(404, "not_found", "Price list not found")
    pp = resolve_price(db, get_product(db, product_id).id, pl.id, on or local_today())
    if pp is None:
        raise AppError(404, "no_price", f"No {pl.name} price set for this product")
    return {"price": pp.price, "effective_from": pp.effective_from, "price_list": pl.code}


# ---------- costs & margins ----------

@router.get("/{product_id}/costs")
def get_costs(product_id: int, db: DB, _: User = COST_VIEW):
    get_product(db, product_id)
    rows = db.scalars(select(ProductCost).where(ProductCost.product_id == product_id)
                      .order_by(ProductCost.effective_from.desc(), ProductCost.id.desc())).all()
    cur = current_cost(db, product_id, local_today())
    return {"current": CostOut.model_validate(cur) if cur else None,
            "history": [CostOut.model_validate(r) for r in rows]}


@router.post("/{product_id}/costs", response_model=CostOut, status_code=201)
def add_cost(product_id: int, body: CostIn, db: DB, _: User = COST_EDIT):
    get_product(db, product_id)
    data = body.model_dump()
    data["effective_from"] = data["effective_from"] or local_today()
    c = ProductCost(product_id=product_id, **data)
    db.add(c)
    audit(db, "create", c)
    return c


@router.get("/{product_id}/margins")
def get_margins(product_id: int, db: DB, price: Decimal | None = None, _: User = COST_VIEW):
    """Margin at each price list's current price, or at a what-if `price`."""
    p = get_product(db, product_id)
    today = local_today()
    rate = tax_rate_of(db, p)
    cost = current_cost(db, p.id, today)
    cost_total = cost.total if cost else None
    if price is not None:
        return {"tax_rate": rate, "what_if": margin(price, rate, cost_total)}
    lists = []
    for pl in db.scalars(select(PriceList).where(PriceList.archived_at.is_(None)).order_by(PriceList.id)):
        pp = resolve_price(db, p.id, pl.id, today)
        if pp:
            lists.append({"price_list": pl.code, "name": pl.name, **margin(pp.price, rate, cost_total)})
    return {"tax_rate": rate, "cost": cost_total, "price_lists": lists}


crud_routers = [
    crud_router(ProductCategory, prefix="/product-categories", feature="products", create=CategoryIn,
                update=CategoryIn, out=CategoryOut, search=(ProductCategory.name,), default_sort=ProductCategory.name),
    crud_router(PriceList, prefix="/settings/price-lists", feature="settings", create=CodeNameIn,
                update=CodeNamePatch, out=CodeNameOut, default_sort=PriceList.id, tags=["settings"]),
    crud_router(SalesChannel, prefix="/settings/sales-channels", feature="settings", create=CodeNameIn,
                update=CodeNamePatch, out=CodeNameOut, default_sort=SalesChannel.id, tags=["settings"]),
]

routers = [router, *crud_routers]
