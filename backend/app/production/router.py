from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit import audit
from app.auth.access import can, require_access
from app.auth.models import User
from app.clock import local_today, utcnow
from app.crud import RecordOut, get_or_404
from app.db import DB
from app.errors import AppError
from app.inventory.models import Batch, ReorderRule, StockMovement
from app.inventory.service import available, default_warehouse_id, line_backorder, to_base_qty
from app.listing import ListParams, Page, apply_filters, paginate
from app.numbering import next_number
from app.orders.models import Order, OrderLine
from app.pdf import pdf_response, render_pdf
from app.production.models import (
    DEFAULT_STAGES, ProductionMaterial, ProductionOrder, ProductionStage, Recipe, RecipeLine,
)
from app.production.service import (
    availability, availability_many, complete, issue_materials, materials, release, requirements, reserve,
    round_up_batches, standard_cost,
)
from app.products.models import Product

ZERO = Decimal(0)
R_VIEW, R_EDIT, R_APPROVE = (require_access("recipes", a) for a in ("view", "edit", "approve"))
VIEW, CREATE, EDIT = (require_access("production", a) for a in ("view", "create", "edit"))


# ======================= recipes =======================

class RecipeLineIn(BaseModel):
    product_id: int
    quantity: Decimal = Field(gt=0)
    unit: str | None = None
    wastage_pct: Decimal = Field(ZERO, ge=0, le=100)
    note: str | None = None


class RecipeIn(BaseModel):
    product_id: int
    yield_quantity: Decimal = Field(gt=0)
    yield_unit: str | None = None
    expected_wastage_pct: Decimal = Field(ZERO, ge=0, le=100)
    labour_minutes: int | None = Field(None, ge=0)
    instructions: str | None = None
    notes: str | None = None
    lines: list[RecipeLineIn] = Field(min_length=1)


class RecipeOut(RecordOut):
    product_id: int
    version: int
    status: str
    yield_quantity: Decimal
    expected_wastage_pct: Decimal
    labour_minutes: int | None
    instructions: str | None
    notes: str | None
    approved_by_id: int | None
    approved_at: datetime | None
    created_at: datetime
    lines: list[dict] = []


def recipe_out(db: Session, r: Recipe) -> RecipeOut:
    o = RecipeOut.model_validate(r)
    o.lines = []
    for ln in db.scalars(select(RecipeLine).where(RecipeLine.recipe_id == r.id).order_by(RecipeLine.id)):
        p = db.get(Product, ln.product_id)
        o.lines.append({"id": ln.id, "product_id": ln.product_id, "sku": p.sku, "name": p.name, "type": p.type,
                        "quantity": ln.quantity, "unit": ln.unit, "base_quantity": ln.base_quantity,
                        "wastage_pct": ln.wastage_pct, "note": ln.note})
    return o


def write_recipe(db: Session, r: Recipe, body: RecipeIn) -> None:
    product = get_or_404(db, Product, body.product_id, "Product")
    r.yield_quantity = to_base_qty(db, product, body.yield_quantity, body.yield_unit)
    r.expected_wastage_pct, r.labour_minutes = body.expected_wastage_pct, body.labour_minutes
    r.instructions, r.notes = body.instructions, body.notes
    db.query(RecipeLine).filter(RecipeLine.recipe_id == r.id).delete()
    for ln in body.lines:
        comp = get_or_404(db, Product, ln.product_id, "Ingredient")
        if comp.id == product.id:
            raise AppError(422, "self_ingredient", "A product can't be its own ingredient")
        db.add(RecipeLine(recipe_id=r.id, product_id=comp.id, quantity=ln.quantity, unit=ln.unit,
                          base_quantity=to_base_qty(db, comp, ln.quantity, ln.unit), wastage_pct=ln.wastage_pct,
                          note=ln.note))
    db.flush()


recipes = APIRouter(prefix="/recipes", tags=["production"])


@recipes.post("", response_model=RecipeOut, status_code=201)
def create_recipe(body: RecipeIn, db: DB, _: User = R_EDIT):
    """New draft version (version = latest + 1)."""
    v = (db.scalar(select(func.max(Recipe.version)).where(Recipe.product_id == body.product_id)) or 0) + 1
    r = Recipe(product_id=body.product_id, version=v, status="draft", yield_quantity=body.yield_quantity)
    db.add(r)
    db.flush()
    write_recipe(db, r, body)
    audit(db, "create", r)
    return recipe_out(db, r)


