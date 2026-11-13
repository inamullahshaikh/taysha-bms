"""Dashboard metrics and reports. Shared query functions so the dashboard and reports always agree.

Definitions:
- Sales count orders in confirmed..delivered by order_date (not draft, cancelled, returned, refunded).
- Revenue = grand total incl. tax and delivery; net sales = value excl. tax (net_total).
- COGS = quantity x cost snapshot on each order line; gross profit = net sales - COGS.
- Expenses = approved expenses excl. their tax; net profit = gross profit - expenses.
"""

from datetime import date, timedelta
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import BigInteger, ForeignKey, String, and_, func, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.audit import audit
from app.auth.access import can, require_access
from app.auth.deps import CurrentUser
from app.auth.models import User
from app.clock import local_today
from app.customers import Customer
from app.db import DB, Base
from app.documents.models import SalesDocument
from app.errors import AppError
from app.expenses import Expense, ExpenseCategory
from app.listing import export_response
from app.inventory.models import StockMovement
from app.orders.models import Order, OrderLine, Payment
from app.pdf import pdf_response, render_pdf
from app.products.models import Product
from app.products.pricing import money

ZERO = Decimal(0)
COUNTED = ("confirmed", "processing", "packed", "dispatched", "delivered")
Range = Literal["today", "yesterday", "week", "month", "year", "custom"]


class UserPreference(Base):
    __tablename__ = "user_preferences"
    user_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    key: Mapped[str] = mapped_column(String(50), primary_key=True)
    value: Mapped[dict | list] = mapped_column(JSONB)


# ---------- periods ----------

def period(rng: Range, date_from: date | None, date_to: date | None) -> tuple[date, date]:
    t = local_today()
    if rng == "today":
        return t, t
    if rng == "yesterday":
        return t - timedelta(days=1), t - timedelta(days=1)
    if rng == "week":
        return t - timedelta(days=t.weekday()), t
    if rng == "month":
        return t.replace(day=1), t
    if rng == "year":
        return t.replace(month=1, day=1), t
    if not date_from or not date_to or date_to < date_from:
        raise AppError(422, "invalid_range", "Custom range needs date_from <= date_to")
    return date_from, date_to


def previous(start: date, end: date) -> tuple[date, date]:
    days = (end - start).days + 1
    return start - timedelta(days=days), start - timedelta(days=1)


def growth(cur: Decimal, prev: Decimal) -> Decimal | None:
    if not prev:
        return None
    return ((Decimal(cur) - Decimal(prev)) / Decimal(prev) * 100).quantize(Decimal("0.1"))


def counted(start: date, end: date):
    return and_(Order.status.in_(COUNTED), Order.order_date >= start, Order.order_date <= end)


# ---------- metric queries ----------

def sales_totals(db: Session, start: date, end: date) -> dict:
    r = db.execute(select(func.count(), func.coalesce(func.sum(Order.grand_total), 0),
                          func.coalesce(func.sum(Order.net_total), 0), func.coalesce(func.sum(Order.tax_total), 0),
                          func.coalesce(func.sum(Order.discount_total), 0),
                          func.coalesce(func.sum(Order.delivery_charge), 0))
                   .where(counted(start, end))).one()
    n, revenue, net, tax, disc, delivery = r
    return {"order_count": n, "revenue": revenue, "net_sales": net, "tax_collected": tax, "discounts": disc,
            "delivery_charges": delivery,
            "average_order_value": (revenue / n).quantize(Decimal("0.01")) if n else ZERO}


def status_counts(db: Session, start: date, end: date) -> dict:
    rows = db.execute(select(Order.status, func.count()).where(Order.order_date.between(start, end))
                      .group_by(Order.status)).all()
    return dict(rows)


