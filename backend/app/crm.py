"""CRM extras: leads, follow-ups, segments, inactive / due-for-repeat lists, loyalty points and referrals."""

import secrets
from datetime import date, datetime, timedelta
from decimal import ROUND_FLOOR, Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import BigInteger, Date, DateTime, ForeignKey, Integer, String, Text, func, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.audit import audit
from app.auth.access import require_access
from app.auth.deps import CurrentUser
from app.auth.models import User
from app.clock import local_today, utcnow
from app.company import get_company
from app.crud import RecordOut, crud_router, get_or_404
from app.customers import Customer, CustomerOut
from app.db import DB, Base, Entity
from app.errors import AppError
from app.listing import ListParams, Page, export_response, paginate
from app.orders.models import Order
from app.reports import COUNTED

ZERO = Decimal(0)


class Lead(Entity, Base):
    __tablename__ = "leads"
    name: Mapped[str] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(30))
    email: Mapped[str | None] = mapped_column(String(254))
    company: Mapped[str | None] = mapped_column(String(200))
    source: Mapped[str | None] = mapped_column(String(40))
    campaign_id: Mapped[int | None] = mapped_column(ForeignKey("campaigns.id"))
    status: Mapped[str] = mapped_column(String(20), default="new", index=True)  # new|contacted|qualified|won|lost
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    notes: Mapped[str | None] = mapped_column(Text)
    lost_reason: Mapped[str | None] = mapped_column(Text)
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("customers.id"))


class FollowUp(Entity, Base):
    __tablename__ = "follow_ups"
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("customers.id"), index=True)
    lead_id: Mapped[int | None] = mapped_column(ForeignKey("leads.id"), index=True)
    due_date: Mapped[date] = mapped_column(Date, index=True)
    note: Mapped[str] = mapped_column(Text)
    assigned_to_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    done_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    outcome: Mapped[str | None] = mapped_column(Text)


class Segment(Entity, Base):
    __tablename__ = "segments"
    name: Mapped[str] = mapped_column(String(120), unique=True)
    rules: Mapped[dict] = mapped_column(JSONB)


class LoyaltyEntry(Base):
    __tablename__ = "loyalty_entries"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"), index=True)
    points: Mapped[int] = mapped_column(Integer)  # + earned, - redeemed
    reason: Mapped[str] = mapped_column(String(20))  # earn | redeem | referral | adjust | reverse
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"), index=True)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_by_id: Mapped[int | None] = mapped_column(BigInteger)


# ======================= loyalty =======================

def balance(db: Session, customer_id: int) -> int:
    return db.scalar(select(func.coalesce(func.sum(LoyaltyEntry.points), 0)).where(
        LoyaltyEntry.customer_id == customer_id))


def points_value(db: Session, points: int) -> Decimal:
    return (Decimal(points) * get_company(db).loyalty_point_value).quantize(Decimal("0.01"))


def apply_redemption(db: Session, order: Order, points: int) -> None:
    """Called when an order is saved: replaces the order's redemption entry (balance re-checked)."""
    db.query(LoyaltyEntry).filter(LoyaltyEntry.order_id == order.id, LoyaltyEntry.reason == "redeem").delete()
    db.flush()
    if not points:
        return
    if not order.customer_id:
        raise AppError(422, "no_customer", "Points need a customer on the order")
    if balance(db, order.customer_id) < points:
        raise AppError(422, "not_enough_points", f"The customer has only {balance(db, order.customer_id)} points")
    db.add(LoyaltyEntry(customer_id=order.customer_id, points=-points, reason="redeem", order_id=order.id,
                        created_by_id=db.info.get("user_id")))


def reverse_redemption(db: Session, order: Order) -> None:
    """Cancelled order: points come back."""
    used = db.scalar(select(func.coalesce(func.sum(LoyaltyEntry.points), 0)).where(
        LoyaltyEntry.order_id == order.id, LoyaltyEntry.reason.in_(("redeem", "reverse"))))
    if used < 0:
        db.add(LoyaltyEntry(customer_id=order.customer_id, points=-used, reason="reverse", order_id=order.id,
                            note="Order cancelled"))


