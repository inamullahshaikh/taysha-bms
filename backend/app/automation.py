"""Automation rules: when <condition> then <action>. Evaluated by the scheduler; each match acts only once."""

import logging
from datetime import datetime, timedelta
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint, func, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.auth.access import can, require_access
from app.auth.models import User
from app.clock import local_today, utcnow
from app.crud import RecordOut, crud_router, get_or_404
from app.documents.models import SalesDocument
from app.db import DB, Base, Entity
from app.errors import AppError
from app.expenses import Expense
from app.inventory.service import available, default_warehouse_id
from app.mailer import send_email
from app.notifications import Notification
from app.orders.models import Order, OrderStatusHistory
from app.orders.service import change_status
from app.products.models import Product
from app.tasks import Task

log = logging.getLogger(__name__)
Trigger = Literal["order_in_status", "low_stock", "invoice_overdue", "expense_waiting", "daily"]
Action = Literal["notify_users", "notify_feature", "email", "create_task", "mark_delivered"]


class AutomationRule(Entity, Base):
    __tablename__ = "automation_rules"
    name: Mapped[str] = mapped_column(String(150))
    trigger: Mapped[str] = mapped_column(String(30))
    params: Mapped[dict] = mapped_column(JSONB, default=dict)
    action: Mapped[str] = mapped_column(String(30))
    action_params: Mapped[dict] = mapped_column(JSONB, default=dict)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    run_count: Mapped[int] = mapped_column(Integer, default=0)


