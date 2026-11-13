from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.audit import audit
from app.auth.access import can, require_access
from app.auth.models import User
from app.clock import local_today, utcnow
from app.crud import RecordOut, crud_router, get_or_404
from app.db import DB
from app.errors import AppError
from app.inventory.models import (
    Batch, Location, ProductStockCost, ReorderRule, StockBalance, StockCount, StockCountLine, StockMovement, Transfer, TransferLine,
    Warehouse,
)
from app.inventory.service import (
    avg_cost, fill_backorders, get_or_create_batch, issue, move, stock_summary, to_base_qty,
)
from app.listing import ListParams, Page, apply_filters, export_response, paginate
from app.numbering import next_number
from app.products.models import Product

router = APIRouter(prefix="/stock", tags=["inventory"])
VIEW, CREATE, EDIT, APPROVE, EXPORT = (require_access("inventory", a)
                                       for a in ("view", "create", "edit", "approve", "export"))
ZERO = Decimal(0)


# ---------- warehouses, locations, rules ----------

class WarehouseIn(BaseModel):
    code: str = Field(min_length=1, max_length=20)
    name: str = Field(min_length=1)
    branch_id: int | None = None
    address: str | None = None


class WarehousePatch(BaseModel):
    name: str | None = None
    branch_id: int | None = None
    address: str | None = None


class WarehouseOut(RecordOut, WarehouseIn):
    pass


class LocationIn(BaseModel):
    code: str = Field(min_length=1, max_length=30)
    name: str | None = None
    barcode: str | None = None


class LocationOut(RecordOut, LocationIn):
    warehouse_id: int


class RuleIn(BaseModel):
    product_id: int
    warehouse_id: int
    min_qty: Decimal | None = Field(None, ge=0)
    reorder_point: Decimal | None = Field(None, ge=0)
    reorder_qty: Decimal | None = Field(None, gt=0)
    max_qty: Decimal | None = Field(None, ge=0)
    safety_stock: Decimal | None = Field(None, ge=0)


class RuleOut(RuleIn):
    model_config = {"from_attributes": True}


@router.get("/warehouses/{warehouse_id}/locations", response_model=list[LocationOut])
def list_locations(warehouse_id: int, db: DB, _: User = VIEW):
    return db.scalars(select(Location).where(Location.warehouse_id == warehouse_id, Location.archived_at.is_(None))
                      .order_by(Location.code)).all()


@router.post("/warehouses/{warehouse_id}/locations", response_model=LocationOut, status_code=201)
def add_location(warehouse_id: int, body: LocationIn, db: DB, _: User = EDIT):
    get_or_404(db, Warehouse, warehouse_id, "Warehouse")
    loc = Location(warehouse_id=warehouse_id, **body.model_dump())
    db.add(loc)
    audit(db, "create", loc)
    return loc


@router.get("/rules", response_model=list[RuleOut])
def list_rules(db: DB, product_id: int | None = None, warehouse_id: int | None = None, _: User = VIEW):
    q = select(ReorderRule)
    if product_id:
        q = q.where(ReorderRule.product_id == product_id)
    if warehouse_id:
        q = q.where(ReorderRule.warehouse_id == warehouse_id)
    return db.scalars(q).all()


@router.put("/rules", response_model=RuleOut)
def set_rule(body: RuleIn, db: DB, _: User = EDIT):
    if body.max_qty is not None and body.min_qty is not None and body.max_qty < body.min_qty:
        raise AppError(422, "invalid_levels", "Max can't be below min", {"max_qty": "below min"})
    r = db.get(ReorderRule, (body.product_id, body.warehouse_id))
    if r is None:
        r = ReorderRule(product_id=body.product_id, warehouse_id=body.warehouse_id)
        db.add(r)
    for k, v in body.model_dump().items():
        setattr(r, k, v)
    audit(db, "update", entity_type="products", entity_id=body.product_id, note="stock levels",
          after={k: str(v) if v is not None else None for k, v in body.model_dump().items()})
    db.flush()
    return r


# ---------- balances ----------