def sales_by(db: Session, start: date, end: date, dim: str, limit: int | None = None) -> list[dict]:
    if dim == "product":
        q = (select(OrderLine.product_id.label("key"), func.max(OrderLine.description).label("label"),
                    func.sum(OrderLine.quantity).label("quantity"), func.sum(OrderLine.line_total).label("revenue"),
                    func.sum(OrderLine.net_amount).label("net_sales"),
                    func.sum(OrderLine.quantity * func.coalesce(OrderLine.unit_cost, 0)).label("cogs"),
                    func.count(func.distinct(OrderLine.order_id)).label("orders"))
             .join(Order, Order.id == OrderLine.order_id).where(counted(start, end))
             .group_by(OrderLine.product_id).order_by(func.sum(OrderLine.line_total).desc()))
        rows = [dict(r._mapping) for r in db.execute(q.limit(limit) if limit else q)]
        for r in rows:
            r["cogs"] = money(r["cogs"])
            r["gross_profit"] = r["net_sales"] - r["cogs"]
        return rows
    col = {"channel": Order.channel, "order_type": Order.order_type, "customer": Order.customer_name,
           "city": Order.shipping_address["city"].astext, "source": Order.source,
           "day": func.to_char(Order.order_date, "YYYY-MM-DD"), "month": func.to_char(Order.order_date, "YYYY-MM"),
           "branch": Order.branch_id}.get(dim)
    if col is None:
        raise AppError(422, "invalid_group", f"Can't group sales by {dim}")
    q = (select(col.label("key"), func.count().label("orders"), func.sum(Order.grand_total).label("revenue"),
                func.sum(Order.net_total).label("net_sales"), func.sum(Order.tax_total).label("tax"),
                func.sum(Order.discount_total).label("discounts"))
         .where(counted(start, end)).group_by(col)
         .order_by(col if dim in ("day", "month") else func.sum(Order.grand_total).desc()))
    return [{**dict(r._mapping), "label": r.key} for r in db.execute(q.limit(limit) if limit else q)]


def cogs(db: Session, start: date, end: date) -> Decimal:
    return money(db.scalar(select(func.coalesce(func.sum(OrderLine.quantity * func.coalesce(OrderLine.unit_cost, 0)), 0))
                     .join(Order, Order.id == OrderLine.order_id).where(counted(start, end))))


def refunds(db: Session, start: date, end: date) -> Decimal:
    return db.scalar(select(func.coalesce(func.sum(Payment.amount), 0)).where(
        Payment.kind == "refund", Payment.status == "completed", Payment.payment_date.between(start, end)))


def expense_total(db: Session, start: date, end: date, statuses=("approved",)) -> Decimal:
    return db.scalar(select(func.coalesce(func.sum(Expense.amount - Expense.tax_amount), 0)).where(
        Expense.status.in_(statuses), Expense.expense_date.between(start, end)))


def expenses_by(db: Session, start: date, end: date, dim: str) -> list[dict]:
    if dim == "category":
        q = (select(ExpenseCategory.id.label("key"), ExpenseCategory.name.label("label"),
                    func.sum(Expense.amount - Expense.tax_amount).label("amount"), func.count().label("count"))
             .join(ExpenseCategory, ExpenseCategory.id == Expense.category_id)
             .group_by(ExpenseCategory.id, ExpenseCategory.name))
    elif dim in ("cost_centre", "department"):
        col = Expense.cost_centre_id if dim == "cost_centre" else Expense.department_id
        q = select(col.label("key"), col.label("label"), func.sum(Expense.amount - Expense.tax_amount).label("amount"),
                   func.count().label("count")).group_by(col)
    elif dim == "month":
        col = func.to_char(Expense.expense_date, "YYYY-MM")
        q = select(col.label("key"), col.label("label"), func.sum(Expense.amount - Expense.tax_amount).label("amount"),
                   func.count().label("count")).group_by(col).order_by(col)
    else:
        raise AppError(422, "invalid_group", f"Can't group expenses by {dim}")
    q = q.where(Expense.status == "approved", Expense.expense_date.between(start, end))
    if dim != "month":
        q = q.order_by(func.sum(Expense.amount - Expense.tax_amount).desc())
    return [dict(r._mapping) for r in db.execute(q)]


