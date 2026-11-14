"""Approval requests for high-impact actions (big discounts, big refunds) and one inbox for everything a user
can approve. Expenses, purchases, journal entries and partner transactions keep their own approve endpoints; the
inbox lists them alongside these requests."""

from datetime import date, datetime
from decimal import Decimal

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import DateTime, ForeignKey, String, Text, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.audit import audit
from app.auth.access import can, require_access
from app.auth.deps import CurrentUser
from app.auth.models import User
from app.clock import utcnow
from app.company import approvals_on, get_company
from app.crud import get_or_404
from app.db import DB, Base, Entity, Money
from app.errors import AppError, KeepChangesError

ZERO = Decimal(0)


class ApprovalRequest(Entity, Base):
    __tablename__ = "approval_requests"
    kind: Mapped[str] = mapped_column(String(30), index=True)  # order_discount | refund
    entity_type: Mapped[str] = mapped_column(String(50))
    entity_id: Mapped[int] = mapped_column(index=True)
    amount: Mapped[Money]
    summary: Mapped[str] = mapped_column(String(255))
    payload: Mapped[dict | None] = mapped_column(JSONB)  # what to do once approved
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)  # pending|approved|rejected
    decided_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    note: Mapped[str | None] = mapped_column(Text)


def current_user(db: Session) -> User | None:
    uid = db.info.get("user_id")
    return db.get(User, uid) if uid else None


def require_approval(db: Session, kind: str, entity_type: str, entity_id: int, amount: Decimal, summary: str,
                     payload: dict | None = None) -> None:
    """Raise 409 approval_required unless an approved request for exactly this exists (owners skip)."""
    user = current_user(db)
    if (user and user.is_owner) or not approvals_on(db):
        return
    base = select(ApprovalRequest).where(ApprovalRequest.kind == kind, ApprovalRequest.entity_type == entity_type,
                                         ApprovalRequest.entity_id == entity_id, ApprovalRequest.amount == amount)
    if db.scalar(base.where(ApprovalRequest.status == "approved")):
        return
    req = db.scalar(base.where(ApprovalRequest.status == "pending"))
    if req is None:
        req = ApprovalRequest(kind=kind, entity_type=entity_type, entity_id=entity_id, amount=amount,
                              summary=summary, payload=payload)
        db.add(req)
        db.flush()
        audit(db, "approval_requested", entity_type=entity_type, entity_id=entity_id, note=summary)
    raise ApprovalNeeded(req.id, summary)  # the request (and anything saved before) is kept


class ApprovalNeeded(KeepChangesError):
    def __init__(self, request_id: int, summary: str):
        super().__init__(409, "approval_required", f"Needs approval: {summary}", {"approval_request_id": str(request_id)})


def check_order_discount(db: Session, order) -> None:
    pct = get_company(db).discount_approval_pct
    if pct is None or not order.subtotal or not order.discount_total:
        return
    given = order.discount_total / order.subtotal * 100
    if given > pct:
        require_approval(db, "order_discount", "orders", order.id, order.discount_total,
                         f"{order.number}: {given:.1f}% discount ({order.discount_total})")


def check_refund(db: Session, order_id: int | None, invoice_id: int | None, body) -> None:
    limit = get_company(db).refund_approval_amount
    if limit is None or body.kind != "refund" or body.amount <= limit:
        return
    payload = {"order_id": order_id, "invoice_id": invoice_id, **body.model_dump(mode="json")}
    require_approval(db, "refund", "orders" if order_id else "sales_documents", order_id or invoice_id, body.amount,
                     f"Refund of {body.amount}", payload)


def execute(db: Session, req: ApprovalRequest) -> None:
    """Carry out what was approved. Discounts need nothing: the order can now be confirmed."""
    if req.kind != "refund":
        return
    from app.numbering import next_number
    from app.orders.models import Order, Payment
    from app.orders.service import refresh_payment_status

    p = req.payload
    order = db.get(Order, p["order_id"]) if p.get("order_id") else None
    pay = Payment(number=next_number(db, "payment"), kind="refund", status=p.get("status", "completed"),
                  customer_id=order.customer_id if order else None, order_id=p.get("order_id"),
                  invoice_id=p.get("invoice_id"), payment_date=date.fromisoformat(p["payment_date"])
                  if p.get("payment_date") else datetime.now().date(), method=p["method"],
                  amount=Decimal(p["amount"]), reference=p.get("reference"), note=p.get("note") or "Approved refund")
    db.add(pay)
    db.flush()
    if order:
        refresh_payment_status(db, order)
    audit(db, "create", pay, note=f"approval request {req.id}")