@recipes.get("", response_model=Page[RecipeOut])
def list_recipes(db: DB, p: Annotated[ListParams, Depends()], product_id: int | None = None,
                 status: str | None = None, _: User = R_VIEW):
    q = apply_filters(select(Recipe), Recipe, p, (), {"version": Recipe.version}, Recipe.id.desc())
    if product_id:
        q = q.where(Recipe.product_id == product_id)
    if status:
        q = q.where(Recipe.status == status)
    page = paginate(db, q, p)
    page["items"] = [recipe_out(db, r) for r in page["items"]]
    return page


@recipes.get("/{recipe_id}", response_model=RecipeOut)
def read_recipe(recipe_id: int, db: DB, _: User = R_VIEW):
    return recipe_out(db, get_or_404(db, Recipe, recipe_id, "Recipe"))


@recipes.put("/{recipe_id}", response_model=RecipeOut)
def update_recipe(recipe_id: int, body: RecipeIn, db: DB, _: User = R_EDIT):
    r = get_or_404(db, Recipe, recipe_id, "Recipe")
    if r.status != "draft":
        raise AppError(409, "not_draft", "Active and old versions can't change; create a new version")
    if body.product_id != r.product_id:
        raise AppError(422, "product_locked", "A recipe's product can't change")
    write_recipe(db, r, body)
    audit(db, "update", r)
    return recipe_out(db, r)


@recipes.post("/{recipe_id}/new-version", response_model=RecipeOut, status_code=201)
def new_version(recipe_id: int, db: DB, _: User = R_EDIT):
    """Copy any version into a new draft to edit."""
    src = get_or_404(db, Recipe, recipe_id, "Recipe")
    v = db.scalar(select(func.max(Recipe.version)).where(Recipe.product_id == src.product_id)) + 1
    r = Recipe(product_id=src.product_id, version=v, status="draft", yield_quantity=src.yield_quantity,
               expected_wastage_pct=src.expected_wastage_pct, labour_minutes=src.labour_minutes,
               instructions=src.instructions, notes=src.notes)
    db.add(r)
    db.flush()
    for ln in db.scalars(select(RecipeLine).where(RecipeLine.recipe_id == src.id)):
        db.add(RecipeLine(recipe_id=r.id, product_id=ln.product_id, quantity=ln.quantity, unit=ln.unit,
                          base_quantity=ln.base_quantity, wastage_pct=ln.wastage_pct, note=ln.note))
    audit(db, "create", r, note=f"from version {src.version}")
    db.flush()
    return recipe_out(db, r)


@recipes.post("/{recipe_id}/activate", response_model=RecipeOut)
def activate(recipe_id: int, db: DB, user: User = R_APPROVE):
    """Approve this version for production. The previous active version is superseded (kept for history)."""
    r = get_or_404(db, Recipe, recipe_id, "Recipe")
    if r.status != "draft":
        raise AppError(409, "not_draft", "Only drafts can be activated")
    for old in db.scalars(select(Recipe).where(Recipe.product_id == r.product_id, Recipe.status == "active")):
        old.status = "superseded"
    db.flush()
    r.status, r.approved_by_id, r.approved_at = "active", user.id, utcnow()
    audit(db, "activate", entity_type="recipes", entity_id=r.id, after={"version": r.version})
    return recipe_out(db, r)


@recipes.get("/{recipe_id}/cost")
def recipe_cost(recipe_id: int, db: DB, quantity: Decimal | None = None,
                _: User = require_access("product_costs", "view")):
    """Standard cost at current material prices, for one batch or any quantity."""
    r = get_or_404(db, Recipe, recipe_id, "Recipe")
    return standard_cost(db, r, quantity or r.yield_quantity)


@recipes.get("/{recipe_id}/compare/{other_id}")
def compare(recipe_id: int, other_id: int, db: DB, _: User = R_VIEW):
    """Ingredient differences between two versions (per batch, base units)."""
    a, b = get_or_404(db, Recipe, recipe_id, "Recipe"), get_or_404(db, Recipe, other_id, "Recipe")

    def per_unit(r):
        return {ln.product_id: ln.base_quantity / r.yield_quantity
                for ln in db.scalars(select(RecipeLine).where(RecipeLine.recipe_id == r.id))}

    pa, pb = per_unit(a), per_unit(b)
    rows = []
    for pid in sorted(set(pa) | set(pb)):
        p = db.get(Product, pid)
        rows.append({"product_id": pid, "name": p.name, "a_per_unit": pa.get(pid), "b_per_unit": pb.get(pid),
                     "change": "added" if pid not in pa else "removed" if pid not in pb else
                     ("changed" if pa[pid] != pb[pid] else "same")})
    return {"a": {"id": a.id, "version": a.version}, "b": {"id": b.id, "version": b.version}, "lines": rows}


