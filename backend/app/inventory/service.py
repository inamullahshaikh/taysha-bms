"""The only place stock changes. Every change = locked balance row + one append-only movement, in the caller's
transaction. Weighted average cost is kept per product. Batches are issued FEFO (earliest expiry first).

If no warehouse exists yet, stock isn't tracked at all (orders still work); create a warehouse to turn it on.
"""

from collections import defaultdict
from datetime import date
from decimal import Decimal

from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.clock import local_today
from app.company import Unit, get_company
from app.errors import AppError, not_found
from app.inventory.models import (
    COSTED_IN, Batch, ProductStockCost, StockBalance, StockMovement, StockReservation, Warehouse,
)
from app.products.models import BundleComponent, Product, ProductUnit

ZERO = Decimal(0)
QTY = Decimal("0.001")
Ref = tuple[str, int | None, str | None]  # (type, id, number)


# ---------- units ----------

def to_base_qty(db: Session, product: Product, qty: Decimal, unit: str | None) -> Decimal:
    """qty in `unit` (global unit code like 'kg', or a product pack name like 'carton') -> product base unit."""
    if not unit:
        return qty
    base = db.get(Unit, product.unit_id)
    if unit == base.code:
        return qty
    pack = db.scalar(select(ProductUnit).where(ProductUnit.product_id == product.id, ProductUnit.name == unit))
    if pack:
        return qty * pack.factor
    u = db.scalar(select(Unit).where(Unit.code == unit))
    if u is None or u.dimension != base.dimension:
        raise AppError(422, "unit_mismatch", f"{product.name} is stocked in {base.code}; can't use {unit}")
    return qty * u.factor / base.factor


# ---------- queries ----------

def default_warehouse_id(db: Session) -> int | None:
    wid = get_company(db).default_warehouse_id
    return wid or db.scalar(select(Warehouse.id).where(Warehouse.archived_at.is_(None)).order_by(Warehouse.id))


def usable_batch():
    """Balance rows whose batch can be sold/used: no batch, or an available batch that hasn't expired."""
    return or_(StockBalance.batch_id.is_(None),
               StockBalance.batch_id.in_(select(Batch.id).where(
                   Batch.status == "available", or_(Batch.expiry_date.is_(None), Batch.expiry_date >= local_today()))))


def on_hand(db: Session, product_id: int, warehouse_id: int | None = None, usable_only: bool = False) -> Decimal:
    q = select(func.coalesce(func.sum(StockBalance.quantity), 0)).where(StockBalance.product_id == product_id)
    if warehouse_id:
        q = q.where(StockBalance.warehouse_id == warehouse_id)
    if usable_only:
        q = q.where(usable_batch())
    return db.scalar(q)


def reserved(db: Session, product_id: int, warehouse_id: int, exclude_line_id: int | None = None) -> Decimal:
    q = select(func.coalesce(func.sum(StockReservation.quantity), 0)).where(
        StockReservation.product_id == product_id, StockReservation.warehouse_id == warehouse_id)
    if exclude_line_id:
        q = q.where(StockReservation.order_line_id != exclude_line_id)
    return db.scalar(q)


def available(db: Session, product_id: int, warehouse_id: int) -> Decimal:
    return on_hand(db, product_id, warehouse_id, usable_only=True) - reserved(db, product_id, warehouse_id)


def levels(db: Session, pairs: set[tuple[int, int]]) -> dict[tuple[int, int], tuple[Decimal, Decimal]]:
    """(product, warehouse) -> (on hand, available) for many pairs in three queries; same maths as
    on_hand() and available()."""
    pids = {p for p, _ in pairs}
    if not pids:
        return {}
    B, R, z = StockBalance, StockReservation, Decimal("0")
    q = select(B.product_id, B.warehouse_id, func.sum(B.quantity)).where(B.product_id.in_(pids)) \
        .group_by(B.product_id, B.warehouse_id)
    oh = {(p, w): v for p, w, v in db.execute(q)}
    usable = {(p, w): v for p, w, v in db.execute(q.where(usable_batch()))}
    res = {(p, w): v for p, w, v in db.execute(select(R.product_id, R.warehouse_id, func.sum(R.quantity))
                                               .where(R.product_id.in_(pids)).group_by(R.product_id, R.warehouse_id))}
    return {k: (oh.get(k, z), usable.get(k, z) - res.get(k, z)) for k in pairs}


