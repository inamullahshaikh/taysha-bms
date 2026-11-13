"""Order business logic: pricing, totals, status changes, payment status. All money maths on the server."""

from datetime import date
from decimal import Decimal

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.audit import audit
from app.auth.access import can
from app.auth.models import User
from app.clock import local_today, utcnow
from app.customers import Customer, CustomerAddress
from app.errors import AppError, not_found
from app.orders.calc import LineCalc, Totals, calculate
from app.orders.models import TRANSITIONS, DiscountCode, Order, OrderLine, OrderStatusHistory, Payment
from app.products.models import PriceList, Product, SalesChannel
from app.products.pricing import current_cost, resolve_price, tax_rate_of

ZERO = Decimal(0)
TYPE_PRICE_LIST = {"wholesale": "wholesale", "cafe": "cafe", "distributor": "distributor"}
FREE_ORDER_TYPES = ("sample", "promotional")
LOCKED = ("cancelled", "returned", "refunded")


def pick_price_list(db: Session, order_type: str, customer: Customer | None, explicit_id: int | None) -> PriceList:
    if explicit_id:
        pl = db.get(PriceList, explicit_id)
        if pl is None:
            raise not_found("Price list")
        return pl
    if customer and customer.price_list_id:
        return db.get(PriceList, customer.price_list_id)
    code = TYPE_PRICE_LIST.get(order_type) or TYPE_PRICE_LIST.get(customer.type if customer else "", "retail")
    return db.scalar(select(PriceList).where(PriceList.code == code)) or db.scalar(
        select(PriceList).where(PriceList.code == "retail"))


def discount_code_value(db: Session, code: str, subtotal: Decimal, on: date,
                        exclude_order_id: int | None = None) -> tuple[DiscountCode, Decimal, Decimal]:
    """Validate a code; returns (code, pct, amount)."""
    dc = db.scalar(select(DiscountCode).where(DiscountCode.code == code.strip().upper(),
                                              DiscountCode.archived_at.is_(None)))
    if dc is None or not dc.is_active:
        raise AppError(422, "invalid_discount_code", "That discount code doesn't exist or is inactive",
                       {"discount_code": "invalid"})
    if (dc.valid_from and on < dc.valid_from) or (dc.valid_to and on > dc.valid_to):
        raise AppError(422, "expired_discount_code", "That discount code isn't valid today",
                       {"discount_code": "dates"})
    if dc.min_order_amount and subtotal < dc.min_order_amount:
        raise AppError(422, "discount_minimum", f"Order must be at least {dc.min_order_amount} for this code",
                       {"discount_code": "minimum"})
    if dc.max_uses is not None:
        q = select(func.count()).select_from(Order).where(Order.discount_code_id == dc.id,
                                                          Order.status != "cancelled")
        if exclude_order_id:
            q = q.where(Order.id != exclude_order_id)
        if db.scalar(q) >= dc.max_uses:
            raise AppError(422, "discount_used_up", "That discount code has been used up",
                           {"discount_code": "used up"})
    return (dc, dc.value, ZERO) if dc.kind == "percent" else (dc, ZERO, dc.value)