# ======================= production orders =======================

class POIn(BaseModel):
    product_id: int
    quantity: Decimal = Field(gt=0)
    unit: str | None = None
    recipe_id: int | None = None  # default: the active recipe
    warehouse_id: int | None = None
    planned_start: date | None = None
    due_date: date | None = None
    assigned_to_id: int | None = None
    stages: list[str] | None = None
    notes: str | None = None
    source: str | None = "manual"


class StageIn(BaseModel):
    status: Literal["pending", "in_progress", "done"]
    assigned_to_id: int | None = None
    note: str | None = None


class CompleteIn(BaseModel):
    output_quantity: Decimal = Field(ge=0)
    rejected_quantity: Decimal = Field(ZERO, ge=0)
    wastage_quantity: Decimal = Field(ZERO, ge=0)
    labour_minutes: int | None = Field(None, ge=0)
    batch_number: str | None = None
    mfg_date: date | None = None
    expiry_date: date | None = None
    materials: list[dict] | None = None  # [{"product_id": 1, "quantity": "123.4"}] actual usage, base units


class PROut(RecordOut):
    number: str
    product_id: int
    product_name: str = ""
    recipe_id: int
    recipe_version: int = 0
    warehouse_id: int
    status: str
    planned_quantity: Decimal
    planned_start: date | None
    due_date: date | None
    assigned_to_id: int | None
    started_at: datetime | None
    completed_at: datetime | None
    output_quantity: Decimal | None
    rejected_quantity: Decimal | None
    wastage_quantity: Decimal | None
    labour_minutes: int | None
    batch_id: int | None
    planned_cost: Decimal | None
    material_cost: Decimal | None
    labour_cost: Decimal | None
    overhead_cost: Decimal | None
    actual_cost: Decimal | None
    source: str | None
    notes: str | None
    created_at: datetime
    yield_pct: Decimal | None = None
    wastage_pct: Decimal | None = None
    cost_variance: Decimal | None = None
    unit_cost: Decimal | None = None
    materials: list[dict] = []
    stages: list[dict] = []


def pr_outs(db: Session, pos: list[ProductionOrder], show_cost: bool = True) -> list[PROut]:
    """Orders with materials and stages; the whole page in a fixed number of queries."""
    ids = [po.id for po in pos]
    # load into the identity map so db.get() below doesn't query per order
    db.scalars(select(Product).where(Product.id.in_({po.product_id for po in pos}))).all()
    db.scalars(select(Recipe).where(Recipe.id.in_({po.recipe_id for po in pos}))).all()
    avail = availability_many(db, pos)
    stages: dict[int, list[dict]] = {i: [] for i in ids}
    for s in db.scalars(select(ProductionStage).where(ProductionStage.production_order_id.in_(ids))
                        .order_by(ProductionStage.production_order_id, ProductionStage.seq)):
        stages[s.production_order_id].append({k: getattr(s, k) for k in (
            "id", "seq", "name", "status", "assigned_to_id", "started_at", "finished_at", "note")})
    return [_pr_out(db, po, avail[po.id], stages[po.id], show_cost) for po in pos]


def pr_out(db: Session, po: ProductionOrder, show_cost: bool = True) -> PROut:
    return pr_outs(db, [po], show_cost)[0]


def _pr_out(db: Session, po: ProductionOrder, mats: list, stages: list[dict], show_cost: bool) -> PROut:
    o = PROut.model_validate(po)
    o.product_name = db.get(Product, po.product_id).name
    o.recipe_version = db.get(Recipe, po.recipe_id).version
    o.materials = []
    for m, row in mats:
        row["actual"] = m.actual_quantity
        o.materials.append(row)
    o.stages = stages
    if po.output_quantity is not None and po.planned_quantity:
        o.yield_pct = (po.output_quantity / po.planned_quantity * 100).quantize(Decimal("0.1"))
        made = po.output_quantity + (po.rejected_quantity or 0) + (po.wastage_quantity or 0)
        o.wastage_pct = (((po.rejected_quantity or 0) + (po.wastage_quantity or 0)) / made * 100).quantize(
            Decimal("0.1")) if made else None
    if po.actual_cost is not None and po.planned_cost is not None:
        o.cost_variance = po.actual_cost - po.planned_cost
    if po.actual_cost is not None and po.output_quantity:
        o.unit_cost = (po.actual_cost / po.output_quantity).quantize(Decimal("0.0001"))
    if not show_cost:
        for f in ("planned_cost", "material_cost", "labour_cost", "overhead_cost", "actual_cost", "cost_variance",
                  "unit_cost"):
            setattr(o, f, None)
    return o


