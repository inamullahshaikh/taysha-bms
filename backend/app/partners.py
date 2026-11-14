"""Partners / shareholders: ownership, capital, loans, distributions, resolutions and votes. Confidential."""

from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import Date, DateTime, ForeignKey, Numeric, String, Text, UniqueConstraint, event, func, select
from sqlalchemy.orm import Mapped, mapped_column

from app.accounting.posting import CASH_ACCOUNT, post_entry
from app.audit import audit
from app.auth.access import require_access
from app.auth.models import User
from app.clock import local_today, utcnow
from app.company import approvals_on
from app.crud import RecordOut, crud_router, get_or_404
from app.db import DB, Base, Entity, Money
from app.errors import AppError

ZERO = Decimal(0)
TXN_KINDS = ("capital_contribution", "additional_investment", "loan_in", "loan_repayment", "profit_distribution",
             "drawing", "reimbursement")
# kind -> (debit account, credit account); "cash" means the account for the payment method
POSTING = {"capital_contribution": ("cash", "3000"), "additional_investment": ("cash", "3000"),
           "loan_in": ("cash", "2300"), "loan_repayment": ("2300", "cash"), "profit_distribution": ("3300", "cash"),
           "drawing": ("3300", "cash"), "reimbursement": ("2200", "cash")}


class Partner(Entity, Base):
    __tablename__ = "partners"
    name: Mapped[str] = mapped_column(String(150))
    cnic: Mapped[str | None] = mapped_column(String(20))
    phone: Mapped[str | None] = mapped_column(String(30))
    email: Mapped[str | None] = mapped_column(String(254))
    address: Mapped[str | None] = mapped_column(Text)
    ownership_pct: Mapped[Decimal] = mapped_column(Numeric(6, 3), default=Decimal(0))
    joined_on: Mapped[date | None] = mapped_column(Date)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    notes: Mapped[str | None] = mapped_column(Text)


