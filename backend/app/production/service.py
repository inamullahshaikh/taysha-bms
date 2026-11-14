"""Production logic: material requirements, reservations, issuing, completion and batch costing."""

import math
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.audit import audit
from app.clock import local_today, utcnow
from app.company import get_company
from app.errors import AppError
from app.inventory.models import StockBalance, StockMovement, StockReservation
from app.inventory.service import (
    available, avg_cost, fill_backorders, get_or_create_batch, issue, move, usable_batch,
)
from app.numbering import next_number
from app.production.models import ProductionMaterial, ProductionOrder, Recipe, RecipeLine
from app.products.models import Product
from app.products.pricing import money

ZERO = Decimal(0)
QTY = Decimal("0.001")


def requirements(db: Session, recipe: Recipe, quantity: Decimal) -> list[tuple[int, Decimal]]:
    """(component product id, base quantity needed incl. expected wastage) for `quantity` of output."""
    factor = quantity / recipe.yield_quantity
    out = []
    for ln in db.scalars(select(RecipeLine).where(RecipeLine.recipe_id == recipe.id).order_by(RecipeLine.id)):
        out.append((ln.product_id, (ln.base_quantity * factor * (1 + ln.wastage_pct / 100)).quantize(QTY)))
    return out


def labour_cost(db: Session, minutes: int | None) -> Decimal:
    return money(Decimal(minutes or 0) / 60 * get_company(db).labour_rate_per_hour)


def standard_cost(db: Session, recipe: Recipe, quantity: Decimal) -> dict:
    materials = sum((qty * avg_cost(db, pid) for pid, qty in requirements(db, recipe, quantity)), ZERO)
    batches = quantity / recipe.yield_quantity
    labour = labour_cost(db, int((recipe.labour_minutes or 0) * batches))
    overhead = money(materials * get_company(db).overhead_pct / 100)
    total = money(materials) + labour + overhead
    return {"materials": money(materials), "labour": labour, "overhead": overhead, "total": total,
            "per_unit": (total / quantity).quantize(Decimal("0.0001")) if quantity else None}


def materials(db: Session, po: ProductionOrder) -> list[ProductionMaterial]:
    return db.scalars(select(ProductionMaterial).where(ProductionMaterial.production_order_id == po.id)
                      .order_by(ProductionMaterial.id)).all()


def reserved_for(db: Session, po: ProductionOrder, product_id: int) -> Decimal:
    return db.scalar(select(func.coalesce(func.sum(StockReservation.quantity), 0)).where(
        StockReservation.production_order_id == po.id, StockReservation.product_id == product_id))


def availability_many(db: Session, pos: list[ProductionOrder]) -> dict[int, list[tuple[ProductionMaterial, dict]]]:
    """Per order: (material, row) with required, issued, reserved for this order, free stock and shortage.
    A fixed handful of queries however many orders and materials."""
    ids = [po.id for po in pos]
    mats = db.scalars(select(ProductionMaterial).where(ProductionMaterial.production_order_id.in_(ids))
                      .order_by(ProductionMaterial.id)).all()
    pids = {m.product_id for m in mats}
    products = {p.id: p for p in db.scalars(select(Product).where(Product.id.in_(pids)))}
    R = StockReservation
    mine = {(o, p): q for o, p, q in db.execute(
        select(R.production_order_id, R.product_id, func.sum(R.quantity)).where(R.production_order_id.in_(ids))
        .group_by(R.production_order_id, R.product_id))}
    free: dict[tuple[int, int], Decimal] = {}
    for wh in {po.warehouse_id for po in pos}:
        usable = dict(db.execute(select(StockBalance.product_id, func.sum(StockBalance.quantity)).where(
            StockBalance.product_id.in_(pids), StockBalance.warehouse_id == wh, usable_batch())
            .group_by(StockBalance.product_id)).all())
        held = dict(db.execute(select(R.product_id, func.sum(R.quantity)).where(
            R.product_id.in_(pids), R.warehouse_id == wh).group_by(R.product_id)).all())
        for pid in pids:  # same as available(): usable on hand minus everything reserved in that warehouse
            free[wh, pid] = usable.get(pid, Decimal("0")) - held.get(pid, Decimal("0"))
    wh_of = {po.id: po.warehouse_id for po in pos}
    out: dict[int, list] = {i: [] for i in ids}
    for m in mats:
        p, po_id = products[m.product_id], m.production_order_id
        reserved_here = mine.get((po_id, m.product_id), Decimal("0"))
        f = free[wh_of[po_id], m.product_id]
        short = max(m.required_quantity - m.issued_quantity - reserved_here - max(f, ZERO), ZERO)
        out[po_id].append((m, {"product_id": p.id, "sku": p.sku, "name": p.name, "required": m.required_quantity,
                               "issued": m.issued_quantity, "reserved": reserved_here, "free_in_stock": max(f, ZERO),
                               "shortage": short.quantize(QTY)}))
    return out