def can_see_cost(db: Session, user: User) -> bool:
    return can(db, user, "product_costs", "view")


def get_po(db: Session, po_id: int) -> ProductionOrder:
    return get_or_404(db, ProductionOrder, po_id, "Production order")


orders = APIRouter(prefix="/production-orders", tags=["production"])


def create_production_order(db: Session, body: POIn) -> ProductionOrder:
    product = get_or_404(db, Product, body.product_id, "Product")
    recipe = (get_or_404(db, Recipe, body.recipe_id, "Recipe") if body.recipe_id else
              db.scalar(select(Recipe).where(Recipe.product_id == product.id, Recipe.status == "active")))
    if recipe is None:
        raise AppError(422, "no_recipe", f"{product.name} has no active recipe")
    if recipe.product_id != product.id or recipe.status == "draft":
        raise AppError(422, "invalid_recipe", "Use an approved recipe of this product")
    wh = body.warehouse_id or default_warehouse_id(db)
    if wh is None:
        raise AppError(422, "no_warehouse", "Create a warehouse first")
    qty = to_base_qty(db, product, body.quantity, body.unit)
    po = ProductionOrder(number=next_number(db, "production_order"), product_id=product.id, recipe_id=recipe.id,
                         warehouse_id=wh, planned_quantity=qty, planned_start=body.planned_start,
                         due_date=body.due_date, assigned_to_id=body.assigned_to_id, notes=body.notes,
                         source=body.source, planned_cost=standard_cost(db, recipe, qty)["total"])
    db.add(po)
    db.flush()
    for pid, need in requirements(db, recipe, qty):
        db.add(ProductionMaterial(production_order_id=po.id, product_id=pid, required_quantity=need))
    for i, name in enumerate(body.stages or DEFAULT_STAGES, start=1):
        db.add(ProductionStage(production_order_id=po.id, seq=i, name=name))
    audit(db, "create", po)
    db.flush()
    return po


@orders.post("", response_model=PROut, status_code=201)
def create_po(body: POIn, db: DB, user: User = CREATE):
    return pr_out(db, create_production_order(db, body), can_see_cost(db, user))


class PRFilters:
    def __init__(self, status: str | None = None, product_id: int | None = None, date_from: date | None = None,
                 date_to: date | None = None, open_only: bool = False):
        self.status, self.product_id, self.date_from, self.date_to, self.open_only = (
            status, product_id, date_from, date_to, open_only)

    def apply(self, q):
        if self.status:
            q = q.where(ProductionOrder.status == self.status)
        if self.product_id:
            q = q.where(ProductionOrder.product_id == self.product_id)
        if self.date_from:
            q = q.where(ProductionOrder.planned_start >= self.date_from)
        if self.date_to:
            q = q.where(ProductionOrder.planned_start <= self.date_to)
        if self.open_only:
            q = q.where(ProductionOrder.status.in_(("draft", "released", "in_progress")))
        return q


@orders.get("", response_model=Page[PROut])
def list_pos(db: DB, p: Annotated[ListParams, Depends()], f: Annotated[PRFilters, Depends()], user: User = VIEW):
    q = f.apply(apply_filters(select(ProductionOrder), ProductionOrder, p, (ProductionOrder.number,),
                              {"planned_start": ProductionOrder.planned_start, "number": ProductionOrder.number}))
    page = paginate(db, q, p)
    page["items"] = pr_outs(db, page["items"], can_see_cost(db, user))
    return page


@orders.get("/{po_id}", response_model=PROut)
def read_po(po_id: int, db: DB, user: User = VIEW):
    return pr_out(db, get_po(db, po_id), can_see_cost(db, user))