def avg_cost(db: Session, product_id: int) -> Decimal:
    return db.scalar(select(ProductStockCost.avg_cost).where(ProductStockCost.product_id == product_id)) or ZERO


def avg_costs(db: Session, product_ids: list[int]) -> dict[int, Decimal]:
    """avg_cost() for many products in one query (missing -> 0)."""
    found = dict(db.execute(select(ProductStockCost.product_id, ProductStockCost.avg_cost)
                            .where(ProductStockCost.product_id.in_(product_ids))).all())
    return {pid: found.get(pid) or ZERO for pid in product_ids}


# ---------- the one write path ----------

def _balance(db: Session, product_id: int, warehouse_id: int, location_id: int | None,
             batch_id: int | None) -> StockBalance:
    db.execute(insert(StockBalance).values(product_id=product_id, warehouse_id=warehouse_id, location_id=location_id,
                                           batch_id=batch_id, quantity=0)
               .on_conflict_do_nothing(constraint="uq_stock_balances_key"))
    cond = [StockBalance.product_id == product_id, StockBalance.warehouse_id == warehouse_id,
            StockBalance.location_id.is_(None) if location_id is None else StockBalance.location_id == location_id,
            StockBalance.batch_id.is_(None) if batch_id is None else StockBalance.batch_id == batch_id]
    return db.scalar(select(StockBalance).where(and_(*cond)).with_for_update())


def move(db: Session, *, product_id: int, warehouse_id: int, quantity: Decimal, reason: str,
         batch_id: int | None = None, location_id: int | None = None, unit_cost: Decimal | None = None,
         ref: Ref = (None, None, None), note: str | None = None, on: date | None = None,
         allow_negative: bool = False) -> StockMovement:
    if quantity == 0:
        raise AppError(422, "zero_quantity", "Quantity can't be zero")
    product = db.get(Product, product_id)
    if product is None:
        raise not_found("Product")
    if product.kind == "bundle":
        raise AppError(422, "bundle_stock", "Bundles hold no stock; their components do")
    bal = _balance(db, product_id, warehouse_id, location_id, batch_id)
    if quantity < 0 and bal.quantity + quantity < 0 and not allow_negative:
        raise AppError(409, "insufficient_stock",
                       f"Only {bal.quantity.normalize():f} of {product.name} here; can't remove {(-quantity).normalize():f}")

    if quantity > 0 and reason in COSTED_IN and unit_cost is not None:
        db.execute(insert(ProductStockCost).values(product_id=product_id, avg_cost=0).on_conflict_do_nothing())
        cost = db.scalar(select(ProductStockCost).where(ProductStockCost.product_id == product_id).with_for_update())
        q0 = max(on_hand(db, product_id), ZERO)
        cost.avg_cost = unit_cost if q0 == 0 else (q0 * cost.avg_cost + quantity * unit_cost) / (q0 + quantity)
    elif unit_cost is None:
        unit_cost = avg_cost(db, product_id)  # outflows (and uncosted inflows) carry the current average

    bal.quantity += quantity
    m = StockMovement(movement_date=on or local_today(), product_id=product_id, warehouse_id=warehouse_id,
                      location_id=location_id, batch_id=batch_id, quantity=quantity, unit_cost=unit_cost,
                      balance_after=bal.quantity, reason=reason, reference_type=ref[0], reference_id=ref[1],
                      reference_number=ref[2], note=note, user_id=db.info.get("user_id"))
    db.add(m)
    db.flush()
    return m


