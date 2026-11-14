"""Demand forecasting and suggested production / material reorder quantities.

Method (simple and explainable): next month = weighted average of the last 3 months (3:2:1, newest heaviest),
multiplied by a seasonal factor (that month last year vs. last year's average) once there are sales in each of the
last 12 months.
"""

from collections import defaultdict
from datetime import date
from decimal import ROUND_CEILING, Decimal

from fastapi import APIRouter
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.access import require_access
from app.auth.models import User
from app.clock import local_today
from app.db import DB
from app.inventory.models import ReorderRule
from app.inventory.service import default_warehouse_id, levels
from app.orders.models import Order, OrderLine
from app.production.models import ProductionMaterial, ProductionOrder, Recipe, RecipeLine
from app.products.models import Product
from app.purchasing.models import PurchaseOrder, PurchaseOrderLine
from app.reports import COUNTED
from app.suppliers import Supplier, SupplierItem

ZERO = Decimal(0)
Q = Decimal("0.001")


def month_add(d: date, n: int) -> date:
    y, m = divmod(d.month - 1 + n, 12)
    return date(d.year + y, m + 1, 1)


def forecast_series(history: list[Decimal], horizon: int) -> list[Decimal]:
    """history: monthly quantities, oldest first, ending with last month. With 12+ months, history[-12:][i] is the
    same calendar month last year as future month i."""
    recent = history[-3:]
    weights = [1, 2, 3][-len(recent):]
    base = sum((Decimal(w) * q for w, q in zip(weights, recent)), ZERO) / sum(weights) if recent else ZERO
    year = history[-12:] if len(history) >= 12 and all(q > 0 for q in history[-12:]) else []  # a real year of sales
    year_avg = sum(year, ZERO) / 12 if year else ZERO
    out = []
    for i in range(horizon):
        factor = min(max(year[i % 12] / year_avg, Decimal("0.5")), Decimal(2)) if year_avg else Decimal(1)
        out.append((base * factor).quantize(Q))
    return out


def monthly_demand(db: Session, months: int = 12) -> tuple[dict[int, list[Decimal]], date]:
    """Quantity ordered per product per full month (oldest first). Returns (history, first future month)."""
    this_month = local_today().replace(day=1)
    start = month_add(this_month, -months)
    key = func.date_trunc("month", Order.order_date)
    rows = db.execute(select(OrderLine.product_id, key, func.sum(OrderLine.quantity))
                      .join(Order, Order.id == OrderLine.order_id)
                      .where(Order.status.in_(COUNTED + ("returned", "refunded")),
                             Order.order_date >= start, Order.order_date < this_month)
                      .group_by(OrderLine.product_id, key)).all()
    hist: dict[int, list[Decimal]] = defaultdict(lambda: [ZERO] * months)
    for pid, m, q in rows:
        idx = (m.year - start.year) * 12 + m.month - start.month
        hist[pid][idx] = q
    return hist, this_month


router = APIRouter(prefix="/forecast", tags=["forecast"])
VIEW = require_access("production", "view")


@router.get("/demand")
def demand(db: DB, months: int = 3, product_id: int | None = None, _: User = require_access("orders", "view")):
    hist, first = monthly_demand(db)
    out = []
    for pid, series in hist.items():
        if product_id and pid != product_id:
            continue
        p = db.get(Product, pid)
        fc = forecast_series(series, months)
        out.append({"product_id": pid, "name": p.name, "sku": p.sku,
                    "history": [{"month": f"{month_add(first, i - len(series)):%Y-%m}", "quantity": q}
                                for i, q in enumerate(series)],
                    "forecast": [{"month": f"{month_add(first, i):%Y-%m}", "quantity": q} for i, q in enumerate(fc)]})
    return sorted(out, key=lambda r: -sum(f["quantity"] for f in r["forecast"]))


def in_production(db: Session, pids: set[int]) -> dict[int, Decimal]:
    """Planned quantity in open production orders per product (missing -> 0)."""
    P = ProductionOrder
    found = dict(db.execute(select(P.product_id, func.sum(P.planned_quantity)).where(
        P.product_id.in_(pids), P.status.in_(("draft", "released", "in_progress"))).group_by(P.product_id)).all())
    return {pid: found.get(pid, Decimal("0")) for pid in pids}


def rules_in(db: Session, pids: set[int], wh: int) -> dict[int, ReorderRule]:
    return {r.product_id: r for r in db.scalars(select(ReorderRule).where(
        ReorderRule.warehouse_id == wh, ReorderRule.product_id.in_(pids)))}