def transition(db: Session, po: ProductionOrder, allowed: tuple, to: str, note: str | None = None) -> None:
    if po.status not in allowed:
        raise AppError(409, "invalid_transition", f"A {po.status} production order can't become {to}")
    frm, po.status = po.status, to
    audit(db, "status", entity_type="production_orders", entity_id=po.id, before={"status": frm},
          after={"status": to}, note=note)


@orders.post("/{po_id}/release", response_model=PROut)
def release_po(po_id: int, db: DB, user: User = EDIT):
    """Reserve available materials. Shortages are shown on the order."""
    po = get_po(db, po_id)
    transition(db, po, ("draft",), "released")
    reserve(db, po)
    return pr_out(db, po, can_see_cost(db, user))


@orders.post("/{po_id}/start", response_model=PROut)
def start_po(po_id: int, db: DB, user: User = EDIT):
    """Issue all materials (FEFO batches are recorded for traceability). Fails if anything is short."""
    po = get_po(db, po_id)
    transition(db, po, ("draft", "released"), "in_progress")
    issue_materials(db, po)
    po.started_at = utcnow()
    first = db.scalar(select(ProductionStage).where(ProductionStage.production_order_id == po.id)
                      .order_by(ProductionStage.seq).limit(1))
    if first:
        first.status, first.started_at = "in_progress", utcnow()
    return pr_out(db, po, can_see_cost(db, user))


@orders.patch("/{po_id}/stages/{stage_id}", response_model=PROut)
def update_stage(po_id: int, stage_id: int, body: StageIn, db: DB, user: User = EDIT):
    po = get_po(db, po_id)
    st = db.get(ProductionStage, stage_id)
    if st is None or st.production_order_id != po.id:
        raise AppError(404, "not_found", "Stage not found")
    if po.status != "in_progress":
        raise AppError(409, "not_in_progress", "Start the production order first")
    now = utcnow()
    if body.status == "in_progress" and st.started_at is None:
        st.started_at = now
    if body.status == "done":
        st.started_at = st.started_at or now
        st.finished_at = now
    st.status, st.note = body.status, body.note or st.note
    st.assigned_to_id = body.assigned_to_id or st.assigned_to_id or user.id
    audit(db, "stage", entity_type="production_orders", entity_id=po.id, note=f"{st.name}: {body.status}")
    return pr_out(db, po, can_see_cost(db, user))


@orders.post("/{po_id}/complete", response_model=PROut)
def complete_po(po_id: int, body: CompleteIn, db: DB, user: User = EDIT):
    """Record output, rejects, wastage and actual material use. Output goes into stock as a new batch (on QC hold
    when the company requires QC)."""
    po = get_po(db, po_id)
    transition(db, po, ("in_progress",), "completed")
    actual = {int(m["product_id"]): Decimal(str(m["quantity"])) for m in (body.materials or [])}
    if any(q < 0 for q in actual.values()):
        raise AppError(422, "invalid_quantity", "Material quantities can't be negative")
    complete(db, po, body.output_quantity, body.rejected_quantity, body.wastage_quantity, actual,
             body.labour_minutes, body.batch_number, body.mfg_date, body.expiry_date)
    for st in db.scalars(select(ProductionStage).where(ProductionStage.production_order_id == po.id,
                                                       ProductionStage.status != "done")):
        st.status, st.finished_at = "done", utcnow()
    return pr_out(db, po, can_see_cost(db, user))


class CancelIn(BaseModel):
    reason: str = Field(min_length=1)


@orders.post("/{po_id}/cancel", response_model=PROut)
def cancel_po(po_id: int, body: CancelIn, db: DB, user: User = EDIT):
    po = get_po(db, po_id)
    transition(db, po, ("draft", "released"), "cancelled", body.reason)
    release(db, po)
    po.cancelled_reason = body.reason
    return pr_out(db, po, can_see_cost(db, user))


# ---------- documents ----------

def issued_batches(db: Session, po: ProductionOrder) -> list[dict]:
    rows = db.execute(select(StockMovement.product_id, Product.name, Batch.number, Batch.expiry_date,
                             func.sum(-StockMovement.quantity))
                      .join(Product, Product.id == StockMovement.product_id)
                      .outerjoin(Batch, Batch.id == StockMovement.batch_id)
                      .where(StockMovement.reference_type == "production_order", StockMovement.reference_id == po.id,
                             StockMovement.reason.in_(("production_out", "production_return")))
                      .group_by(StockMovement.product_id, Product.name, Batch.number, Batch.expiry_date))
    return [{"product_id": r[0], "name": r[1], "batch": r[2], "expiry": r[3], "quantity": r[4]} for r in rows]


