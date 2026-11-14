"""In-app (and optional email) alerts.

check_alerts() runs from the scheduler. Each condition has a stable key (e.g. low_stock:12:3). An alert is sent
once when its condition starts; it can fire again only after the condition has cleared.
"""

import logging
from datetime import datetime, timedelta
from decimal import Decimal

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, String, Text, func, select, update
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.auth.access import can
from app.auth.deps import CurrentUser
from app.auth.models import User
from app.clock import local_today, utcnow
from app.db import DB, Base
from app.errors import not_found
from app.mailer import send_email
from app.reports import UserPreference

log = logging.getLogger(__name__)

# kind -> (label, feature, action) deciding who receives it
KINDS: dict[str, tuple[str, str, str]] = {
    "low_stock": ("Low stock", "inventory", "view"),
    "out_of_stock": ("Out of stock", "inventory", "view"),
    "overstock": ("Overstock", "inventory", "view"),
    "expiring_stock": ("Stock expiring soon", "inventory", "view"),
    "expired_stock": ("Expired stock on hand", "inventory", "view"),
    "overdue_invoice": ("Overdue customer invoice", "invoices", "view"),
    "overdue_bill": ("Overdue supplier bill", "supplier_bills", "view"),
    "expense_approval": ("Expense waiting for approval", "expenses", "approve"),
    "purchase_approval": ("Purchase waiting for approval", "purchasing", "approve"),
    "delayed_dispatch": ("Order not dispatched", "orders", "view"),
    "unusual_adjustment": ("Large stock write-off or adjustment", "inventory", "view"),
    "failed_sync": ("Integration sync failed", "settings", "view"),
    "follow_up": ("Customer follow-up due", "customers", "view"),
    "task_overdue": ("Task overdue", "tasks", "view"),
    "document_expiry": ("Document expiring", "documents", "view"),
}
EXPIRY_WARNING_DAYS = 14
DISPATCH_DELAY_DAYS = 2
ADJUSTMENT_ALERT_VALUE = Decimal(10000)