def availability(db: Session, po: ProductionOrder) -> list[dict]:
    return [row for _, row in availability_many(db, [po])[po.id]]


def reserve(db: Session, po: ProductionOrder) -> None:
    for m in materials(db, po):
        want = m.required_quantity - m.issued_quantity - reserved_for(db, po, m.product_id)
        take = min(want, max(available(db, m.product_id, po.warehouse_id), ZERO))
        if take > 0:
            db.add(StockReservation(production_order_id=po.id, product_id=m.product_id,
                                    warehouse_id=po.warehouse_id, quantity=take))
            db.flush()


def release(db: Session, po: ProductionOrder) -> None:
    db.execute(delete(StockReservation).where(StockReservation.production_order_id == po.id))


def issue_materials(db: Session, po: ProductionOrder) -> None:
    """Issue everything still needed (FEFO). All-or-nothing: a shortage stops the start."""
    short = [r for r in availability(db, po) if r["shortage"] > 0]
    if short:
        names = ", ".join(f"{r['name']} ({r['shortage'].normalize():f})" for r in short)
        raise AppError(409, "material_shortage", f"Not enough materials: {names}")
    release(db, po)
    ref = ("production_order", po.id, po.number)
    for m in materials(db, po):
        qty = m.required_quantity - m.issued_quantity
        if qty > 0:
            issue(db, product_id=m.product_id, warehouse_id=po.warehouse_id, quantity=qty, reason="production_out",
                  ref=ref)
            m.issued_quantity += qty


def complete(db: Session, po: ProductionOrder, output: Decimal, rejected: Decimal, wastage: Decimal,
             actual: dict[int, Decimal], labour_minutes: int | None, batch_number: str | None,
             mfg_date, expiry_date) -> None:
    ref = ("production_order", po.id, po.number)
    for m in materials(db, po):
        used = actual.get(m.product_id, m.issued_quantity)
        diff = used - m.issued_quantity
        if diff > 0:  # used more than issued: take the extra now
            issue(db, product_id=m.product_id, warehouse_id=po.warehouse_id, quantity=diff, reason="production_out",
                  ref=ref, note="extra used")
        elif diff < 0:  # leftovers go back to stock at the current average cost
            move(db, product_id=m.product_id, warehouse_id=po.warehouse_id, quantity=-diff, reason="production_return",
                 ref=ref, note="unused material returned")
        m.issued_quantity, m.actual_quantity = used, used

    moved = db.scalar(select(func.coalesce(func.sum(-StockMovement.quantity * StockMovement.unit_cost), 0)).where(
        StockMovement.reference_type == "production_order", StockMovement.reference_id == po.id,
        StockMovement.reason.in_(("production_out", "production_return"))))
    company = get_company(db)
    po.material_cost = money(moved)
    po.labour_minutes = labour_minutes if labour_minutes is not None else po.labour_minutes
    po.labour_cost = labour_cost(db, po.labour_minutes)
    po.overhead_cost = money(po.material_cost * company.overhead_pct / 100)
    po.actual_cost = po.material_cost + po.labour_cost + po.overhead_cost
    po.output_quantity, po.rejected_quantity, po.wastage_quantity = output, rejected, wastage

    product = db.get(Product, po.product_id)
    if output > 0:
        mfg = mfg_date or local_today()
        exp = expiry_date or (mfg + timedelta(days=product.shelf_life_days) if product.shelf_life_days else None)
        number = batch_number or next_number(db, "batch")
        batch = get_or_create_batch(db, product.id, number, mfg_date=mfg, expiry_date=exp,
                                    status="hold" if company.production_requires_qc else "available")
        if batch.status == "available" and company.production_requires_qc:
            batch.status = "hold"
        po.batch_id = batch.id
        move(db, product_id=product.id, warehouse_id=po.warehouse_id, quantity=output, reason="production_in",
             batch_id=batch.id, unit_cost=po.actual_cost / output, ref=ref)
        if batch.status == "available":
            fill_backorders(db, product.id, po.warehouse_id)
    po.status, po.completed_at = "completed", utcnow()
    audit(db, "complete", entity_type="production_orders", entity_id=po.id,
          after={"output": str(output), "rejected": str(rejected), "cost": str(po.actual_cost)})


def round_up_batches(qty: Decimal, batch_size: Decimal) -> Decimal:
    return Decimal(math.ceil(qty / batch_size)) * batch_size