def price_order(db: Session, user: User, body, order_id: int | None = None) -> dict:
    """Resolve prices/taxes for an order body and compute totals. Writes nothing."""
    on = body.order_date or local_today()
    customer = db.get(Customer, body.customer_id) if body.customer_id else None
    if body.customer_id and customer is None:
        raise not_found("Customer")
    if body.channel and not db.scalar(select(SalesChannel.id).where(SalesChannel.code == body.channel)):
        raise AppError(422, "unknown_channel", "Unknown sales channel", {"channel": "unknown"})
    pl = pick_price_list(db, body.order_type, customer, body.price_list_id)
    may_override = can(db, user, "order_pricing", "edit")

    lines, calcs = [], []
    for i, ln in enumerate(body.lines):
        p = db.get(Product, ln.product_id)
        if p is None:
            raise not_found(f"Product on line {i + 1}")
        if p.archived_at is not None or p.status == "discontinued":
            raise AppError(422, "product_unavailable", f"{p.name} is no longer sold", {f"lines.{i}": "unavailable"})
        listed = resolve_price(db, p.id, pl.id, on) if pl else None
        list_price = listed.price if listed else None
        if body.order_type in FREE_ORDER_TYPES and ln.unit_price is None:
            unit_price = ZERO
        elif ln.unit_price is not None:
            unit_price = ln.unit_price
        elif list_price is not None:
            unit_price = list_price
        else:
            raise AppError(422, "no_price", f"{p.name} has no {pl.name} price; enter a price",
                           {f"lines.{i}.unit_price": "required"})
        overridden = body.order_type not in FREE_ORDER_TYPES and list_price is not None and unit_price != list_price
        overridden = overridden or (list_price is None and ln.unit_price is not None)
        if (overridden or ln.discount_pct or ln.discount_amount) and not may_override:
            raise AppError(403, "pricing_not_allowed", "You don't have access to change prices or give discounts",
                           {f"lines.{i}": "pricing"})
        rate = tax_rate_of(db, p)
        calcs.append(LineCalc(quantity=ln.quantity, unit_price=unit_price, tax_rate=rate,
                              discount_pct=ln.discount_pct, discount_amount=ln.discount_amount))
        lines.append({"product": p, "list_price": list_price, "overridden": overridden,
                      "description": ln.description or p.name})

    if (body.order_discount_pct or body.order_discount_amount) and not may_override:
        raise AppError(403, "pricing_not_allowed", "You don't have access to give discounts",
                       {"order_discount": "pricing"})
    pct, amount, dc = body.order_discount_pct, body.order_discount_amount, None
    if body.discount_code:
        pre = calculate(calcs, delivery_charge=ZERO)
        dc, code_pct, code_amount = discount_code_value(db, body.discount_code, pre.subtotal, on, order_id)
        pct, amount = pct + code_pct, amount + code_amount
    totals = calculate(calcs, pct, amount, body.delivery_charge)
    return {"customer": customer, "price_list": pl, "lines": lines, "totals": totals, "discount_code": dc,
            "order_date": on, "order_discount_pct": pct, "order_discount_amount": amount}


def address_snapshot(db: Session, customer: Customer | None, address_id: int | None, manual: dict | None,
                     kind: str) -> dict | None:
    if manual:
        return manual
    if not customer:
        return None
    q = select(CustomerAddress).where(CustomerAddress.customer_id == customer.id,
                                      CustomerAddress.archived_at.is_(None))
    if address_id:
        a = db.scalar(q.where(CustomerAddress.id == address_id))
        if a is None:
            raise not_found("Address")
    else:
        flag = CustomerAddress.is_default_shipping if kind == "shipping" else CustomerAddress.is_default_billing
        a = db.scalar(q.where(flag)) or db.scalar(q.order_by(CustomerAddress.id))
    if a is None:
        return None
    return {k: getattr(a, k) for k in ("label", "line1", "line2", "area", "city", "postal_code", "phone")}


def apply_priced(db: Session, order: Order, body, priced: dict) -> None:
    """Write header fields and replace lines from a price_order() result."""
    t: Totals = priced["totals"]
    c = priced["customer"]
    order.order_date = priced["order_date"]
    order.customer_id = c.id if c else None
    order.customer_name = c.name if c else body.customer_name
    order.customer_phone = c.phone if c else body.customer_phone
    order.order_type = body.order_type
    order.channel = body.channel
    order.price_list_id = priced["price_list"].id if priced["price_list"] else None
    order.branch_id = body.branch_id
    order.payment_method = body.payment_method
    order.delivery_method = body.delivery_method
    order.shipping_address = address_snapshot(db, c, body.shipping_address_id, body.shipping_address, "shipping")
    order.billing_address = address_snapshot(db, c, None, body.billing_address, "billing") \
        or order.shipping_address
    order.discount_code_id = priced["discount_code"].id if priced["discount_code"] else None
    order.order_discount_pct = priced["order_discount_pct"]
    order.order_discount_amount = priced["order_discount_amount"]
    order.notes, order.internal_notes = body.notes, body.internal_notes
    order.customer_instructions = body.customer_instructions
    for f in ("subtotal", "discount_total", "tax_total", "net_total", "delivery_charge", "rounding", "grand_total"):
        setattr(order, f, getattr(t, f))
    db.flush()
    db.execute(delete(OrderLine).where(OrderLine.order_id == order.id))
    for i, (info, lc) in enumerate(zip(priced["lines"], t.lines), start=1):
        p = info["product"]
        db.add(OrderLine(
            order_id=order.id, line_no=i, product_id=p.id, sku=p.sku, description=info["description"],
            quantity=lc.quantity, unit_price=lc.unit_price, list_price=info["list_price"],
            price_overridden=info["overridden"], discount_pct=lc.discount_pct, discount_amount=lc.discount_amount,
            line_discount=lc.line_discount, order_discount_share=lc.order_discount_share, tax_rate=lc.tax_rate,
            tax_amount=lc.tax, net_amount=lc.net, line_total=lc.total))
    db.flush()