def award_points(db: Session) -> str:
    """Daily: points for delivered orders, plus a referral bonus on a referred customer's first delivered order."""
    co = get_company(db)
    n = 0
    earned = select(LoyaltyEntry.order_id).where(LoyaltyEntry.reason == "earn")
    for o in db.scalars(select(Order).where(Order.status == "delivered", Order.customer_id.is_not(None),
                                            Order.id.not_in(earned))):
        pts = int((o.grand_total / 100 * co.loyalty_points_per_100).to_integral_value(rounding=ROUND_FLOOR))
        if pts > 0:
            db.add(LoyaltyEntry(customer_id=o.customer_id, points=pts, reason="earn", order_id=o.id))
            n += 1
        if o.referred_by_customer_id and co.referral_bonus_points and not db.scalar(
                select(LoyaltyEntry.id).where(LoyaltyEntry.reason == "referral",
                                              LoyaltyEntry.note == f"customer:{o.customer_id}")):
            db.add(LoyaltyEntry(customer_id=o.referred_by_customer_id, points=co.referral_bonus_points,
                                reason="referral", order_id=o.id, note=f"customer:{o.customer_id}"))
    db.flush()
    return f"points for {n} orders"


# ======================= segments =======================

class Rules(BaseModel):
    type: str | None = None
    tags_any: list[str] = []
    min_orders: int | None = None
    min_spend: Decimal | None = None
    inactive_days: int | None = None  # last order more than N days ago
    active_within_days: int | None = None  # ordered in the last N days
    city: str | None = None
    territory_id: int | None = None
    marketing_opt_in: bool | None = None


def segment_query(r: Rules):
    stats = (select(Order.customer_id.label("cid"), func.count().label("n"), func.sum(Order.grand_total).label("spend"),
                    func.max(Order.order_date).label("last"))
             .where(Order.status.in_(COUNTED), Order.customer_id.is_not(None)).group_by(Order.customer_id).subquery())
    q = select(Customer).outerjoin(stats, stats.c.cid == Customer.id).where(Customer.archived_at.is_(None))
    t = local_today()
    if r.type:
        q = q.where(Customer.type == r.type)
    if r.tags_any:
        q = q.where(Customer.tags.op("?|")(r.tags_any))
    if r.min_orders is not None:
        q = q.where(func.coalesce(stats.c.n, 0) >= r.min_orders)
    if r.min_spend is not None:
        q = q.where(func.coalesce(stats.c.spend, 0) >= r.min_spend)
    if r.inactive_days is not None:
        q = q.where(stats.c.last < t - timedelta(days=r.inactive_days))
    if r.active_within_days is not None:
        q = q.where(stats.c.last >= t - timedelta(days=r.active_within_days))
    if r.city:
        from app.customers import CustomerAddress

        q = q.where(Customer.id.in_(select(CustomerAddress.customer_id).where(CustomerAddress.city.ilike(r.city))))
    if r.territory_id is not None:
        q = q.where(Customer.territory_id == r.territory_id)
    if r.marketing_opt_in is not None:
        q = q.where(Customer.marketing_opt_in == r.marketing_opt_in)
    return q.order_by(Customer.name)


class SegmentIn(BaseModel):
    name: str = Field(min_length=1)
    rules: Rules

    def model_dump(self, **kw):
        return super().model_dump(mode="json", **kw)


class SegmentPatch(BaseModel):
    name: str | None = None
    rules: Rules | None = None

    def model_dump(self, **kw):
        return super().model_dump(mode="json", **kw)


class SegmentOut(RecordOut):
    name: str
    rules: dict


# ======================= routes =======================

router = APIRouter(tags=["crm"])
C_VIEW, C_EDIT, C_EXPORT = (require_access("customers", a) for a in ("view", "edit", "export"))