@orders.get("/{po_id}/pdf")
def production_pdf(po_id: int, db: DB, doc: Literal["batch_sheet", "pick_list"] = "batch_sheet", _: User = VIEW):
    po = get_po(db, po_id)
    product, recipe = db.get(Product, po.product_id), db.get(Recipe, po.recipe_id)
    data = render_pdf(db, "production.html", doc=doc, po=po, product=product, recipe=recipe,
                      materials=availability(db, po), issued=issued_batches(db, po),
                      stages=db.scalars(select(ProductionStage).where(ProductionStage.production_order_id == po.id)
                                        .order_by(ProductionStage.seq)).all(),
                      batch=db.get(Batch, po.batch_id) if po.batch_id else None)
    return pdf_response(data, f"{po.number}-{doc}.pdf")


# ======================= planning =======================

planning = APIRouter(prefix="/production", tags=["production"])


def in_production(db: Session, product_id: int) -> Decimal:
    return db.scalar(select(func.coalesce(func.sum(ProductionOrder.planned_quantity), 0)).where(
        ProductionOrder.product_id == product_id, ProductionOrder.status.in_(("draft", "released", "in_progress"))))


@planning.get("/suggestions")
def suggestions(db: DB, warehouse_id: int | None = None, _: User = VIEW):
    """What to make: backordered quantities plus anything below its reorder point, rounded up to whole batches."""
    wh = warehouse_id or default_warehouse_id(db)
    if wh is None:
        return []
    out = []
    active = db.execute(select(Recipe, Product).join(Product, Product.id == Recipe.product_id)
                        .where(Recipe.status == "active", Product.archived_at.is_(None))).all()
    for recipe, p in active:
        backordered = sum((line_backorder(db, ln) for ln in db.scalars(
            select(OrderLine).join(Order).where(OrderLine.product_id == p.id,
                                                Order.status.in_(("confirmed", "processing", "packed"))))), ZERO)
        rule = db.get(ReorderRule, (p.id, wh))
        avail = available(db, p.id, wh)
        coming = in_production(db, p.id)
        below = ZERO
        if rule and rule.reorder_point is not None and avail + coming <= rule.reorder_point:
            target = rule.max_qty or (rule.reorder_point + (rule.reorder_qty or recipe.yield_quantity))
            below = target - avail - coming
        need = max(backordered - coming, ZERO) + max(below, ZERO)
        if need > 0:
            qty = round_up_batches(need, recipe.yield_quantity)
            out.append({"product_id": p.id, "sku": p.sku, "name": p.name, "available": avail,
                        "in_production": coming, "backordered": backordered,
                        "reorder_point": rule.reorder_point if rule else None, "suggested_quantity": qty,
                        "batches": qty / recipe.yield_quantity, "recipe_id": recipe.id,
                        "reason": "backorders" if backordered > coming else "below reorder point"})
    return sorted(out, key=lambda r: -r["backordered"])


class FromSuggestionIn(BaseModel):
    product_id: int
    quantity: Decimal = Field(gt=0)
    planned_start: date | None = None


@planning.post("/suggestions/create", response_model=list[PROut])
def create_from_suggestions(body: list[FromSuggestionIn], db: DB, user: User = CREATE):
    return [pr_out(db, create_production_order(db, POIn(product_id=s.product_id, quantity=s.quantity,
                                                        planned_start=s.planned_start, source="suggestion")),
                   can_see_cost(db, user)) for s in body]


@planning.get("/schedule")
def schedule(db: DB, days: int = 14, _: User = VIEW):
    t = local_today()
    rows = db.scalars(select(ProductionOrder).where(
        ProductionOrder.status.in_(("draft", "released", "in_progress")),
        (ProductionOrder.planned_start.is_(None)) | (ProductionOrder.planned_start <= t + timedelta(days=days)))
        .order_by(ProductionOrder.planned_start.nulls_last(), ProductionOrder.id)).all()
    return [{"id": po.id, "number": po.number, "product_id": po.product_id,
             "product_name": db.get(Product, po.product_id).name, "planned_quantity": po.planned_quantity,
             "planned_start": po.planned_start, "due_date": po.due_date, "status": po.status,
             "assigned_to_id": po.assigned_to_id} for po in rows]


routers = [recipes, orders, planning]