def in_transit(db: Session, product_ids: list[int]) -> dict[int, Decimal]:
    rows = db.execute(select(TransferLine.product_id, func.sum(TransferLine.quantity))
                      .join(Transfer, Transfer.id == TransferLine.transfer_id)
                      .where(Transfer.status == "in_transit", TransferLine.product_id.in_(product_ids))
                      .group_by(TransferLine.product_id))
    return dict(rows.all())


def stock_status(row: dict, rule: ReorderRule | None) -> str:
    if row["on_hand"] <= 0:
        return "out_of_stock"
    if rule and rule.reorder_point is not None and row["available"] <= rule.reorder_point:
        return "low"
    if rule and rule.min_qty is not None and row["available"] < rule.min_qty:
        return "low"
    if rule and rule.max_qty is not None and row["on_hand"] > rule.max_qty:
        return "overstock"
    return "ok"


@router.get("/balances")
def balances(db: DB, p: Annotated[ListParams, Depends()], warehouse_id: int | None = None,
             type: str | None = None, status: Literal["low", "out_of_stock", "overstock", "ok"] | None = None,
             user: User = VIEW):
    """One row per product: on hand, reserved, available, in transit, status vs. reorder levels, value."""
    q = apply_filters(select(Product), Product, p, (Product.name, Product.sku, Product.barcode),
                      {"name": Product.name, "sku": Product.sku}, Product.name)
    q = q.where(Product.track_stock, Product.kind != "bundle")
    if type:
        q = q.where(Product.type == type)
    products = db.scalars(q).all()
    ids = [x.id for x in products]
    summ, transit = stock_summary(db, ids, warehouse_id), in_transit(db, ids)
    rules = {}
    if warehouse_id:
        rules = {r.product_id: r for r in db.scalars(select(ReorderRule).where(
            ReorderRule.warehouse_id == warehouse_id, ReorderRule.product_id.in_(ids)))}
    show_value = can(db, user, "product_costs", "view")
    rows = []
    for prod in products:
        s = summ[prod.id]
        row = {"product_id": prod.id, "sku": prod.sku, "name": prod.name, "type": prod.type, **s,
               "in_transit": Decimal(transit.get(prod.id, ZERO)).quantize(Decimal("0.001"))}
        rule = rules.get(prod.id)
        row["reorder_point"] = rule.reorder_point if rule else None
        row["status"] = stock_status(row, rule)
        if show_value:
            cost = avg_cost(db, prod.id)
            row["avg_cost"], row["value"] = cost, (s["on_hand"] * cost).quantize(Decimal("0.01"))
        rows.append(row)
    if status:
        rows = [r for r in rows if r["status"] == status]
    start = (p.page - 1) * p.page_size
    return {"items": rows[start:start + p.page_size], "total": len(rows), "page": p.page, "page_size": p.page_size}


@router.get("/balances/{product_id}")
def balance_detail(product_id: int, db: DB, _: User = VIEW):
    """Where a product's stock is: per warehouse / location / batch."""
    rows = db.execute(
        select(StockBalance, Warehouse.code, Location.code, Batch)
        .join(Warehouse, Warehouse.id == StockBalance.warehouse_id)
        .outerjoin(Location, Location.id == StockBalance.location_id)
        .outerjoin(Batch, Batch.id == StockBalance.batch_id)
        .where(StockBalance.product_id == product_id, StockBalance.quantity != 0)
        .order_by(Warehouse.code, Batch.expiry_date.nulls_last()))
    return [{"warehouse_id": b.warehouse_id, "warehouse": wc, "location_id": b.location_id, "location": lc,
             "batch_id": b.batch_id, "batch": bt.number if bt else None, "expiry_date": bt.expiry_date if bt else None,
             "batch_status": bt.status if bt else None, "quantity": b.quantity} for b, wc, lc, bt in rows]


# ---------- ledger ----------

class MovementOut(BaseModel):
    model_config = {"from_attributes": True}
    id: int
    at: datetime
    movement_date: date
    product_id: int
    warehouse_id: int
    location_id: int | None
    batch_id: int | None
    quantity: Decimal
    unit_cost: Decimal | None
    balance_after: Decimal
    reason: str
    reference_type: str | None
    reference_id: int | None
    reference_number: str | None
    note: str | None
    user_id: int | None