def production_plan(db: Session, months: int, wh: int) -> list[dict]:
    hist, first = monthly_demand(db)
    out = []
    active = db.execute(select(Recipe, Product).join(Product, Product.id == Recipe.product_id)
                        .where(Recipe.status == "active")).all()
    pids = {p.id for _, p in active}
    rules, lv, made = rules_in(db, pids, wh), levels(db, {(pid, wh) for pid in pids}), in_production(db, pids)
    for recipe, p in active:
        demand_qty = sum(forecast_series(hist[p.id], months), ZERO) if p.id in hist else ZERO
        rule = rules.get(p.id)
        safety = (rule.safety_stock or ZERO) if rule else ZERO
        avail, coming = lv[p.id, wh][1], made[p.id]
        need = demand_qty + safety - avail - coming
        batches = (need / recipe.yield_quantity).to_integral_value(rounding=ROUND_CEILING) if need > 0 else ZERO
        out.append({"product_id": p.id, "name": p.name, "forecast": demand_qty, "safety_stock": safety,
                    "available": avail, "in_production": coming, "suggested_quantity": batches * recipe.yield_quantity,
                    "batches": batches, "recipe_id": recipe.id})
    return sorted(out, key=lambda r: -r["suggested_quantity"])


@router.get("/production")
def production(db: DB, months: int = 1, warehouse_id: int | None = None, _: User = VIEW):
    wh = warehouse_id or default_warehouse_id(db)
    return production_plan(db, months, wh) if wh else []


@router.get("/materials")
def materials(db: DB, warehouse_id: int | None = None, cover_days: int = 30,
              _: User = require_access("purchasing", "view")):
    """Raw materials and packaging to order: what planned production needs over each supplier's lead time plus
    `cover_days`, minus stock and open purchase orders."""
    wh = warehouse_id or default_warehouse_id(db)
    if wh is None:
        return []
    need: dict[int, Decimal] = defaultdict(lambda: ZERO)
    plan = production_plan(db, 1, wh)  # next month's suggested production
    recipes = {r.id: r for r in db.scalars(select(Recipe).where(Recipe.id.in_([row["recipe_id"] for row in plan])))}
    lines: dict[int, list[RecipeLine]] = defaultdict(list)
    for ln in db.scalars(select(RecipeLine).where(RecipeLine.recipe_id.in_(recipes)).order_by(RecipeLine.id)):
        lines[ln.recipe_id].append(ln)
    for row in plan:
        r = recipes[row["recipe_id"]]
        for ln in lines[r.id]:
            need[ln.product_id] += ln.base_quantity * row["suggested_quantity"] / r.yield_quantity * (
                1 + ln.wastage_pct / 100)
    for m in db.scalars(select(ProductionMaterial).join(ProductionOrder).where(
            ProductionOrder.status.in_(("draft", "released")))):
        need[m.product_id] += m.required_quantity - m.issued_quantity
    on_order = dict(db.execute(select(PurchaseOrderLine.product_id,
                                      func.sum(PurchaseOrderLine.base_quantity - PurchaseOrderLine.received_base_qty))
                               .join(PurchaseOrder).where(PurchaseOrder.status.in_(
                                   ("approved", "ordered", "partially_received")))
                               .group_by(PurchaseOrderLine.product_id)).all())
    pids = set(need)
    products = {p.id: p for p in db.scalars(select(Product).where(Product.id.in_(pids)))}
    best: dict[int, SupplierItem] = {}  # preferred supplier item per product (else the first one)
    for item in db.scalars(select(SupplierItem).where(SupplierItem.product_id.in_(pids))
                           .order_by(SupplierItem.product_id, SupplierItem.is_preferred.desc(), SupplierItem.id)):
        best.setdefault(item.product_id, item)
    suppliers = {s.id: s for s in db.scalars(select(Supplier).where(
        Supplier.id.in_({i.supplier_id for i in best.values()})))}
    rules, lv = rules_in(db, pids, wh), levels(db, {(pid, wh) for pid in pids})
    out = []
    for pid, qty in need.items():
        p, item, avail = products[pid], best.get(pid), lv[pid, wh][1]
        lead = (item.lead_time_days or 7) if item else 7
        window = Decimal(lead + cover_days) / 30  # need is for ~one month of production
        rule = rules.get(pid)
        target = qty * window + ((rule.safety_stock or ZERO) if rule else ZERO)
        short = target - avail - on_order.get(pid, ZERO)
        if short <= 0:
            continue
        if item and item.min_order_qty and short < item.min_order_qty:
            short = item.min_order_qty
        out.append({"product_id": pid, "name": p.name, "type": p.type, "needed": qty.quantize(Q),
                    "available": avail, "on_order": on_order.get(pid, ZERO),
                    "lead_time_days": lead, "suggested_order": short.quantize(Q),
                    "supplier_id": item.supplier_id if item else None,
                    "supplier": suppliers[item.supplier_id].name if item else None})
    return sorted(out, key=lambda r: -r["suggested_order"])


routers = [router]