def change_status(db: Session, order: Order, to: str, note: str | None = None) -> None:
    if to not in TRANSITIONS.get(order.status, ()):
        raise AppError(409, "invalid_transition", f"An order can't go from {order.status} to {to}",
                       {"status": f"allowed: {', '.join(TRANSITIONS[order.status]) or 'none'}"})
    if to == "dispatched" and order.delivery_method == "delivery" and not order.courier:
        raise AppError(422, "courier_required", "Add the courier before dispatching", {"courier": "required"})
    if to == "cancelled" and not note:
        raise AppError(422, "reason_required", "Give a reason for cancelling", {"note": "required"})
    frm = order.status
    order.status = to
    now = utcnow()
    if to == "confirmed":
        order.confirmed_at = now
        snapshot_costs(db, order)
    elif to == "dispatched":
        order.dispatched_at = now
    elif to == "delivered":
        order.delivered_at = now
        order.dispatched_at = order.dispatched_at or now
    elif to == "cancelled":
        order.cancelled_reason = note
    db.add(OrderStatusHistory(order_id=order.id, from_status=frm, to_status=to, user_id=db.info.get("user_id"),
                              note=note))
    audit(db, "status", entity_type="orders", entity_id=order.id, before={"status": frm}, after={"status": to},
          note=note)
    refresh_payment_status(db, order)


def snapshot_costs(db: Session, order: Order) -> None:
    """Standard cost at confirmation, for profit reports until stock costing (weighted average) takes over."""
    for ln in db.scalars(select(OrderLine).where(OrderLine.order_id == order.id)):
        c = current_cost(db, ln.product_id, order.order_date)
        ln.unit_cost = c.total if c else None


def refresh_payment_status(db: Session, order: Order) -> None:
    db.flush()
    rows = db.execute(select(Payment.kind, func.coalesce(func.sum(Payment.amount), 0))
                      .where(Payment.order_id == order.id, Payment.status == "completed")
                      .group_by(Payment.kind)).all()
    sums = {k: v for k, v in rows}
    paid, refunded = sums.get("payment", ZERO), sums.get("refund", ZERO)
    order.paid_total = paid - refunded
    any_failed = db.scalar(select(Payment.id).where(Payment.order_id == order.id, Payment.status == "failed")
                           .limit(1))
    if refunded and order.paid_total <= 0:
        order.payment_status = "refunded"
    elif order.grand_total > 0 and order.paid_total >= order.grand_total:
        order.payment_status = "paid"
    elif order.grand_total == 0 and order.status not in ("draft",):
        order.payment_status = "paid"
    elif order.paid_total > 0:
        order.payment_status = "partially_paid"
    elif order.payment_method == "cod":
        order.payment_status = "cod_pending"
    elif any_failed:
        order.payment_status = "failed"
    else:
        order.payment_status = "unpaid"


def ensure_editable(order: Order) -> None:
    if order.status != "draft":
        raise AppError(409, "not_draft", "Only draft orders can be changed. Move it back to draft first.")