class MovementFilters:
    def __init__(self, product_id: int | None = None, warehouse_id: int | None = None, batch_id: int | None = None,
                 reason: str | None = None, reference_type: str | None = None, reference_id: int | None = None,
                 user_id: int | None = None, date_from: date | None = None, date_to: date | None = None):
        self.f = {k: v for k, v in locals().items() if k != "self"}

    def query(self):
        q = select(StockMovement).order_by(StockMovement.id.desc())
        for k in ("product_id", "warehouse_id", "batch_id", "reason", "reference_type", "reference_id", "user_id"):
            if self.f[k] is not None:
                q = q.where(getattr(StockMovement, k) == self.f[k])
        if self.f["date_from"]:
            q = q.where(StockMovement.movement_date >= self.f["date_from"])
        if self.f["date_to"]:
            q = q.where(StockMovement.movement_date <= self.f["date_to"])
        return q


def hide_cost(rows: list[MovementOut], db: Session, user: User) -> list[MovementOut]:
    if not can(db, user, "product_costs", "view"):
        for r in rows:
            r.unit_cost = None
    return rows


@router.get("/movements", response_model=Page[MovementOut])
def movements(db: DB, p: Annotated[ListParams, Depends()], f: Annotated[MovementFilters, Depends()],
              user: User = VIEW):
    page = paginate(db, f.query(), p, MovementOut)
    page["items"] = hide_cost(page["items"], db, user)
    return page


@router.get("/movements/export")
def export_movements(db: DB, f: Annotated[MovementFilters, Depends()], format: str = "csv", user: User = EXPORT):
    rows = [r.model_dump() for r in hide_cost([MovementOut.model_validate(m) for m in db.scalars(f.query())], db, user)]
    cols = [("movement_date", "Date"), ("product_id", "Product"), ("warehouse_id", "Warehouse"),
            ("batch_id", "Batch"), ("quantity", "Qty"), ("balance_after", "Balance"), ("reason", "Reason"),
            ("reference_number", "Reference"), ("unit_cost", "Unit cost"), ("note", "Note"), ("user_id", "User")]
    return export_response(db, rows, cols, format, "stock-movements", "stock_movements")


# ---------- batches ----------

class BatchOut(RecordOut):
    product_id: int
    number: str
    mfg_date: date | None
    expiry_date: date | None
    supplier_id: int | None
    supplier_batch_no: str | None
    status: str
    notes: str | None
    on_hand: Decimal = ZERO


class BatchPatch(BaseModel):
    status: Literal["available", "hold", "rejected"] | None = None
    expiry_date: date | None = None
    notes: str | None = None


@router.get("/batches", response_model=Page[BatchOut])
def list_batches(db: DB, p: Annotated[ListParams, Depends()], product_id: int | None = None,
                 status: str | None = None, expiring_within_days: int | None = None, expired: bool = False,
                 in_stock: bool = False, _: User = VIEW):
    qty = select(func.coalesce(func.sum(StockBalance.quantity), 0)).where(StockBalance.batch_id == Batch.id) \
        .correlate(Batch).scalar_subquery()
    q = apply_filters(select(Batch), Batch, p, (Batch.number, Batch.supplier_batch_no),
                      {"expiry_date": Batch.expiry_date, "number": Batch.number}, Batch.expiry_date.asc().nulls_last())
    if product_id:
        q = q.where(Batch.product_id == product_id)
    if status:
        q = q.where(Batch.status == status)
    t = local_today()
    if expiring_within_days is not None:
        q = q.where(Batch.expiry_date.between(t, t + timedelta(days=expiring_within_days)))
    if expired:
        q = q.where(Batch.expiry_date < t)
    if in_stock:
        q = q.where(qty > 0)
    page = paginate(db, q, p, BatchOut)
    for b in page["items"]:
        b.on_hand = db.scalar(select(func.coalesce(func.sum(StockBalance.quantity), 0)).where(
            StockBalance.batch_id == b.id))
    return page


@router.patch("/batches/{batch_id}", response_model=BatchOut)
def update_batch(batch_id: int, body: BatchPatch, db: DB, _: User = EDIT):
    """Hold / release / reject a batch. Held and rejected batches can't be sold or used."""
    b = get_or_404(db, Batch, batch_id, "Batch")
    before = {"status": b.status, "expiry_date": str(b.expiry_date), "notes": b.notes}
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(b, k, v)
    audit(db, "update", entity_type="batches", entity_id=b.id, before=before,
          after={"status": b.status, "expiry_date": str(b.expiry_date), "notes": b.notes})
    return b