@router.post("/segments/preview", response_model=Page[CustomerOut])
def preview_segment(rules: Rules, db: DB, p: Annotated[ListParams, Depends()], _: User = C_VIEW):
    return paginate(db, segment_query(rules), p, CustomerOut)


@router.get("/segments/{segment_id}/customers", response_model=Page[CustomerOut])
def segment_customers(segment_id: int, db: DB, p: Annotated[ListParams, Depends()], _: User = C_VIEW):
    s = get_or_404(db, Segment, segment_id, "Segment")
    return paginate(db, segment_query(Rules(**s.rules)), p, CustomerOut)


@router.get("/segments/{segment_id}/export")
def export_segment(segment_id: int, db: DB, format: str = "csv", _: User = C_EXPORT):
    s = get_or_404(db, Segment, segment_id, "Segment")
    rows = [CustomerOut.model_validate(c).model_dump() for c in db.scalars(segment_query(Rules(**s.rules)))]
    cols = [("name", "Name"), ("phone", "Phone"), ("email", "Email"), ("type", "Type"),
            ("marketing_opt_in", "Marketing OK")]
    return export_response(db, rows, cols, format, f"segment-{s.name}", "customers")


@router.get("/customers/insights/inactive", response_model=Page[CustomerOut])
def inactive(db: DB, p: Annotated[ListParams, Depends()], days: int = 90, _: User = C_VIEW):
    return paginate(db, segment_query(Rules(inactive_days=days, min_orders=1)), p, CustomerOut)


@router.get("/customers/insights/due-repeat")
def due_repeat(db: DB, _: User = C_VIEW):
    """Customers with 2+ orders whose usual gap between orders has passed since their last one."""
    rows = db.execute(select(Order.customer_id, func.count(), func.min(Order.order_date), func.max(Order.order_date))
                      .where(Order.status.in_(COUNTED), Order.customer_id.is_not(None))
                      .group_by(Order.customer_id).having(func.count() >= 2)).all()
    t, out = local_today(), []
    for cid, n, first, last in rows:
        gap = (last - first).days / (n - 1)
        if gap and (t - last).days >= gap:
            c = db.get(Customer, cid)
            out.append({"customer_id": cid, "name": c.name, "phone": c.phone, "orders": n,
                        "usual_gap_days": round(gap), "days_since_last": (t - last).days, "last_order": last})
    return sorted(out, key=lambda r: r["days_since_last"] - r["usual_gap_days"], reverse=True)


@router.post("/leads/{lead_id}/convert", response_model=CustomerOut)
def convert_lead(lead_id: int, db: DB, _: User = C_EDIT):
    lead = get_or_404(db, Lead, lead_id, "Lead")
    if lead.customer_id:
        raise AppError(409, "converted", "Already a customer")
    c = Customer(name=lead.name, phone=lead.phone, email=lead.email, company_name=lead.company,
                 source=lead.source or "lead", type="corporate" if lead.company else "retail")
    db.add(c)
    db.flush()
    lead.customer_id, lead.status = c.id, "won"
    db.query(FollowUp).filter(FollowUp.lead_id == lead.id).update({FollowUp.customer_id: c.id})
    audit(db, "create", c, note=f"from lead {lead.id}")
    return c


class DoneIn(BaseModel):
    outcome: str | None = None


@router.get("/follow-ups/mine")
def my_follow_ups(user: CurrentUser, db: DB, include_done: bool = False):
    q = select(FollowUp).where(FollowUp.assigned_to_id == user.id).order_by(FollowUp.due_date)
    if not include_done:
        q = q.where(FollowUp.done_at.is_(None))
    return [FollowUpOut.model_validate(f) for f in db.scalars(q)]


@router.post("/follow-ups/{fid}/done")
def follow_up_done(fid: int, body: DoneIn, db: DB, user: CurrentUser):
    f = get_or_404(db, FollowUp, fid, "Follow-up")
    f.done_at, f.outcome = utcnow(), body.outcome
    audit(db, "done", entity_type="follow_ups", entity_id=f.id)
    return FollowUpOut.model_validate(f)