def profit_and_loss(db: Session, start: date, end: date) -> dict:
    s = sales_totals(db, start, end)
    c = cogs(db, start, end)
    gross = s["net_sales"] - c
    exp = expense_total(db, start, end)
    net = gross - exp
    pct = (lambda v: (v / s["net_sales"] * 100).quantize(Decimal("0.1")) if s["net_sales"] else None)
    return {"net_sales": s["net_sales"], "cogs": c, "gross_profit": gross, "gross_margin_pct": pct(gross),
            "expenses": exp, "net_profit": net, "net_margin_pct": pct(net), "tax_collected": s["tax_collected"],
            "discounts": s["discounts"], "refunds": refunds(db, start, end),
            "expenses_by_category": expenses_by(db, start, end, "category")}


def monthly_trend(db: Session, months: int = 12) -> list[dict]:
    t = local_today()
    start = (t.replace(day=1) - timedelta(days=31 * (months - 1))).replace(day=1)
    month = func.to_char(Order.order_date, "YYYY-MM")
    sales = {r.m: r for r in db.execute(
        select(month.label("m"), func.sum(Order.grand_total).label("revenue"), func.sum(Order.net_total).label("net"))
        .where(counted(start, t)).group_by(month))}
    lm = func.to_char(Order.order_date, "YYYY-MM")
    cg = dict(db.execute(select(lm, func.sum(OrderLine.quantity * func.coalesce(OrderLine.unit_cost, 0)))
                         .join(Order, Order.id == OrderLine.order_id).where(counted(start, t)).group_by(lm)).all())
    em = func.to_char(Expense.expense_date, "YYYY-MM")
    ex = dict(db.execute(select(em, func.sum(Expense.amount - Expense.tax_amount)).where(
        Expense.status == "approved", Expense.expense_date.between(start, t)).group_by(em)).all())
    out, d = [], start
    while d <= t:
        k = d.strftime("%Y-%m")
        net = sales[k].net if k in sales else ZERO
        e = ex.get(k, ZERO)
        out.append({"month": k, "revenue": sales[k].revenue if k in sales else ZERO, "net_sales": net,
                    "expenses": e, "profit": money(net - cg.get(k, ZERO) - e)})
        d = (d.replace(day=28) + timedelta(days=4)).replace(day=1)
    return out


def customer_metrics(db: Session, start: date, end: date) -> dict:
    total = db.scalar(select(func.count()).select_from(Customer).where(Customer.archived_at.is_(None)))
    new = db.scalar(select(func.count()).select_from(Customer).where(
        func.date(Customer.created_at).between(start, end)))
    vip = db.scalar(select(func.count()).select_from(Customer).where(Customer.tags.contains(["vip"])))
    buyers = select(Order.customer_id).where(counted(start, end), Order.customer_id.is_not(None)).distinct()
    prior = select(Order.customer_id).where(Order.status.in_(COUNTED), Order.order_date < start)
    active = db.scalar(select(func.count()).select_from(buyers.subquery()))
    returning = db.scalar(select(func.count()).select_from(buyers.where(Order.customer_id.in_(prior)).subquery()))
    life = db.execute(select(func.count(func.distinct(Order.customer_id)), func.coalesce(func.sum(Order.grand_total), 0))
                      .where(Order.status.in_(COUNTED), Order.customer_id.is_not(None))).one()
    open_inv = select(func.coalesce(func.sum(SalesDocument.grand_total - SalesDocument.paid_total
                                             - SalesDocument.credited_total), 0)).where(
        SalesDocument.doc_type == "invoice")
    return {"total_customers": total, "new_customers": new, "vip_customers": vip, "active_customers": active,
            "returning_customers": returning,
            "retention_pct": (Decimal(returning) / active * 100).quantize(Decimal("0.1")) if active else None,
            "average_lifetime_value": (life[1] / life[0]).quantize(Decimal("0.01")) if life[0] else ZERO,
            "outstanding": db.scalar(open_inv.where(SalesDocument.status.in_(("issued", "partially_paid", "overdue")))),
            "overdue": db.scalar(open_inv.where(SalesDocument.status == "overdue"))}