# ---------- receive / issue / adjust ----------

class ReceiveLine(BaseModel):
    product_id: int
    quantity: Decimal = Field(gt=0)
    unit: str | None = None  # 'kg', 'carton', ... default = product's unit
    unit_cost: Decimal | None = Field(None, ge=0)  # per entered unit
    batch_number: str | None = None
    mfg_date: date | None = None
    expiry_date: date | None = None
    location_id: int | None = None


class ReceiveIn(BaseModel):
    warehouse_id: int
    reason: Literal["receipt", "opening"] = "receipt"
    reference: str | None = None
    note: str | None = None
    lines: list[ReceiveLine] = Field(min_length=1)


def check_location(db: Session, location_id: int | None, warehouse_id: int) -> None:
    if location_id is not None:
        loc = get_or_404(db, Location, location_id, "Location")
        if loc.warehouse_id != warehouse_id:
            raise AppError(422, "wrong_location", "That location is in another warehouse")


def receive_line(db: Session, warehouse_id: int, ln, reason: str, ref, note, supplier_id: int | None = None,
                 supplier_batch_no: str | None = None, batch_status: str = "available") -> StockMovement:
    p = get_or_404(db, Product, ln.product_id, "Product")
    if not p.track_stock or p.kind == "bundle":
        raise AppError(422, "not_stocked", f"{p.name} isn't stocked")
    check_location(db, ln.location_id, warehouse_id)
    qty = to_base_qty(db, p, ln.quantity, ln.unit)
    cost = (ln.unit_cost * ln.quantity / qty) if ln.unit_cost is not None else None
    batch_id = None
    if p.track_batches:
        number = ln.batch_number or f"{local_today():%Y%m%d}-{ref[2] or 'RCV'}"
        expiry = ln.expiry_date or (ln.mfg_date + timedelta(days=p.shelf_life_days)
                                    if ln.mfg_date and p.shelf_life_days else None)
        b = get_or_create_batch(db, p.id, number, mfg_date=ln.mfg_date, expiry_date=expiry, supplier_id=supplier_id,
                                supplier_batch_no=supplier_batch_no, status=batch_status)
        batch_id = b.id
    return move(db, product_id=p.id, warehouse_id=warehouse_id, quantity=qty, reason=reason, batch_id=batch_id,
                location_id=ln.location_id, unit_cost=cost, ref=ref, note=note)


@router.post("/receive", response_model=list[MovementOut], status_code=201)
def receive(body: ReceiveIn, db: DB, user: User = CREATE):
    """Stock in without a purchase order (opening stock, gifts, found stock)."""
    get_or_404(db, Warehouse, body.warehouse_id, "Warehouse")
    if any(ln.unit_cost is not None for ln in body.lines) and not can(db, user, "product_costs", "edit"):
        raise AppError(403, "forbidden", "Entering costs needs product cost access")
    ref = ("receipt", None, body.reference)
    out = [receive_line(db, body.warehouse_id, ln, body.reason, ref, body.note) for ln in body.lines]
    for pid in {m.product_id for m in out}:
        fill_backorders(db, pid, body.warehouse_id)
    audit(db, "stock_receive", entity_type="warehouses", entity_id=body.warehouse_id, note=body.reference,
          after={str(m.product_id): str(m.quantity) for m in out})
    return hide_cost([MovementOut.model_validate(m) for m in out], db, user)


class IssueLine(BaseModel):
    product_id: int
    quantity: Decimal = Field(gt=0)
    unit: str | None = None
    batch_id: int | None = None
    location_id: int | None = None


class IssueIn(BaseModel):
    warehouse_id: int
    reason: Literal["issue", "sample", "internal_use", "wastage", "damage", "expired"] = "issue"
    note: str = Field(min_length=1)
    lines: list[IssueLine] = Field(min_length=1)