class DecisionIn(BaseModel):
    note: str | None = None


router = APIRouter(prefix="/approvals", tags=["approvals"])
APPROVE = require_access("approvals", "approve")


@router.post("/{req_id}/approve")
def approve(req_id: int, body: DecisionIn, db: DB, user: User = APPROVE):
    req = get_or_404(db, ApprovalRequest, req_id, "Approval request")
    if req.status != "pending":
        raise AppError(409, "decided", f"Already {req.status}")
    if req.created_by_id == user.id and approvals_on(db):
        raise AppError(403, "own_request", "Someone else must approve this")
    req.status, req.decided_by_id, req.decided_at, req.note = "approved", user.id, utcnow(), body.note
    execute(db, req)
    audit(db, "approve", entity_type="approval_requests", entity_id=req.id)
    return {"id": req.id, "status": req.status}


@router.post("/{req_id}/reject")
def reject(req_id: int, body: DecisionIn, db: DB, user: User = APPROVE):
    req = get_or_404(db, ApprovalRequest, req_id, "Approval request")
    if req.status != "pending":
        raise AppError(409, "decided", f"Already {req.status}")
    req.status, req.decided_by_id, req.decided_at, req.note = "rejected", user.id, utcnow(), body.note
    audit(db, "reject", entity_type="approval_requests", entity_id=req.id, note=body.note)
    return {"id": req.id, "status": req.status}


@router.get("/inbox")
def inbox(user: CurrentUser, db: DB):
    """Everything waiting for this user's decision (not their own requests while approvals are on)."""
    from app.accounting.models import JournalEntry
    from app.expenses import Expense
    from app.partners import Partner, PartnerTransaction
    from app.purchasing.models import PurchaseOrder, PurchaseRequest

    items = []
    others_only = approvals_on(db)  # without approval steps, leftovers of your own show up too

    def add(kind, rows, title, amount, link):
        for r in rows:
            if others_only and r.created_by_id == user.id:
                continue
            items.append({"type": kind, "id": r.id, "title": title(r), "amount": amount(r),
                          "requested_by_id": r.created_by_id, "requested_at": r.created_at, "link": link(r)})

    if can(db, user, "expenses", "approve"):
        add("expense", db.scalars(select(Expense).where(Expense.status == "submitted")),
            lambda e: f"Expense {e.number}: {e.description[:60]}", lambda e: e.amount, lambda e: f"/expenses/{e.id}")
    if can(db, user, "purchasing", "approve"):
        add("purchase_request", db.scalars(select(PurchaseRequest).where(PurchaseRequest.status == "requested")),
            lambda r: f"Purchase request {r.number}", lambda r: r.estimated_total,
            lambda r: f"/purchase-requests/{r.id}")
        add("purchase_order", db.scalars(select(PurchaseOrder).where(PurchaseOrder.status == "requested")),
            lambda r: f"Purchase order {r.number}", lambda r: r.grand_total, lambda r: f"/purchase-orders/{r.id}")
    if can(db, user, "accounting", "approve"):
        add("journal_entry", db.scalars(select(JournalEntry).where(JournalEntry.status == "draft")),
            lambda e: f"Journal entry: {e.memo}", lambda e: None, lambda e: f"/accounting/journal/{e.id}")
    if can(db, user, "partners", "approve"):
        add("partner_transaction", db.scalars(select(PartnerTransaction).where(PartnerTransaction.status == "pending")),
            lambda t: f"{t.kind.replace('_', ' ').title()}: {db.get(Partner, t.partner_id).name}",
            lambda t: t.amount, lambda t: f"/partners/{t.partner_id}")
    if can(db, user, "approvals", "approve"):
        add("approval_request", db.scalars(select(ApprovalRequest).where(ApprovalRequest.status == "pending")),
            lambda r: r.summary, lambda r: r.amount, lambda r: f"/{r.entity_type.replace('_', '-')}/{r.entity_id}")
    return sorted(items, key=lambda i: i["requested_at"])


routers = [router]