def inventory_metrics(db: Session, start: date, end: date, show_value: bool) -> dict:
    from app.inventory.models import Batch, ProductStockCost, ReorderRule, StockBalance, StockReservation, Transfer
    from app.inventory.models import TransferLine
    from app.inventory.service import available, on_hand

    t = local_today()
    stocked = select(Product.id).where(Product.track_stock, Product.kind != "bundle", Product.archived_at.is_(None))
    total_qty = db.scalar(select(func.coalesce(func.sum(StockBalance.quantity), 0)))
    low = out = over = short_materials = 0
    for r, ptype in db.execute(select(ReorderRule, Product.type).join(Product, Product.id == ReorderRule.product_id)):
        oh, av = on_hand(db, r.product_id, r.warehouse_id), available(db, r.product_id, r.warehouse_id)
        is_out = oh <= 0
        is_low = not is_out and r.reorder_point is not None and av <= r.reorder_point
        out, low = out + is_out, low + is_low
        over += r.max_qty is not None and oh > r.max_qty
        short_materials += ptype in ("raw", "packaging") and (is_out or is_low)
    batch_qty = (select(Batch.id, Batch.expiry_date, Batch.status, func.sum(StockBalance.quantity).label("q"))
                 .join(StockBalance, StockBalance.batch_id == Batch.id).group_by(Batch.id)
                 .having(func.sum(StockBalance.quantity) > 0).subquery())
    expiring = db.scalar(select(func.count()).select_from(batch_qty).where(
        batch_qty.c.expiry_date.between(t, t + timedelta(days=14))))
    expired = db.scalar(select(func.count()).select_from(batch_qty).where(batch_qty.c.expiry_date < t))
    held = db.scalar(select(func.coalesce(func.sum(batch_qty.c.q), 0)).where(batch_qty.c.status.in_(("hold",))))
    rejected = db.scalar(select(func.coalesce(func.sum(batch_qty.c.q), 0)).where(batch_qty.c.status == "rejected"))
    out_d = {
        "total_products": db.scalar(select(func.count()).select_from(stocked.subquery())),
        "total_stock_quantity": total_qty, "low_stock": low, "out_of_stock": out, "overstock": over,
        "materials_short": short_materials,
        "reserved_quantity": db.scalar(select(func.coalesce(func.sum(StockReservation.quantity), 0))),
        "in_transit_quantity": db.scalar(select(func.coalesce(func.sum(TransferLine.quantity), 0)).join(Transfer)
                                         .where(Transfer.status == "in_transit")),
        "expiring_batches": expiring, "expired_batches_with_stock": expired,
        "held_quantity": held, "rejected_quantity": rejected,
        "damaged_or_wasted_quantity": db.scalar(select(func.coalesce(-func.sum(StockMovement.quantity), 0)).where(
            StockMovement.reason.in_(("damage", "wastage", "expired")), StockMovement.movement_date.between(start, end))),
    }
    if show_value:
        value = money(db.scalar(select(func.coalesce(func.sum(StockBalance.quantity * ProductStockCost.avg_cost), 0))
                                .join(ProductStockCost, ProductStockCost.product_id == StockBalance.product_id)))
        days = (end - start).days + 1
        c = cogs(db, start, end)
        out_d["valuation"] = value
        out_d["turnover_annualised"] = (c / value * Decimal(365) / days).quantize(Decimal("0.1")) if value else None
    return out_d