def issue(db: Session, *, product_id: int, warehouse_id: int, quantity: Decimal, reason: str,
          batch_id: int | None = None, location_id: int | None = None, ref: Ref = (None, None, None),
          note: str | None = None, respect_reservations: bool = True) -> list[StockMovement]:
    """Take `quantity` (positive) out. Without a batch, picks FEFO across usable batches/locations."""
    if quantity <= 0:
        raise AppError(422, "invalid_quantity", "Quantity must be positive")
    if batch_id is not None:
        return [move(db, product_id=product_id, warehouse_id=warehouse_id, quantity=-quantity, reason=reason,
                     batch_id=batch_id, location_id=location_id, ref=ref, note=note)]
    if respect_reservations:
        free = available(db, product_id, warehouse_id)
        if free < quantity:
            p = db.get(Product, product_id)
            raise AppError(409, "insufficient_stock",
                           f"Only {max(free, ZERO).normalize():f} of {p.name} is free (the rest is reserved or unusable)")
    q = (select(StockBalance).outerjoin(Batch, Batch.id == StockBalance.batch_id)
         .where(StockBalance.product_id == product_id, StockBalance.warehouse_id == warehouse_id,
                StockBalance.quantity > 0, usable_batch())
         .order_by(Batch.expiry_date.asc().nulls_last(), Batch.id.asc().nulls_first(), StockBalance.id)
         .with_for_update(of=StockBalance))
    if location_id is not None:
        q = q.where(StockBalance.location_id == location_id)
    moves, left = [], quantity
    for bal in db.scalars(q):
        take = min(left, bal.quantity)
        moves.append(move(db, product_id=product_id, warehouse_id=warehouse_id, quantity=-take, reason=reason,
                          batch_id=bal.batch_id, location_id=bal.location_id, ref=ref, note=note))
        left -= take
        if left == 0:
            return moves
    p = db.get(Product, product_id)
    raise AppError(409, "insufficient_stock", f"Not enough usable {p.name} in stock ({(quantity - left).normalize():f} found)")


def get_or_create_batch(db: Session, product_id: int, number: str, **fields) -> Batch:
    b = db.scalar(select(Batch).where(Batch.product_id == product_id, Batch.number == number))
    if b is None:
        b = Batch(product_id=product_id, number=number, **{k: v for k, v in fields.items() if v is not None})
        db.add(b)
        db.flush()
    return b


# ---------- orders: reservations, shipping, backorders ----------

def stock_needs(db: Session, product_id: int, qty: Decimal) -> list[tuple[int, Decimal]]:
    """What stock an order line consumes: the product itself, or a bundle's components."""
    p = db.get(Product, product_id)
    if p.kind == "bundle":
        comps = db.execute(select(BundleComponent.component_id, BundleComponent.quantity)
                           .where(BundleComponent.bundle_id == product_id)).all()
        return [(cid, cq * qty) for cid, cq in comps if db.get(Product, cid).track_stock]
    return [(product_id, qty)] if p.track_stock else []


def order_warehouse(db: Session, order) -> int | None:
    if order.warehouse_id is None:
        order.warehouse_id = default_warehouse_id(db)
    return order.warehouse_id


def reserve_order(db: Session, order) -> None:
    """Reserve what's available for each unshipped line; the rest is backordered."""
    from app.orders.models import OrderLine

    wh = order_warehouse(db, order)
    if wh is None:
        return
    for line in db.scalars(select(OrderLine).where(OrderLine.order_id == order.id).order_by(OrderLine.line_no)):
        for pid, need in stock_needs(db, line.product_id, line.quantity - line.shipped_qty):
            have = db.scalar(select(func.coalesce(func.sum(StockReservation.quantity), 0)).where(
                StockReservation.order_line_id == line.id, StockReservation.product_id == pid))
            want = need - have
            if want <= 0:
                continue
            take = min(want, max(available(db, pid, wh), ZERO))
            if take > 0:
                db.add(StockReservation(order_id=order.id, order_line_id=line.id, product_id=pid, warehouse_id=wh,
                                        quantity=take))
                db.flush()


def release_order(db: Session, order) -> None:
    db.execute(delete(StockReservation).where(StockReservation.order_id == order.id))


def line_reserved(db: Session, line) -> dict[int, Decimal]:
    rows = db.execute(select(StockReservation.product_id, func.sum(StockReservation.quantity))
                      .where(StockReservation.order_line_id == line.id).group_by(StockReservation.product_id))
    return {pid: q for pid, q in rows}


def line_backorder(db: Session, line) -> Decimal:
    """Unshipped quantity (in line units) not covered by reservations."""
    remaining = line.quantity - line.shipped_qty
    needs = stock_needs(db, line.product_id, Decimal(1))
    if not needs or remaining <= 0:
        return ZERO
    res = line_reserved(db, line)
    covered = min(res.get(pid, ZERO) / per for pid, per in needs)
    return max(remaining - covered, ZERO)