@router.post("/issue", response_model=list[MovementOut], status_code=201)
def issue_stock(body: IssueIn, db: DB, user: User = CREATE):
    """Stock out that isn't a sale: samples, internal use, wastage, damage, expired stock."""
    out = []
    for ln in body.lines:
        p = get_or_404(db, Product, ln.product_id, "Product")
        qty = to_base_qty(db, p, ln.quantity, ln.unit)
        # damaged/expired stock may be in unusable batches, so those reasons need an explicit batch
        if body.reason in ("damage", "expired", "wastage") and ln.batch_id:
            out += [move(db, product_id=p.id, warehouse_id=body.warehouse_id, quantity=-qty, reason=body.reason,
                         batch_id=ln.batch_id, location_id=ln.location_id, ref=("issue", None, None), note=body.note)]
        else:
            out += issue(db, product_id=p.id, warehouse_id=body.warehouse_id, quantity=qty, reason=body.reason,
                         batch_id=ln.batch_id, location_id=ln.location_id, ref=("issue", None, None), note=body.note)
    audit(db, "stock_issue", entity_type="warehouses", entity_id=body.warehouse_id, note=body.note,
          after={"reason": body.reason, **{str(m.product_id): str(m.quantity) for m in out}})
    return hide_cost([MovementOut.model_validate(m) for m in out], db, user)


class AdjustIn(BaseModel):
    warehouse_id: int
    product_id: int
    batch_id: int | None = None
    location_id: int | None = None
    quantity: Decimal | None = None  # signed change
    new_quantity: Decimal | None = Field(None, ge=0)  # or: set the balance to this
    note: str = Field(min_length=3)


@router.post("/adjust", response_model=MovementOut, status_code=201)
def adjust(body: AdjustIn, db: DB, user: User = EDIT):
    """Correct a balance. A reason note is required and the change is audited."""
    if (body.quantity is None) == (body.new_quantity is None):
        raise AppError(422, "quantity_or_new", "Give either quantity (change) or new_quantity")
    check_location(db, body.location_id, body.warehouse_id)
    change = body.quantity
    if body.new_quantity is not None:
        cur = db.scalar(select(func.coalesce(func.sum(StockBalance.quantity), 0)).where(
            StockBalance.product_id == body.product_id, StockBalance.warehouse_id == body.warehouse_id,
            StockBalance.batch_id.is_(None) if body.batch_id is None else StockBalance.batch_id == body.batch_id,
            StockBalance.location_id.is_(None) if body.location_id is None
            else StockBalance.location_id == body.location_id))
        change = body.new_quantity - cur
    m = move(db, product_id=body.product_id, warehouse_id=body.warehouse_id, quantity=change, reason="adjustment",
             batch_id=body.batch_id, location_id=body.location_id, ref=("adjustment", None, None), note=body.note)
    if change > 0:
        fill_backorders(db, body.product_id, body.warehouse_id)
    audit(db, "stock_adjust", entity_type="products", entity_id=body.product_id, note=body.note,
          after={"warehouse_id": body.warehouse_id, "change": str(change)})
    return hide_cost([MovementOut.model_validate(m)], db, user)[0]


# ---------- transfers ----------

class TransferLineIn(BaseModel):
    product_id: int
    quantity: Decimal = Field(gt=0)
    batch_id: int | None = None


class TransferIn(BaseModel):
    from_warehouse_id: int
    to_warehouse_id: int
    note: str | None = None
    lines: list[TransferLineIn] = Field(min_length=1)


class TransferReceiveLine(BaseModel):
    line_id: int
    received_quantity: Decimal = Field(ge=0)


class TransferOut(RecordOut):
    number: str
    from_warehouse_id: int
    to_warehouse_id: int
    status: str
    shipped_at: datetime | None
    received_at: datetime | None
    note: str | None
    lines: list[dict] = []


def transfer_out(db: Session, t: Transfer) -> TransferOut:
    o = TransferOut.model_validate(t)
    o.lines = [{"id": ln.id, "product_id": ln.product_id, "batch_id": ln.batch_id, "quantity": ln.quantity,
                "received_quantity": ln.received_quantity}
               for ln in db.scalars(select(TransferLine).where(TransferLine.transfer_id == t.id).order_by(TransferLine.id))]
    return o