def purchasing_metrics(db: Session, user: User, start: date, end: date) -> dict:
    from app.purchasing.models import PurchaseOrder, SupplierBill
    from app.purchasing.router import price_changes
    from app.suppliers import Supplier

    recent = local_today() - timedelta(days=90)
    out = {
        "total_suppliers": db.scalar(select(func.count()).select_from(Supplier).where(Supplier.archived_at.is_(None))),
        "active_suppliers": db.scalar(select(func.count(func.distinct(PurchaseOrder.supplier_id))).where(
            PurchaseOrder.order_date >= recent, PurchaseOrder.status != "cancelled")),
        "purchases": db.scalar(select(func.coalesce(func.sum(PurchaseOrder.grand_total), 0)).where(
            PurchaseOrder.order_date.between(start, end), PurchaseOrder.status.not_in(("cancelled", "draft")))),
        "pending_approval": db.scalar(select(func.count()).select_from(PurchaseOrder).where(
            PurchaseOrder.status == "requested")),
        "awaiting_delivery": db.scalar(select(func.count()).select_from(PurchaseOrder).where(
            PurchaseOrder.status.in_(("approved", "ordered", "partially_received")))),
        "price_changes_30d": len(price_changes(db, 30)),
    }
    if can(db, user, "supplier_bills", "view"):
        open_bills = select(func.coalesce(func.sum(SupplierBill.grand_total - SupplierBill.withholding_tax
                                                   - SupplierBill.paid_total), 0))
        out["outstanding_payables"] = db.scalar(open_bills.where(
            SupplierBill.status.in_(("unpaid", "partially_paid", "overdue"))))
        out["overdue_payables"] = db.scalar(open_bills.where(SupplierBill.status == "overdue"))
    return out


def production_metrics(db: Session, start: date, end: date, show_cost: bool) -> dict:
    from app.production.models import ProductionOrder as PO

    done = select(PO).where(PO.status == "completed", func.date(PO.completed_at).between(start, end)).subquery()
    r = db.execute(select(func.count(), func.coalesce(func.sum(done.c.output_quantity), 0),
                          func.coalesce(func.sum(done.c.planned_quantity), 0),
                          func.coalesce(func.sum(done.c.rejected_quantity), 0),
                          func.coalesce(func.sum(done.c.wastage_quantity), 0),
                          func.coalesce(func.sum(done.c.actual_cost), 0))).one()
    n, output, planned, rejected, wasted, cost = r
    made = output + rejected + wasted
    counts = dict(db.execute(select(PO.status, func.count()).group_by(PO.status)).all())
    t = local_today()
    out = {"completed_orders": n, "output_quantity": output, "rejected_quantity": rejected,
           "wastage_quantity": wasted,
           "efficiency_pct": (output / planned * 100).quantize(Decimal("0.1")) if planned else None,
           "wastage_pct": ((rejected + wasted) / made * 100).quantize(Decimal("0.1")) if made else None,
           "active_orders": counts.get("released", 0) + counts.get("in_progress", 0),
           "pending_orders": counts.get("draft", 0),
           "scheduled_next_7_days": db.scalar(select(func.count()).select_from(PO).where(
               PO.status.in_(("draft", "released")), PO.planned_start.between(t, t + timedelta(days=7))))}
    if show_cost:
        out["average_unit_cost"] = (cost / output).quantize(Decimal("0.01")) if output else None
    return out


# ---------- dashboard ----------

dashboard = APIRouter(prefix="/dashboard", tags=["dashboard"])
DEFAULT_WIDGETS = ["sales_summary", "order_status", "sales_trend", "sales_by_channel", "top_products",
                   "profit_summary", "expenses_summary", "customers_summary", "receivables", "inventory_summary",
                   "stock_alerts", "purchasing_summary", "production_summary", "production_schedule"]