class AutomationHit(Base):
    __tablename__ = "automation_hits"
    __table_args__ = (UniqueConstraint("rule_id", "key"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    rule_id: Mapped[int] = mapped_column(ForeignKey("automation_rules.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(80))
    label: Mapped[str] = mapped_column(String(255))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# ---------- conditions: each returns [(key, label, link, record)] ----------

def match(db: Session, rule: AutomationRule) -> list[tuple]:
    p, now = rule.params, utcnow()
    if rule.trigger == "order_in_status":
        since = now - timedelta(hours=float(p.get("older_than_hours", 24)))
        changed = (select(OrderStatusHistory.order_id, func.max(OrderStatusHistory.at).label("at"))
                   .group_by(OrderStatusHistory.order_id).subquery())
        rows = db.scalars(select(Order).join(changed, changed.c.order_id == Order.id)
                          .where(Order.status == p["status"], changed.c.at < since)).all()
        return [(f"{o.id}:{o.status}", f"Order {o.number} is {o.status}", f"/orders/{o.id}", o) for o in rows]
    if rule.trigger == "low_stock":
        wh = p.get("warehouse_id") or default_warehouse_id(db)
        q = select(Product).where(Product.track_stock, Product.kind != "bundle", Product.archived_at.is_(None))
        if p.get("product_id"):
            q = q.where(Product.id == p["product_id"])
        out = []
        for prod in db.scalars(q):
            av = available(db, prod.id, wh)
            if av < float(p.get("below", 1)):
                out.append((f"{prod.id}:{local_today()}", f"{prod.name}: {av.normalize():f} available",
                            f"/stock?product={prod.id}", prod))
        return out
    if rule.trigger == "invoice_overdue":
        cutoff = local_today() - timedelta(days=int(p.get("days", 0)))
        rows = db.scalars(select(SalesDocument).where(SalesDocument.doc_type == "invoice",
                                                      SalesDocument.status == "overdue",
                                                      SalesDocument.due_date <= cutoff)).all()
        return [(str(d.id), f"Invoice {d.number} ({d.customer_name}) overdue, {d.balance_due} due",
                 f"/documents/{d.id}", d) for d in rows]
    if rule.trigger == "expense_waiting":
        since = now - timedelta(hours=float(p.get("hours", 48)))
        rows = db.scalars(select(Expense).where(Expense.status == "submitted", Expense.created_at < since)).all()
        return [(str(e.id), f"Expense {e.number} waiting for approval", f"/expenses/{e.id}", e) for e in rows]
    if rule.trigger == "daily":
        return [(str(local_today()), rule.name, None, None)]
    raise AppError(422, "unknown_trigger", f"Unknown trigger {rule.trigger}")


# ---------- actions ----------

def act(db: Session, rule: AutomationRule, label: str, link: str | None, record) -> None:
    a = rule.action_params
    title = a.get("title") or f"{rule.name}: {label}"
    if rule.action == "notify_users":
        db.add_all(Notification(user_id=uid, kind="automation", title=title, link=link) for uid in a["user_ids"])
    elif rule.action == "notify_feature":
        for u in db.scalars(select(User).where(User.is_active)):
            if can(db, u, a["feature"], a.get("action", "view")):
                db.add(Notification(user_id=u.id, kind="automation", title=title, link=link))
    elif rule.action == "email":
        for to in a["to"]:
            try:
                send_email(to, f"[Taysha] {title}", label)
            except AppError:
                log.exception("automation email failed")
    elif rule.action == "create_task":
        db.add(Task(title=a.get("task_title") or title, assignee_id=a.get("assignee_id"),
                    due_date=local_today() + timedelta(days=int(a.get("due_in_days", 1))),
                    priority=a.get("priority", "medium"), description=label,
                    related_type=link.split("/")[1] if link else None, created_by_id=rule.created_by_id))
    elif rule.action == "mark_delivered":
        if record is not None and getattr(record, "status", None) == "dispatched":
            change_status(db, record, "delivered", f"Automation: {rule.name}")


def run_rule(db: Session, rule: AutomationRule) -> int:
    done = set(db.scalars(select(AutomationHit.key).where(AutomationHit.rule_id == rule.id)))
    n = 0
    for key, label, link, record in match(db, rule):
        if key in done:
            continue
        with db.begin_nested():
            act(db, rule, label, link, record)
            db.add(AutomationHit(rule_id=rule.id, key=key, label=label[:255]))
        n += 1
    rule.last_run_at, rule.run_count = utcnow(), rule.run_count + n
    return n


def run_all(db: Session) -> str:
    db.info["source"] = "system"
    total = 0
    for rule in db.scalars(select(AutomationRule).where(AutomationRule.active, AutomationRule.archived_at.is_(None))):
        try:
            total += run_rule(db, rule)
        except Exception:
            log.exception("automation rule %s failed", rule.id)
    return f"{total} automation actions"


# ---------- API ----------

PARAMS_REQUIRED = {"order_in_status": ("status",), "notify_users": ("user_ids",), "notify_feature": ("feature",),
                   "email": ("to",)}


class RuleIn(BaseModel):
    name: str = Field(min_length=1)
    trigger: Trigger
    params: dict = {}
    action: Action
    action_params: dict = {}
    active: bool = True

    @model_validator(mode="after")
    def _check(self):
        for k in PARAMS_REQUIRED.get(self.trigger, ()):
            if k not in self.params:
                raise ValueError(f"params.{k} is required for {self.trigger}")
        for k in PARAMS_REQUIRED.get(self.action, ()):
            if k not in self.action_params:
                raise ValueError(f"action_params.{k} is required for {self.action}")
        if self.action == "mark_delivered" and not (self.trigger == "order_in_status"
                                                     and self.params.get("status") == "dispatched"):
            raise ValueError("mark_delivered only works with order_in_status / dispatched")
        return self


class RulePatch(BaseModel):
    name: str | None = None
    params: dict | None = None
    action_params: dict | None = None
    active: bool | None = None


class RuleOut(RecordOut, RuleIn):
    last_run_at: datetime | None
    run_count: int


router = APIRouter(prefix="/automation/rules", tags=["automation"])
VIEW, EDIT = require_access("automation", "view"), require_access("automation", "edit")


@router.post("/{rule_id}/test")
def test_rule(rule_id: int, db: DB, _: User = VIEW):
    """Dry run: what would match right now (nothing is done)."""
    rule = get_or_404(db, AutomationRule, rule_id, "Rule")
    done = set(db.scalars(select(AutomationHit.key).where(AutomationHit.rule_id == rule.id)))
    return [{"key": k, "label": label, "link": link, "already_handled": k in done}
            for k, label, link, _ in match(db, rule)]


@router.post("/{rule_id}/run")
def run_now(rule_id: int, db: DB, _: User = EDIT):
    return {"actions": run_rule(db, get_or_404(db, AutomationRule, rule_id, "Rule"))}


@router.get("/{rule_id}/hits")
def hits(rule_id: int, db: DB, _: User = VIEW):
    return [{"key": h.key, "label": h.label, "at": h.at} for h in db.scalars(
        select(AutomationHit).where(AutomationHit.rule_id == rule_id).order_by(AutomationHit.id.desc()).limit(200))]


crud_routers = [crud_router(AutomationRule, prefix="/automation/rules", feature="automation", create=RuleIn,
                            update=RulePatch, out=RuleOut, search=(AutomationRule.name,),
                            filters={"trigger": AutomationRule.trigger, "active": AutomationRule.active},
                            default_sort=AutomationRule.name, tags=["automation"])]
routers = [router, *crud_routers]