@router.post("/transfers", response_model=TransferOut, status_code=201)
def create_transfer(body: TransferIn, db: DB, _: User = CREATE):
    if body.from_warehouse_id == body.to_warehouse_id:
        raise AppError(422, "same_warehouse", "Pick two different warehouses")
    for w in (body.from_warehouse_id, body.to_warehouse_id):
        get_or_404(db, Warehouse, w, "Warehouse")
    t = Transfer(number=next_number(db, "stock_transfer"), from_warehouse_id=body.from_warehouse_id,
                 to_warehouse_id=body.to_warehouse_id, note=body.note)
    db.add(t)
    db.flush()
    db.add_all(TransferLine(transfer_id=t.id, **ln.model_dump()) for ln in body.lines)
    audit(db, "create", t)
    return transfer_out(db, t)


@router.get("/transfers", response_model=Page[TransferOut])
def list_transfers(db: DB, p: Annotated[ListParams, Depends()], status: str | None = None, _: User = VIEW):
    q = apply_filters(select(Transfer), Transfer, p, (Transfer.number,), {}, Transfer.id.desc())
    if status:
        q = q.where(Transfer.status == status)
    page = paginate(db, q, p)
    page["items"] = [transfer_out(db, t) for t in page["items"]]
    return page


@router.get("/transfers/{transfer_id}", response_model=TransferOut)
def read_transfer(transfer_id: int, db: DB, _: User = VIEW):
    return transfer_out(db, get_or_404(db, Transfer, transfer_id, "Transfer"))


@router.post("/transfers/{transfer_id}/ship", response_model=TransferOut)
def ship_transfer(transfer_id: int, db: DB, _: User = CREATE):
    """Stock leaves the source warehouse and is 'in transit' until received."""
    t = get_or_404(db, Transfer, transfer_id, "Transfer")
    if t.status != "draft":
        raise AppError(409, "not_draft", f"Transfer is {t.status}")
    for ln in db.scalars(select(TransferLine).where(TransferLine.transfer_id == t.id)):
        moves = issue(db, product_id=ln.product_id, warehouse_id=t.from_warehouse_id, quantity=ln.quantity,
                      reason="transfer_out", batch_id=ln.batch_id, ref=("transfer", t.id, t.number))
        if ln.batch_id is None and len(moves) == 1:
            ln.batch_id = moves[0].batch_id
        elif ln.batch_id is None and len(moves) > 1:  # FEFO took several batches: split the line per batch
            ln.quantity, ln.batch_id = -moves[0].quantity, moves[0].batch_id
            for m in moves[1:]:
                db.add(TransferLine(transfer_id=t.id, product_id=ln.product_id, batch_id=m.batch_id,
                                    quantity=-m.quantity))
    t.status, t.shipped_at = "in_transit", utcnow()
    audit(db, "ship", entity_type="stock_transfers", entity_id=t.id)
    db.flush()
    return transfer_out(db, t)


@router.post("/transfers/{transfer_id}/receive", response_model=TransferOut)
def receive_transfer(transfer_id: int, body: list[TransferReceiveLine] | None, db: DB, _: User = CREATE):
    """Received quantities default to what was sent. Shortfalls are recorded as transit loss (wastage)."""
    t = get_or_404(db, Transfer, transfer_id, "Transfer")
    if t.status != "in_transit":
        raise AppError(409, "not_in_transit", f"Transfer is {t.status}")
    got = {r.line_id: r.received_quantity for r in (body or [])}
    for ln in db.scalars(select(TransferLine).where(TransferLine.transfer_id == t.id)):
        qty = got.get(ln.id, ln.quantity)
        if qty > ln.quantity:
            raise AppError(422, "over_receive", "Can't receive more than was sent")
        ln.received_quantity = qty
        if qty > 0:
            move(db, product_id=ln.product_id, warehouse_id=t.to_warehouse_id, quantity=qty, reason="transfer_in",
                 batch_id=ln.batch_id, ref=("transfer", t.id, t.number))
            fill_backorders(db, ln.product_id, t.to_warehouse_id)
    t.status, t.received_at = "received", utcnow()
    audit(db, "receive", entity_type="stock_transfers", entity_id=t.id)
    return transfer_out(db, t)