@dashboard.get("")
def get_dashboard(user: CurrentUser, db: DB, range: Range = "month", date_from: date | None = None,
                  date_to: date | None = None):
    """Each section is only included if the user has access to that area."""
    start, end = period(range, date_from, date_to)
    pstart, pend = previous(start, end)
    out: dict = {"period": {"from": start, "to": end, "previous_from": pstart, "previous_to": pend}}
    if can(db, user, "orders", "view"):
        cur, prev = sales_totals(db, start, end), sales_totals(db, pstart, pend)
        out["sales"] = {**cur, "previous": prev, "revenue_growth_pct": growth(cur["revenue"], prev["revenue"]),
                        "order_growth_pct": growth(cur["order_count"], prev["order_count"]),
                        "status_counts": status_counts(db, start, end),
                        "by_channel": sales_by(db, start, end, "channel"),
                        "by_order_type": sales_by(db, start, end, "order_type"),
                        "by_city": sales_by(db, start, end, "city", 10),
                        "top_products": sales_by(db, start, end, "product", 10)}
        all_products = sales_by(db, start, end, "product")
        out["sales"]["least_products"] = list(reversed(all_products[-5:])) if len(all_products) > 10 else []
    if can(db, user, "product_costs", "view") and can(db, user, "orders", "view"):
        pl = profit_and_loss(db, start, end)
        ranked = sorted(sales_by(db, start, end, "product"), key=lambda r: r["gross_profit"], reverse=True)
        out["profit"] = {**{k: v for k, v in pl.items() if k != "expenses_by_category"},
                         "most_profitable": ranked[:5], "least_profitable": list(reversed(ranked[-5:]))}
    if can(db, user, "expenses", "view"):
        t = local_today()
        out["expenses"] = {
            "period_total": expense_total(db, start, end), "previous_total": expense_total(db, pstart, pend),
            "growth_pct": growth(expense_total(db, start, end), expense_total(db, pstart, pend)),
            "today": expense_total(db, t, t), "this_month": expense_total(db, t.replace(day=1), t),
            "this_year": expense_total(db, t.replace(month=1, day=1), t),
            "top_categories": expenses_by(db, start, end, "category")[:5],
            "pending_approvals": db.scalar(select(func.count()).select_from(Expense).where(
                Expense.status == "submitted"))}
    if can(db, user, "customers", "view"):
        out["customers"] = customer_metrics(db, start, end)
    if can(db, user, "inventory", "view"):
        out["inventory"] = inventory_metrics(db, start, end, can(db, user, "product_costs", "view"))
    if can(db, user, "purchasing", "view"):
        out["purchasing"] = purchasing_metrics(db, user, start, end)
    if can(db, user, "production", "view"):
        out["production"] = production_metrics(db, start, end, can(db, user, "product_costs", "view"))
    if can(db, user, "orders", "view"):
        out["trend"] = monthly_trend(db) if can(db, user, "product_costs", "view") else [
            {k: v for k, v in m.items() if k in ("month", "revenue", "net_sales")} for m in monthly_trend(db)]
    return out


class LayoutIn(BaseModel):
    widgets: list[str]


@dashboard.get("/layout")
def get_layout(user: CurrentUser, db: DB):
    pref = db.get(UserPreference, (user.id, "dashboard"))
    return {"widgets": pref.value if pref else DEFAULT_WIDGETS, "available": DEFAULT_WIDGETS}


@dashboard.put("/layout")
def put_layout(body: LayoutIn, user: CurrentUser, db: DB):
    pref = db.get(UserPreference, (user.id, "dashboard"))
    if pref:
        pref.value = body.widgets
    else:
        db.add(UserPreference(user_id=user.id, key="dashboard", value=body.widgets))
    return {"widgets": body.widgets, "available": DEFAULT_WIDGETS}


# ---------- reports ----------

reports = APIRouter(prefix="/reports", tags=["reports"])
Fmt = Literal["json", "csv", "xlsx", "pdf"]


def report_response(db: Session, name: str, title: str, rows: list[dict], cols: list[tuple[str, str]], fmt: Fmt,
                    start: date, end: date, extra: dict | None = None):
    if fmt == "json":
        return {"from": start, "to": end, "rows": rows, **(extra or {})}
    if fmt == "pdf":
        data = render_pdf(db, "report.html", title=title, start=start, end=end, rows=rows, cols=cols,
                          extra=extra or {})
        audit(db, "export", entity_type=name, note=f"pdf {start}..{end}")
        return pdf_response(data, f"{name}-{start}-{end}.pdf")
    return export_response(db, rows, cols, fmt, f"{name}-{start}-{end}", name)