def fill_backorders(db: Session, product_id: int, warehouse_id: int) -> None:
    """After stock arrives, reserve it for the oldest confirmed orders that are waiting for it."""
    from app.orders.models import Order, OrderLine

    comp_of = select(BundleComponent.bundle_id).where(BundleComponent.component_id == product_id)
    orders = db.scalars(
        select(Order).where(Order.status.in_(("confirmed", "processing", "packed")), Order.warehouse_id == warehouse_id,
                            Order.id.in_(select(OrderLine.order_id).where(
                                or_(OrderLine.product_id == product_id, OrderLine.product_id.in_(comp_of)),
                                OrderLine.quantity > OrderLine.shipped_qty)))
        .order_by(Order.confirmed_at, Order.id)).all()
    for o in orders:
        if available(db, product_id, warehouse_id) <= 0:
            break
        reserve_order(db, o)


def ship_lines(db: Session, order, quantities: dict[int, Decimal], shipment_ref: Ref) -> None:
    """Issue stock for the given line quantities, using the line's reservations first. Records actual cost."""
    from app.orders.models import OrderLine

    wh = order_warehouse(db, order)
    for line_id, qty in quantities.items():
        line = db.get(OrderLine, line_id)
        if line is None or line.order_id != order.id:
            raise not_found("Order line")
        if qty <= 0 or qty > line.quantity - line.shipped_qty:
            raise AppError(422, "invalid_ship_qty", f"Line {line.line_no}: can ship at most "
                                                    f"{(line.quantity - line.shipped_qty).normalize():f}")
        cost = ZERO
        if wh is not None:
            for pid, need in stock_needs(db, line.product_id, qty):
                res_rows = db.scalars(select(StockReservation).where(
                    StockReservation.order_line_id == line.id, StockReservation.product_id == pid)
                    .with_for_update()).all()
                from_res = min(need, sum((r.quantity for r in res_rows), ZERO))
                left = from_res
                for r in res_rows:  # consume reservation rows
                    use = min(left, r.quantity)
                    r.quantity -= use
                    left -= use
                    if r.quantity == 0:
                        db.delete(r)
                db.flush()
                if need > available(db, pid, wh):  # our reservation is released above, so it's counted here
                    p = db.get(Product, pid)
                    raise AppError(409, "backordered",
                                   f"Line {line.line_no}: not enough {p.name} in stock to ship {qty.normalize():f}")
                for m in issue(db, product_id=pid, warehouse_id=wh, quantity=need, reason="sale", ref=shipment_ref,
                               respect_reservations=False):
                    cost += -m.quantity * (m.unit_cost or ZERO)
        prev_cost = (line.unit_cost or ZERO) * line.shipped_qty if line.cost_from_stock else ZERO
        line.shipped_qty += qty
        if wh is not None and stock_needs(db, line.product_id, Decimal(1)):
            line.unit_cost = (prev_cost + cost) / line.shipped_qty  # actual weighted-average cost replaces standard
            line.cost_from_stock = True
    db.flush()


def stock_summary(db: Session, product_ids: list[int], warehouse_id: int | None) -> dict[int, dict]:
    out: dict[int, dict] = defaultdict(lambda: {"on_hand": ZERO, "usable": ZERO, "reserved": ZERO})
    q = select(StockBalance.product_id, func.sum(StockBalance.quantity)).where(
        StockBalance.product_id.in_(product_ids)).group_by(StockBalance.product_id)
    if warehouse_id:
        q = q.where(StockBalance.warehouse_id == warehouse_id)
    for pid, qty in db.execute(q):
        out[pid]["on_hand"] = qty
    for pid, qty in db.execute(q.where(usable_batch())):
        out[pid]["usable"] = qty
    rq = select(StockReservation.product_id, func.sum(StockReservation.quantity)).where(
        StockReservation.product_id.in_(product_ids)).group_by(StockReservation.product_id)
    if warehouse_id:
        rq = rq.where(StockReservation.warehouse_id == warehouse_id)
    for pid, qty in db.execute(rq):
        out[pid]["reserved"] = qty
    for pid in product_ids:
        d = out[pid]
        d["available"] = d["usable"] - d["reserved"]
        for k in d:
            d[k] = Decimal(d[k]).quantize(QTY)
    return out