@router.post("/transfers/{transfer_id}/cancel", response_model=TransferOut)
def cancel_transfer(transfer_id: int, db: DB, _: User = CREATE):
    t = get_or_404(db, Transfer, transfer_id, "Transfer")
    if t.status != "draft":
        raise AppError(409, "not_draft", "Only draft transfers can be cancelled")
    t.status = "cancelled"
    audit(db, "cancel", entity_type="stock_transfers", entity_id=t.id)
    return transfer_out(db, t)


# ---------- stock counts ----------

class CountIn(BaseModel):
    warehouse_id: int
    product_ids: list[int] | None = None  # None = everything stocked in the warehouse
    note: str | None = None


class CountLineIn(BaseModel):
    line_id: int | None = None
    product_id: int | None = None  # for items found that weren't expected
    batch_id: int | None = None
    location_id: int | None = None
    counted_quantity: Decimal = Field(ge=0)


class CountOut(RecordOut):
    number: str
    warehouse_id: int
    status: str
    note: str | None
    approved_by_id: int | None
    approved_at: datetime | None
    lines: list[dict] = []


def count_out(db: Session, c: StockCount) -> CountOut:
    o = CountOut.model_validate(c)
    o.lines = [{"id": ln.id, "product_id": ln.product_id, "location_id": ln.location_id, "batch_id": ln.batch_id,
                "system_quantity": ln.system_quantity, "counted_quantity": ln.counted_quantity,
                "difference": None if ln.counted_quantity is None else ln.counted_quantity - ln.system_quantity}
               for ln in db.scalars(select(StockCountLine).where(StockCountLine.count_id == c.id)
                                    .order_by(StockCountLine.id))]
    return o


@router.post("/counts", response_model=CountOut, status_code=201)
def start_count(body: CountIn, db: DB, _: User = CREATE):
    get_or_404(db, Warehouse, body.warehouse_id, "Warehouse")
    c = StockCount(number=next_number(db, "stock_count"), warehouse_id=body.warehouse_id, note=body.note)
    db.add(c)
    db.flush()
    q = select(StockBalance).where(StockBalance.warehouse_id == body.warehouse_id, StockBalance.quantity != 0)
    if body.product_ids:
        q = q.where(StockBalance.product_id.in_(body.product_ids))
    for b in db.scalars(q):
        db.add(StockCountLine(count_id=c.id, product_id=b.product_id, location_id=b.location_id, batch_id=b.batch_id,
                              system_quantity=b.quantity))
    audit(db, "create", c)
    db.flush()
    return count_out(db, c)


@router.get("/counts", response_model=Page[CountOut])
def list_counts(db: DB, p: Annotated[ListParams, Depends()], _: User = VIEW):
    page = paginate(db, apply_filters(select(StockCount), StockCount, p, (StockCount.number,), {}), p)
    page["items"] = [count_out(db, c) for c in page["items"]]
    return page


@router.get("/counts/{count_id}", response_model=CountOut)
def read_count(count_id: int, db: DB, _: User = VIEW):
    return count_out(db, get_or_404(db, StockCount, count_id, "Stock count"))


@router.put("/counts/{count_id}/lines", response_model=CountOut)
def record_counts(count_id: int, body: list[CountLineIn], db: DB, _: User = CREATE):
    c = get_or_404(db, StockCount, count_id, "Stock count")
    if c.status != "open":
        raise AppError(409, "count_closed", f"Count is {c.status}")
    for ln in body:
        if ln.line_id:
            row = db.get(StockCountLine, ln.line_id)
            if row is None or row.count_id != c.id:
                raise AppError(404, "not_found", "Count line not found")
        else:
            if ln.product_id is None:
                raise AppError(422, "product_required", "New count lines need a product")
            row = db.scalar(select(StockCountLine).where(
                StockCountLine.count_id == c.id, StockCountLine.product_id == ln.product_id,
                StockCountLine.batch_id.is_(None) if ln.batch_id is None else StockCountLine.batch_id == ln.batch_id,
                StockCountLine.location_id.is_(None) if ln.location_id is None
                else StockCountLine.location_id == ln.location_id))
            if row is None:
                row = StockCountLine(count_id=c.id, product_id=ln.product_id, batch_id=ln.batch_id,
                                     location_id=ln.location_id, system_quantity=ZERO)
                db.add(row)
        row.counted_quantity, row.counted_by_id = ln.counted_quantity, db.info.get("user_id")
    db.flush()
    return count_out(db, c)