@reports.get("/sales")
def sales_report(db: DB, group_by: Literal["product", "channel", "customer", "order_type", "city", "day", "month",
                                           "source", "branch"] = "product",
                 range: Range = "month", date_from: date | None = None, date_to: date | None = None,
                 format: Fmt = "json", user: User = require_access("orders", "view")):
    start, end = period(range, date_from, date_to)
    if format != "json" and not can(db, user, "orders", "export"):
        raise AppError(403, "forbidden", "You don't have export access to sales")
    rows = sales_by(db, start, end, group_by)
    show_cost = can(db, user, "product_costs", "view")
    if not show_cost:
        for r in rows:
            r.pop("cogs", None)
            r.pop("gross_profit", None)
    cols = [("label", group_by.title()), ("orders", "Orders")]
    if group_by == "product":
        cols.append(("quantity", "Quantity"))
    cols += [("revenue", "Revenue"), ("net_sales", "Net sales")]
    if group_by == "product" and show_cost:
        cols += [("cogs", "COGS"), ("gross_profit", "Gross profit")]
    return report_response(db, "sales_report", f"Sales by {group_by}", rows, cols, format, start, end,
                           {"totals": sales_totals(db, start, end)})


@reports.get("/expenses")
def expenses_report(db: DB, group_by: Literal["category", "cost_centre", "department", "month"] = "category",
                    range: Range = "month", date_from: date | None = None, date_to: date | None = None,
                    format: Fmt = "json", user: User = require_access("expenses", "view")):
    start, end = period(range, date_from, date_to)
    if format != "json" and not can(db, user, "expenses", "export"):
        raise AppError(403, "forbidden", "You don't have export access to expenses")
    rows = expenses_by(db, start, end, group_by)
    return report_response(db, "expense_report", f"Expenses by {group_by}", rows,
                           [("label", group_by.title()), ("count", "Count"), ("amount", "Amount excl. tax")],
                           format, start, end, {"total": expense_total(db, start, end)})


@reports.get("/profit-loss")
def profit_loss_report(db: DB, range: Range = "month", date_from: date | None = None, date_to: date | None = None,
                       format: Fmt = "json", user: User = require_access("product_costs", "view")):
    if not (can(db, user, "orders", "view") and can(db, user, "expenses", "view")):
        raise AppError(403, "forbidden", "Profit & loss needs access to sales, costs and expenses")
    start, end = period(range, date_from, date_to)
    pl = profit_and_loss(db, start, end)
    rows = [{"line": "Net sales", "amount": pl["net_sales"]}, {"line": "Cost of goods sold", "amount": -pl["cogs"]},
            {"line": "Gross profit", "amount": pl["gross_profit"]}]
    rows += [{"line": f"  {e['label']}", "amount": -e["amount"]} for e in pl["expenses_by_category"]]
    rows += [{"line": "Total expenses", "amount": -pl["expenses"]}, {"line": "Net profit", "amount": pl["net_profit"]}]
    if format == "json":
        return {"from": start, "to": end, **pl}
    return report_response(db, "profit_loss", "Profit & loss", rows, [("line", ""), ("amount", "PKR")], format,
                           start, end)


@reports.get("/products/{product_id}/performance")
def product_performance(product_id: int, db: DB, months: int = 12, _: User = require_access("orders", "view")):
    month = func.to_char(Order.order_date, "YYYY-MM")
    t = local_today()
    start = (t.replace(day=1) - timedelta(days=31 * (months - 1))).replace(day=1)
    rows = db.execute(select(month.label("month"), func.sum(OrderLine.quantity).label("quantity"),
                             func.sum(OrderLine.line_total).label("revenue"))
                      .join(Order, Order.id == OrderLine.order_id)
                      .where(counted(start, t), OrderLine.product_id == product_id).group_by(month).order_by(month))
    if db.get(Product, product_id) is None:
        raise AppError(404, "not_found", "Product not found")
    return [dict(r._mapping) for r in rows]


routers = [dashboard, reports]