class Notification(Base):
    __tablename__ = "notifications"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(40))
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str | None] = mapped_column(Text)
    link: Mapped[str | None] = mapped_column(String(200))  # frontend route, e.g. /orders/12
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AlertState(Base):
    __tablename__ = "alert_states"
    key: Mapped[str] = mapped_column(String(120), primary_key=True)
    kind: Mapped[str] = mapped_column(String(40), index=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


def prefs(db: Session, user_id: int) -> dict:
    p = db.get(UserPreference, (user_id, "notifications"))
    stored = p.value if p else {}
    return {k: {"in_app": True, "email": False, **stored.get(k, {})} for k in KINDS}


def recipients(db: Session, kind: str) -> list[User]:
    _, feature, action = KINDS[kind]
    return [u for u in db.scalars(select(User).where(User.is_active)) if can(db, u, feature, action)]


def send(db: Session, kind: str, title: str, body: str | None = None, link: str | None = None) -> int:
    """Deliver now to everyone who should get this kind (no de-duplication)."""
    n = 0
    for u in recipients(db, kind):
        p = prefs(db, u.id)[kind]
        if p["in_app"]:
            db.add(Notification(user_id=u.id, kind=kind, title=title, body=body, link=link))
            n += 1
        if p["email"]:
            try:
                send_email(u.email, f"[Taysha] {title}", body or title)
            except Exception:  # an email problem must never break the alert run
                log.exception("alert email failed")
    return n


def raise_alert(db: Session, kind: str, key: str, title: str, body: str | None = None,
                link: str | None = None) -> bool:
    """Send once while the condition stays true. Returns True if sent now."""
    full = f"{kind}:{key}"
    st = db.get(AlertState, full)
    if st and st.active:
        return False
    if st is None:
        st = AlertState(key=full, kind=kind)
        db.add(st)
    st.active, st.last_sent_at = True, utcnow()
    send(db, kind, title, body, link)
    return True


def clear_others(db: Session, kind: str, active_keys: set[str]) -> None:
    """Conditions of this kind that no longer hold become inactive (so they can alert again later)."""
    full = {f"{kind}:{k}" for k in active_keys}
    q = update(AlertState).where(AlertState.kind == kind, AlertState.active)
    if full:
        q = q.where(AlertState.key.not_in(full))
    db.execute(q.values(active=False))


# ---------- the checks ----------

def check_alerts(db: Session) -> str:
    from app.documents.models import SalesDocument
    from app.expenses import Expense
    from app.inventory.models import Batch, ReorderRule, StockBalance, StockMovement
    from app.inventory.service import available, avg_cost, on_hand
    from app.orders.models import Order
    from app.products.models import Product
    from app.purchasing.models import PurchaseOrder, PurchaseRequest, SupplierBill

    sent = 0
    found: dict[str, set[str]] = {k: set() for k in KINDS}

    def hit(kind, key, title, body=None, link=None):
        nonlocal sent
        found[kind].add(key)
        sent += raise_alert(db, kind, key, title, body, link)

    # stock levels (products with reorder rules)
    for r, p in db.execute(select(ReorderRule, Product).join(Product, Product.id == ReorderRule.product_id)
                           .where(Product.archived_at.is_(None))):
        oh, av = on_hand(db, p.id, r.warehouse_id), available(db, p.id, r.warehouse_id)
        k = f"{p.id}:{r.warehouse_id}"
        if oh <= 0:
            hit("out_of_stock", k, f"{p.name} is out of stock", link=f"/stock?product={p.id}")
        elif r.reorder_point is not None and av <= r.reorder_point:
            hit("low_stock", k, f"{p.name} is low ({av.normalize():f} available)",
                f"Reorder point {r.reorder_point.normalize():f}", f"/stock?product={p.id}")
        if r.max_qty is not None and oh > r.max_qty:
            hit("overstock", k, f"{p.name} is over its maximum ({oh.normalize():f})", link=f"/stock?product={p.id}")

    # expiry
    t = local_today()
    qty = func.sum(StockBalance.quantity)
    for b, p, q in db.execute(select(Batch, Product, qty).join(StockBalance, StockBalance.batch_id == Batch.id)
                              .join(Product, Product.id == Batch.product_id)
                              .where(Batch.expiry_date.is_not(None),
                                     Batch.expiry_date <= t + timedelta(days=EXPIRY_WARNING_DAYS))
                              .group_by(Batch.id, Product.id).having(qty > 0)):
        if b.expiry_date < t:
            hit("expired_stock", str(b.id), f"{p.name} batch {b.number} expired with {q.normalize():f} on hand",
                link=f"/stock/batches/{b.id}")
        else:
            hit("expiring_stock", str(b.id), f"{p.name} batch {b.number} expires {b.expiry_date:%d %b}",
                f"{q.normalize():f} on hand", f"/stock/batches/{b.id}")

    # money
    for inv in db.scalars(select(SalesDocument).where(SalesDocument.doc_type == "invoice",
                                                      SalesDocument.status == "overdue")):
        hit("overdue_invoice", str(inv.id), f"Invoice {inv.number} is overdue ({inv.customer_name})",
            f"Balance {inv.balance_due}", f"/documents/{inv.id}")
    for bill in db.scalars(select(SupplierBill).where(SupplierBill.status == "overdue")):
        hit("overdue_bill", str(bill.id), f"Supplier bill {bill.number} is overdue", f"Balance {bill.balance_due}",
            f"/supplier-bills/{bill.id}")

    # approvals
    for e in db.scalars(select(Expense).where(Expense.status == "submitted")):
        hit("expense_approval", str(e.id), f"Expense {e.number} ({e.amount}) needs approval", e.description,
            f"/expenses/{e.id}")
    for po in db.scalars(select(PurchaseOrder).where(PurchaseOrder.status == "requested")):
        hit("purchase_approval", f"po{po.id}", f"Purchase order {po.number} ({po.grand_total}) needs approval",
            link=f"/purchase-orders/{po.id}")
    for pr in db.scalars(select(PurchaseRequest).where(PurchaseRequest.status == "requested")):
        hit("purchase_approval", f"pr{pr.id}", f"Purchase request {pr.number} needs approval",
            link=f"/purchase-requests/{pr.id}")

    # delayed dispatch
    late = utcnow() - timedelta(days=DISPATCH_DELAY_DAYS)
    for o in db.scalars(select(Order).where(Order.status.in_(("confirmed", "processing", "packed")),
                                            Order.confirmed_at < late)):
        hit("delayed_dispatch", str(o.id), f"Order {o.number} confirmed {DISPATCH_DELAY_DAYS}+ days ago, not dispatched",
            o.customer_name, f"/orders/{o.id}")

    # unusual write-offs in the last day (fire once per movement; never "clears")
    since = utcnow() - timedelta(days=1)
    for m, p in db.execute(select(StockMovement, Product).join(Product, Product.id == StockMovement.product_id)
                           .where(StockMovement.at >= since,
                                  StockMovement.reason.in_(("adjustment", "damage", "wastage", "count", "expired")))):
        value = abs(m.quantity) * (m.unit_cost or avg_cost(db, p.id))
        if value >= ADJUSTMENT_ALERT_VALUE:
            sent += raise_alert(db, "unusual_adjustment", str(m.id),
                                f"{m.reason.title()} of {p.name}: {m.quantity.normalize():f} (~Rs {value:,.0f})",
                                m.note, f"/stock/movements?product_id={p.id}")

    # follow-ups go to the person they're assigned to
    from app.crm import FollowUp

    for f in db.scalars(select(FollowUp).where(FollowUp.done_at.is_(None), FollowUp.due_date <= t,
                                               FollowUp.archived_at.is_(None))):
        found["follow_up"].add(str(f.id))
        st = db.get(AlertState, f"follow_up:{f.id}")
        if not (st and st.active) and f.assigned_to_id and prefs(db, f.assigned_to_id)["follow_up"]["in_app"]:
            if st is None:
                db.add(AlertState(key=f"follow_up:{f.id}", kind="follow_up", active=True, last_sent_at=utcnow()))
            else:
                st.active = True
            db.add(Notification(user_id=f.assigned_to_id, kind="follow_up", title=f"Follow-up due: {f.note[:80]}",
                                link=f"/customers/{f.customer_id}" if f.customer_id else f"/leads/{f.lead_id}"))
            sent += 1

    # documents inside their reminder window
    from app.records import expiring

    for d in expiring(db):
        when = "expired" if d.expiry_date < t else f"expires {d.expiry_date:%d %b %Y}"
        hit("document_expiry", str(d.id), f"{d.title} {when}", d.category, f"/documents/{d.id}")

    # overdue tasks go to their assignee
    from app.tasks import overdue_tasks

    for task in overdue_tasks(db):
        key = f"task_overdue:{task.id}"
        found["task_overdue"].add(str(task.id))
        st = db.get(AlertState, key)
        if not (st and st.active) and prefs(db, task.assignee_id)["task_overdue"]["in_app"]:
            if st is None:
                db.add(AlertState(key=key, kind="task_overdue", active=True, last_sent_at=utcnow()))
            else:
                st.active = True
            db.add(Notification(user_id=task.assignee_id, kind="task_overdue", title=f"Overdue: {task.title}",
                                link=f"/tasks/{task.id}"))
            sent += 1

    # integration failures not yet resolved
    from app.integrations.shopify import SyncLog

    for e in db.scalars(select(SyncLog).where(SyncLog.status == "error", SyncLog.resolved.is_(False))):
        hit("failed_sync", str(e.id), f"Shopify {e.kind} sync failed", e.message, "/settings/integrations")

    for kind, keys in found.items():
        clear_others(db, kind, keys)
    return f"{sent} notifications sent"


# ---------- API ----------

router = APIRouter(prefix="/notifications", tags=["notifications"])


class NotificationOut(BaseModel):
    model_config = {"from_attributes": True}
    id: int
    kind: str
    title: str
    body: str | None
    link: str | None
    created_at: datetime
    read_at: datetime | None


@router.get("")
def list_notifications(user: CurrentUser, db: DB, unread_only: bool = False, limit: int = 50,
                       before_id: int | None = None):
    q = select(Notification).where(Notification.user_id == user.id).order_by(Notification.id.desc()).limit(min(limit, 200))
    if unread_only:
        q = q.where(Notification.read_at.is_(None))
    if before_id:
        q = q.where(Notification.id < before_id)
    unread = db.scalar(select(func.count()).select_from(Notification).where(
        Notification.user_id == user.id, Notification.read_at.is_(None)))
    return {"unread": unread, "items": [NotificationOut.model_validate(n) for n in db.scalars(q)]}


@router.post("/{notification_id}/read", status_code=204)
def mark_read(notification_id: int, user: CurrentUser, db: DB):
    n = db.get(Notification, notification_id)
    if n is None or n.user_id != user.id:
        raise not_found("Notification")
    n.read_at = n.read_at or utcnow()


@router.post("/read-all", status_code=204)
def mark_all_read(user: CurrentUser, db: DB):
    db.execute(update(Notification).where(Notification.user_id == user.id, Notification.read_at.is_(None))
               .values(read_at=utcnow()))


class PrefIn(BaseModel):
    in_app: bool = True
    email: bool = False


@router.get("/preferences")
def get_prefs(user: CurrentUser, db: DB):
    return [{"kind": k, "label": KINDS[k][0], **v} for k, v in prefs(db, user.id).items()
            if can(db, user, KINDS[k][1], KINDS[k][2])]


@router.put("/preferences")
def put_prefs(body: dict[str, PrefIn], user: CurrentUser, db: DB):
    value = {k: v.model_dump() for k, v in body.items() if k in KINDS}
    p = db.get(UserPreference, (user.id, "notifications"))
    if p:
        p.value = {**p.value, **value}
    else:
        db.add(UserPreference(user_id=user.id, key="notifications", value=value))
    db.flush()
    return get_prefs(user, db)


routers = [router]