@router.post("/counts/{count_id}/submit", response_model=CountOut)
def submit_count(count_id: int, db: DB, _: User = CREATE):
    c = get_or_404(db, StockCount, count_id, "Stock count")
    if c.status != "open":
        raise AppError(409, "count_closed", f"Count is {c.status}")
    if db.scalar(select(StockCountLine.id).where(StockCountLine.count_id == c.id,
                                                 StockCountLine.counted_quantity.is_(None)).limit(1)):
        raise AppError(422, "uncounted_lines", "Some lines haven't been counted yet")
    c.status = "submitted"
    audit(db, "submit", entity_type="stock_counts", entity_id=c.id)
    return count_out(db, c)


@router.post("/counts/{count_id}/approve", response_model=CountOut)
def approve_count(count_id: int, db: DB, user: User = APPROVE):
    """Posts the differences as adjustments. Movements since the count started are respected: the adjustment is
    counted - system snapshot, applied on top of the current balance."""
    c = get_or_404(db, StockCount, count_id, "Stock count")
    if c.status != "submitted":
        raise AppError(409, "not_submitted", "Submit the count first")
    for ln in db.scalars(select(StockCountLine).where(StockCountLine.count_id == c.id)):
        diff = ln.counted_quantity - ln.system_quantity
        if diff:
            move(db, product_id=ln.product_id, warehouse_id=c.warehouse_id, quantity=diff, reason="count",
                 batch_id=ln.batch_id, location_id=ln.location_id, ref=("stock_count", c.id, c.number),
                 note=f"Stock count {c.number}", allow_negative=True)
    c.status, c.approved_by_id, c.approved_at = "approved", user.id, utcnow()
    audit(db, "approve", entity_type="stock_counts", entity_id=c.id)
    return count_out(db, c)


@router.post("/counts/{count_id}/cancel", response_model=CountOut)
def cancel_count(count_id: int, db: DB, _: User = CREATE):
    c = get_or_404(db, StockCount, count_id, "Stock count")
    if c.status not in ("open", "submitted"):
        raise AppError(409, "count_closed", f"Count is {c.status}")
    c.status = "cancelled"
    return count_out(db, c)


# ---------- valuation ----------

@router.get("/valuation")
def valuation(db: DB, warehouse_id: int | None = None, group_by: Literal["product", "type", "warehouse"] = "type",
              format: Literal["json", "csv", "xlsx"] = "json", _: User = require_access("product_costs", "view")):
    """On-hand quantity x weighted average cost."""
    key = {"product": Product.id, "type": Product.type, "warehouse": StockBalance.warehouse_id}[group_by]
    label = {"product": func.max(Product.name), "type": Product.type, "warehouse": func.max(Warehouse.name)}[group_by]
    q = (select(key.label("key"), label.label("label"), func.sum(StockBalance.quantity).label("quantity"),
                func.sum(StockBalance.quantity * func.coalesce(ProductStockCost.avg_cost, 0)).label("value"))
         .join(Product, Product.id == StockBalance.product_id)
         .join(Warehouse, Warehouse.id == StockBalance.warehouse_id)
         .outerjoin(ProductStockCost, ProductStockCost.product_id == StockBalance.product_id)
         .group_by(key)
         .order_by(func.sum(StockBalance.quantity * func.coalesce(ProductStockCost.avg_cost, 0)).desc()))
    if warehouse_id:
        q = q.where(StockBalance.warehouse_id == warehouse_id)
    rows = [{**dict(r._mapping), "value": Decimal(r.value or 0).quantize(Decimal("0.01"))} for r in db.execute(q)]
    total = sum((r["value"] for r in rows), ZERO)
    if format == "json":
        return {"rows": rows, "total": total}
    return export_response(db, rows, [("label", group_by.title()), ("quantity", "Quantity"), ("value", "Value")],
                           format, "stock-valuation", "stock_balances")


crud_routers = [crud_router(Warehouse, prefix="/warehouses", feature="inventory", create=WarehouseIn,
                            update=WarehousePatch, out=WarehouseOut, search=(Warehouse.code, Warehouse.name),
                            default_sort=Warehouse.code, tags=["inventory"])]
routers = [router, *crud_routers]