class OwnershipChange(Base):
    __tablename__ = "ownership_changes"
    id: Mapped[int] = mapped_column(primary_key=True)
    partner_id: Mapped[int] = mapped_column(ForeignKey("partners.id"), index=True)
    old_pct: Mapped[Decimal] = mapped_column(Numeric(6, 3))
    new_pct: Mapped[Decimal] = mapped_column(Numeric(6, 3))
    effective_date: Mapped[date] = mapped_column(Date)
    resolution_id: Mapped[int | None] = mapped_column(ForeignKey("resolutions.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))


class PartnerTransaction(Entity, Base):
    __tablename__ = "partner_transactions"
    partner_id: Mapped[int] = mapped_column(ForeignKey("partners.id"), index=True)
    kind: Mapped[str] = mapped_column(String(30))
    txn_date: Mapped[date] = mapped_column(Date)
    amount: Mapped[Money]
    method: Mapped[str] = mapped_column(String(20), default="bank_transfer")
    reference: Mapped[str | None] = mapped_column(String(100))
    note: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending | approved | rejected
    approved_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Resolution(Entity, Base):
    """Resolutions, decisions and meeting minutes (documents attached as files)."""

    __tablename__ = "resolutions"
    title: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(20), default="resolution")  # resolution | minutes | agreement
    meeting_date: Mapped[date | None] = mapped_column(Date)
    description: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="proposed")  # proposed | approved | rejected | recorded
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Vote(Base):
    __tablename__ = "resolution_votes"
    __table_args__ = (UniqueConstraint("resolution_id", "partner_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    resolution_id: Mapped[int] = mapped_column(ForeignKey("resolutions.id", ondelete="CASCADE"), index=True)
    partner_id: Mapped[int] = mapped_column(ForeignKey("partners.id"))
    vote: Mapped[str] = mapped_column(String(10))  # yes | no | abstain
    weight: Mapped[Decimal] = mapped_column(Numeric(6, 3))  # ownership at the time of voting
    voted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# ---------- schemas ----------

class PartnerIn(BaseModel):
    name: str = Field(min_length=1)
    cnic: str | None = None
    phone: str | None = None
    email: str | None = None
    address: str | None = None
    joined_on: date | None = None
    user_id: int | None = None
    notes: str | None = None


class PartnerPatch(PartnerIn):
    name: str | None = None


class PartnerOut(RecordOut, PartnerIn):
    ownership_pct: Decimal


class OwnershipIn(BaseModel):
    shares: dict[int, Decimal]  # partner_id -> new %
    effective_date: date | None = None
    resolution_id: int | None = None


class TxnIn(BaseModel):
    partner_id: int
    kind: Literal["capital_contribution", "additional_investment", "loan_in", "loan_repayment",
                  "profit_distribution", "drawing", "reimbursement"]
    txn_date: date | None = None
    amount: Decimal = Field(gt=0, decimal_places=2)
    method: Literal["cash", "bank_transfer", "cheque", "other"] = "bank_transfer"
    reference: str | None = None
    note: str | None = None


class TxnOut(RecordOut, TxnIn):
    txn_date: date
    status: str
    created_by_id: int | None
    approved_by_id: int | None


class ResolutionIn(BaseModel):
    title: str = Field(min_length=1)
    kind: Literal["resolution", "minutes", "agreement"] = "resolution"
    meeting_date: date | None = None
    description: str | None = None


class ResolutionPatch(BaseModel):
    title: str | None = None
    meeting_date: date | None = None
    description: str | None = None


class ResolutionOut(RecordOut, ResolutionIn):
    status: str
    decided_at: datetime | None


class VoteIn(BaseModel):
    partner_id: int
    vote: Literal["yes", "no", "abstain"]


# ---------- routes ----------

router = APIRouter(tags=["partners"])
VIEW, EDIT, APPROVE = (require_access("partners", a) for a in ("view", "edit", "approve"))


@router.put("/partners/ownership")
def set_ownership(body: OwnershipIn, db: DB, _: User = APPROVE):
    """Set approved ownership for one or more partners. The total can't exceed 100%."""
    current = {p.id: p for p in db.scalars(select(Partner).where(Partner.archived_at.is_(None)))}
    for pid in body.shares:
        if pid not in current:
            raise AppError(404, "not_found", f"Partner {pid} not found")
    total = sum((body.shares.get(pid, p.ownership_pct) for pid, p in current.items()), ZERO)
    if total > 100:
        raise AppError(422, "over_100", f"Ownership would total {total}%")
    if body.resolution_id:
        r = get_or_404(db, Resolution, body.resolution_id, "Resolution")
        if r.status != "approved":
            raise AppError(422, "resolution_not_approved", "Link an approved resolution")
    for pid, pct in body.shares.items():
        p = current[pid]
        if p.ownership_pct != pct:
            db.add(OwnershipChange(partner_id=pid, old_pct=p.ownership_pct, new_pct=pct,
                                   effective_date=body.effective_date or local_today(),
                                   resolution_id=body.resolution_id, created_by_id=db.info.get("user_id")))
            audit(db, "ownership", entity_type="partners", entity_id=pid,
                  before={"pct": str(p.ownership_pct)}, after={"pct": str(pct)})
            p.ownership_pct = pct
    db.flush()
    return {"total_pct": total.quantize(Decimal("0.001")), "partners": [PartnerOut.model_validate(p) for p in current.values()]}


@router.get("/partners/{partner_id}/ownership-history")
def ownership_history(partner_id: int, db: DB, _: User = VIEW):
    return [{k: getattr(c, k) for k in ("old_pct", "new_pct", "effective_date", "resolution_id", "created_at")}
            for c in db.scalars(select(OwnershipChange).where(OwnershipChange.partner_id == partner_id)
                                .order_by(OwnershipChange.id))]


@router.post("/partner-transactions/{txn_id}/approve", response_model=TxnOut)
def approve_txn(txn_id: int, db: DB, user: User = APPROVE):
    """Approve and post to the ledger. The person who entered it can't approve it."""
    t = get_or_404(db, PartnerTransaction, txn_id, "Transaction")
    if t.status != "pending":
        raise AppError(409, "decided", f"Already {t.status}")
    if t.created_by_id == user.id and approvals_on(db):
        raise AppError(403, "own_entry", "Someone else must approve this")
    t.status, t.approved_by_id, t.approved_at = "approved", user.id, utcnow()
    dr, cr = POSTING[t.kind]
    cash = CASH_ACCOUNT.get(t.method, "1010")
    p = db.get(Partner, t.partner_id)
    post_entry(db, t.txn_date, [(cash if dr == "cash" else dr, t.amount, 0, {}),
                                (cash if cr == "cash" else cr, 0, t.amount, {})],
               f"{t.kind.replace('_', ' ').title()}: {p.name}", ("partner_txn", t.id))
    audit(db, "approve", entity_type="partner_transactions", entity_id=t.id)
    return t


@router.post("/partner-transactions/{txn_id}/reject", response_model=TxnOut)
def reject_txn(txn_id: int, db: DB, _: User = APPROVE):
    t = get_or_404(db, PartnerTransaction, txn_id, "Transaction")
    if t.status != "pending":
        raise AppError(409, "decided", f"Already {t.status}")
    t.status = "rejected"
    return t


@router.post("/resolutions/{res_id}/votes", response_model=ResolutionOut)
def vote(res_id: int, body: VoteIn, db: DB, _: User = EDIT):
    """Record a partner's vote (weighted by ownership). More than 50% yes approves; more than 50% no rejects."""
    r = get_or_404(db, Resolution, res_id, "Resolution")
    if r.status != "proposed":
        raise AppError(409, "decided", f"Resolution is {r.status}")
    p = get_or_404(db, Partner, body.partner_id, "Partner")
    existing = db.scalar(select(Vote).where(Vote.resolution_id == r.id, Vote.partner_id == p.id))
    if existing:
        existing.vote, existing.weight = body.vote, p.ownership_pct
    else:
        db.add(Vote(resolution_id=r.id, partner_id=p.id, vote=body.vote, weight=p.ownership_pct))
    db.flush()
    tally = dict(db.execute(select(Vote.vote, func.sum(Vote.weight)).where(Vote.resolution_id == r.id)
                            .group_by(Vote.vote)).all())
    if tally.get("yes", ZERO) > 50:
        r.status, r.decided_at = "approved", utcnow()
    elif tally.get("no", ZERO) > 50:
        r.status, r.decided_at = "rejected", utcnow()
    audit(db, "vote", entity_type="resolutions", entity_id=r.id, after={"partner": p.id, "vote": body.vote})
    return r


@router.get("/resolutions/{res_id}/votes")
def votes(res_id: int, db: DB, _: User = VIEW):
    return [{"partner_id": v.partner_id, "vote": v.vote, "weight": v.weight, "voted_at": v.voted_at}
            for v in db.scalars(select(Vote).where(Vote.resolution_id == res_id))]


@router.get("/partners/report")
def partners_report(db: DB, _: User = VIEW):
    """Ownership and money in/out per partner (approved transactions only)."""
    out = []
    for p in db.scalars(select(Partner).where(Partner.archived_at.is_(None)).order_by(Partner.name)):
        sums = dict(db.execute(select(PartnerTransaction.kind, func.sum(PartnerTransaction.amount)).where(
            PartnerTransaction.partner_id == p.id, PartnerTransaction.status == "approved")
            .group_by(PartnerTransaction.kind)).all())
        g = lambda k: sums.get(k, ZERO)  # noqa: E731
        contributed = g("capital_contribution") + g("additional_investment")
        out.append({"partner_id": p.id, "name": p.name, "ownership_pct": p.ownership_pct,
                    "capital_contributed": contributed, "loans_outstanding": g("loan_in") - g("loan_repayment"),
                    "distributions": g("profit_distribution"), "drawings": g("drawing"),
                    "reimbursements": g("reimbursement"),
                    "net_invested": contributed - g("profit_distribution") - g("drawing")})
    return {"partners": out, "total_ownership_pct": sum((r["ownership_pct"] for r in out), ZERO)}


crud_routers = [
    crud_router(Partner, prefix="/partners", feature="partners", create=PartnerIn, update=PartnerPatch,
                out=PartnerOut, search=(Partner.name,), default_sort=Partner.name, tags=["partners"]),
    crud_router(PartnerTransaction, prefix="/partner-transactions", feature="partners", create=TxnIn,
                update=BaseModel, out=TxnOut, filters={"partner_id": PartnerTransaction.partner_id,
                                                       "kind": PartnerTransaction.kind,
                                                       "status": PartnerTransaction.status},
                tags=["partners"]),
    crud_router(Resolution, prefix="/resolutions", feature="partners", create=ResolutionIn, update=ResolutionPatch,
                out=ResolutionOut, search=(Resolution.title,), filters={"status": Resolution.status,
                                                                        "kind": Resolution.kind},
                default_sort=Resolution.id.desc(), tags=["partners"]),
]
routers = [router, *crud_routers]


def _txn_defaults(mapper, connection, target):  # date defaults to today for transactions created through the generic CRUD
    if target.txn_date is None:
        target.txn_date = local_today()


event.listen(PartnerTransaction, "before_insert", _txn_defaults)