@router.get("/customers/{customer_id}/loyalty")
def loyalty(customer_id: int, db: DB, _: User = C_VIEW):
    get_or_404(db, Customer, customer_id, "Customer")
    pts = balance(db, customer_id)
    entries = db.scalars(select(LoyaltyEntry).where(LoyaltyEntry.customer_id == customer_id)
                         .order_by(LoyaltyEntry.id.desc()).limit(100))
    return {"points": pts, "value": points_value(db, pts),
            "entries": [{k: getattr(e, k) for k in ("points", "reason", "order_id", "note", "created_at")}
                        for e in entries]}


class AdjustIn(BaseModel):
    points: int
    note: str = Field(min_length=3)


@router.post("/customers/{customer_id}/loyalty/adjust")
def adjust_points(customer_id: int, body: AdjustIn, db: DB, user: User = C_EDIT):
    get_or_404(db, Customer, customer_id, "Customer")
    if balance(db, customer_id) + body.points < 0:
        raise AppError(422, "negative_points", "Points can't go below zero")
    db.add(LoyaltyEntry(customer_id=customer_id, points=body.points, reason="adjust", note=body.note,
                        created_by_id=user.id))
    audit(db, "loyalty_adjust", entity_type="customers", entity_id=customer_id, note=body.note)
    db.flush()
    return loyalty(customer_id, db)


@router.post("/customers/{customer_id}/referral-code")
def referral_code(customer_id: int, db: DB, _: User = C_EDIT):
    c = get_or_404(db, Customer, customer_id, "Customer")
    if not c.referral_code:
        base = "".join(ch for ch in c.name.upper() if ch.isalpha())[:5] or "TAY"
        c.referral_code = f"{base}{secrets.token_hex(2).upper()}"
    return {"referral_code": c.referral_code}


# ======================= CRUD =======================

class LeadIn(BaseModel):
    name: str = Field(min_length=1)
    phone: str | None = None
    email: str | None = None
    company: str | None = None
    source: str | None = None
    campaign_id: int | None = None
    status: Literal["new", "contacted", "qualified", "won", "lost"] = "new"
    owner_id: int | None = None
    notes: str | None = None
    lost_reason: str | None = None


class LeadPatch(LeadIn):
    name: str | None = None
    status: Literal["new", "contacted", "qualified", "won", "lost"] | None = None


class LeadOut(RecordOut, LeadIn):
    customer_id: int | None
    created_at: datetime


class FollowUpIn(BaseModel):
    customer_id: int | None = None
    lead_id: int | None = None
    due_date: date
    note: str = Field(min_length=1)
    assigned_to_id: int | None = None


class FollowUpPatch(BaseModel):
    due_date: date | None = None
    note: str | None = None
    assigned_to_id: int | None = None


class FollowUpOut(RecordOut, FollowUpIn):
    done_at: datetime | None
    outcome: str | None


crud_routers = [
    crud_router(Lead, prefix="/leads", feature="customers", create=LeadIn, update=LeadPatch, out=LeadOut,
                search=(Lead.name, Lead.phone, Lead.email, Lead.company),
                filters={"status": Lead.status, "owner_id": Lead.owner_id, "source": Lead.source,
                         "campaign_id": Lead.campaign_id}, tags=["crm"]),
    crud_router(FollowUp, prefix="/follow-ups", feature="customers", create=FollowUpIn, update=FollowUpPatch,
                out=FollowUpOut, filters={"customer_id": FollowUp.customer_id, "lead_id": FollowUp.lead_id,
                                          "assigned_to_id": FollowUp.assigned_to_id},
                default_sort=FollowUp.due_date, tags=["crm"]),
    crud_router(Segment, prefix="/segments", feature="customers", create=SegmentIn, update=SegmentPatch,
                out=SegmentOut, search=(Segment.name,), default_sort=Segment.name, tags=["crm"]),
]
routers = [router, *crud_routers]
