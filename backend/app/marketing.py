"""Marketing: campaigns, daily metrics, attribution (campaign / promo code / UTM), influencers, content pipeline,
calendar and performance (CAC, ROAS, profit)."""

from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import (
    Date, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint, func, or_, select,
)
from sqlalchemy import event
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.audit import audit
from app.auth.access import can, require_access
from app.auth.models import User
from app.clock import utcnow
from app.crud import RecordOut, crud_router, get_or_404
from app.db import DB, Base, Entity, Money
from app.errors import AppError
from app.inventory.service import issue
from app.orders.models import DiscountCode, Order, OrderLine
from app.products.models import Product
from app.reports import COUNTED, Range, period

ZERO = Decimal(0)
Platform = Literal["meta", "google", "tiktok", "influencer", "email", "sms", "event", "offline", "other"]


class Campaign(Entity, Base):
    __tablename__ = "campaigns"
    name: Mapped[str] = mapped_column(String(150))
    platform: Mapped[str] = mapped_column(String(20), index=True)
    status: Mapped[str] = mapped_column(String(20), default="planned")  # planned | active | paused | completed
    start_date: Mapped[date | None] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date)
    budget: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    audience: Mapped[str | None] = mapped_column(Text)
    discount_code_id: Mapped[int | None] = mapped_column(ForeignKey("discount_codes.id"))
    utm_campaign: Mapped[str | None] = mapped_column(String(100), index=True)
    product_ids: Mapped[list] = mapped_column(JSONB, default=list)
    creative_notes: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)


class CampaignMetric(Base):
    __tablename__ = "campaign_metrics"
    __table_args__ = (UniqueConstraint("campaign_id", "metric_date"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    campaign_id: Mapped[int] = mapped_column(ForeignKey("campaigns.id", ondelete="CASCADE"), index=True)
    metric_date: Mapped[date] = mapped_column(Date)
    spend: Mapped[Money] = mapped_column(default=Decimal(0))
    reach: Mapped[int] = mapped_column(Integer, default=0)
    impressions: Mapped[int] = mapped_column(Integer, default=0)
    clicks: Mapped[int] = mapped_column(Integer, default=0)
    leads: Mapped[int] = mapped_column(Integer, default=0)
    conversions: Mapped[int] = mapped_column(Integer, default=0)


class Influencer(Entity, Base):
    __tablename__ = "influencers"
    name: Mapped[str] = mapped_column(String(120))
    handle: Mapped[str | None] = mapped_column(String(120))
    platform: Mapped[str | None] = mapped_column(String(20))
    followers: Mapped[int | None] = mapped_column(Integer)
    phone: Mapped[str | None] = mapped_column(String(30))
    email: Mapped[str | None] = mapped_column(String(254))
    rate: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    notes: Mapped[str | None] = mapped_column(Text)


class InfluencerDeal(Entity, Base):
    __tablename__ = "influencer_deals"
    campaign_id: Mapped[int | None] = mapped_column(ForeignKey("campaigns.id"), index=True)
    influencer_id: Mapped[int] = mapped_column(ForeignKey("influencers.id"), index=True)
    fee: Mapped[Money] = mapped_column(default=Decimal(0))
    deliverables: Mapped[str | None] = mapped_column(Text)
    posting_date: Mapped[date | None] = mapped_column(Date)
    post_url: Mapped[str | None] = mapped_column(String(300))
    status: Mapped[str] = mapped_column(String(20), default="agreed")  # agreed|samples_sent|posted|paid|cancelled
    samples: Mapped[list] = mapped_column(JSONB, default=list)  # [{"product_id", "quantity"}]
    samples_sent: Mapped[bool] = mapped_column(default=False)


class ContentItem(Entity, Base):
    __tablename__ = "content_items"
    title: Mapped[str] = mapped_column(String(200))
    platform: Mapped[str | None] = mapped_column(String(20))
    campaign_id: Mapped[int | None] = mapped_column(ForeignKey("campaigns.id"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="idea", index=True)
    scheduled_for: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    caption: Mapped[str | None] = mapped_column(Text)
    link: Mapped[str | None] = mapped_column(String(300))
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    notes: Mapped[str | None] = mapped_column(Text)


@event.listens_for(ContentItem.status, "set")
def _published(target, value, old, _):
    if value == "published" and old != "published":
        target.published_at = utcnow()


# ---------- schemas ----------

class CampaignIn(BaseModel):
    name: str = Field(min_length=1)
    platform: Platform
    status: Literal["planned", "active", "paused", "completed"] = "planned"
    start_date: date | None = None
    end_date: date | None = None
    budget: Decimal | None = Field(None, ge=0)
    audience: str | None = None
    discount_code_id: int | None = None
    utm_campaign: str | None = None
    product_ids: list[int] = []
    creative_notes: str | None = None
    notes: str | None = None


class CampaignPatch(BaseModel):
    name: str | None = None
    status: Literal["planned", "active", "paused", "completed"] | None = None
    start_date: date | None = None
    end_date: date | None = None
    budget: Decimal | None = Field(None, ge=0)
    audience: str | None = None
    discount_code_id: int | None = None
    utm_campaign: str | None = None
    product_ids: list[int] | None = None
    creative_notes: str | None = None
    notes: str | None = None


class CampaignOut(RecordOut, CampaignIn):
    created_at: datetime


class MetricIn(BaseModel):
    metric_date: date
    spend: Decimal = Field(ZERO, ge=0)
    reach: int = Field(0, ge=0)
    impressions: int = Field(0, ge=0)
    clicks: int = Field(0, ge=0)
    leads: int = Field(0, ge=0)
    conversions: int = Field(0, ge=0)


class InfluencerIn(BaseModel):
    name: str = Field(min_length=1)
    handle: str | None = None
    platform: str | None = None
    followers: int | None = Field(None, ge=0)
    phone: str | None = None
    email: str | None = None
    rate: Decimal | None = Field(None, ge=0)
    notes: str | None = None


class InfluencerPatch(InfluencerIn):
    name: str | None = None


class InfluencerOut(RecordOut, InfluencerIn):
    pass


class SampleLine(BaseModel):
    product_id: int
    quantity: Decimal = Field(gt=0)


class DealIn(BaseModel):
    campaign_id: int | None = None
    influencer_id: int
    fee: Decimal = Field(ZERO, ge=0)
    deliverables: str | None = None
    posting_date: date | None = None
    post_url: str | None = None
    status: Literal["agreed", "samples_sent", "posted", "paid", "cancelled"] = "agreed"
    samples: list[SampleLine] = []

    def model_dump(self, **kw):
        d = super().model_dump(**kw)
        if "samples" in d and d["samples"] is not None:
            d["samples"] = [{"product_id": s["product_id"], "quantity": str(s["quantity"])} for s in d["samples"]]
        return d


class DealPatch(BaseModel):
    fee: Decimal | None = Field(None, ge=0)
    deliverables: str | None = None
    posting_date: date | None = None
    post_url: str | None = None
    status: Literal["agreed", "samples_sent", "posted", "paid", "cancelled"] | None = None


class DealOut(RecordOut):
    campaign_id: int | None
    influencer_id: int
    fee: Decimal
    deliverables: str | None
    posting_date: date | None
    post_url: str | None
    status: str
    samples: list
    samples_sent: bool


ContentStatus = Literal["idea", "planned", "in_production", "approved", "scheduled", "published"]


class ContentIn(BaseModel):
    title: str = Field(min_length=1)
    platform: str | None = None
    campaign_id: int | None = None
    status: ContentStatus = "idea"
    scheduled_for: datetime | None = None
    caption: str | None = None
    link: str | None = None
    owner_id: int | None = None
    notes: str | None = None


class ContentPatch(BaseModel):
    title: str | None = None
    platform: str | None = None
    campaign_id: int | None = None
    status: ContentStatus | None = None
    scheduled_for: datetime | None = None
    caption: str | None = None
    link: str | None = None
    owner_id: int | None = None
    notes: str | None = None


class ContentOut(RecordOut, ContentIn):
    published_at: datetime | None


# ---------- attribution & performance ----------

def attributed_orders(c: Campaign):
    """Orders credited to a campaign: tagged with it, used its promo code, or arrived with its UTM tag."""
    conds = [Order.campaign_id == c.id]
    if c.discount_code_id:
        conds.append(Order.discount_code_id == c.discount_code_id)
    if c.utm_campaign:
        conds.append(Order.external_data["landing_site"].astext.contains(f"utm_campaign={c.utm_campaign}"))
    return or_(*conds)


def performance(db: Session, c: Campaign, start: date | None, end: date | None, show_cost: bool) -> dict:
    mq = select(func.coalesce(func.sum(CampaignMetric.spend), 0), func.coalesce(func.sum(CampaignMetric.reach), 0),
                func.coalesce(func.sum(CampaignMetric.impressions), 0), func.coalesce(func.sum(CampaignMetric.clicks), 0),
                func.coalesce(func.sum(CampaignMetric.leads), 0), func.coalesce(func.sum(CampaignMetric.conversions), 0)
                ).where(CampaignMetric.campaign_id == c.id)
    oq = select(Order).where(attributed_orders(c), Order.status.in_(COUNTED))
    if start and end:
        mq = mq.where(CampaignMetric.metric_date.between(start, end))
        oq = oq.where(Order.order_date.between(start, end))
    spend, reach, impressions, clicks, leads, conversions = db.execute(mq).one()
    fees = db.scalar(select(func.coalesce(func.sum(InfluencerDeal.fee), 0)).where(
        InfluencerDeal.campaign_id == c.id, InfluencerDeal.status != "cancelled"))
    orders = db.scalars(oq).all()
    revenue = sum((o.grand_total for o in orders), ZERO)
    net = sum((o.net_total for o in orders), ZERO)
    ids = [o.id for o in orders]
    cogs = db.scalar(select(func.coalesce(func.sum(OrderLine.quantity * func.coalesce(OrderLine.unit_cost, 0)), 0))
                     .where(OrderLine.order_id.in_(ids))) if ids else ZERO
    new_customers = 0
    for o in orders:
        if o.customer_id and not db.scalar(select(Order.id).where(
                Order.customer_id == o.customer_id, Order.status.in_(COUNTED), Order.id < o.id).limit(1)):
            new_customers += 1
    total_cost = spend + fees
    out = {"campaign_id": c.id, "name": c.name, "platform": c.platform, "spend": spend, "influencer_fees": fees,
           "total_cost": total_cost, "reach": reach, "impressions": impressions, "clicks": clicks, "leads": leads,
           "conversions": conversions, "orders": len(orders), "revenue": revenue, "new_customers": new_customers,
           "ctr_pct": round(Decimal(clicks) / impressions * 100, 2) if impressions else None,
           "cac": (total_cost / new_customers).quantize(Decimal("0.01")) if new_customers else None,
           "roas": (revenue / total_cost).quantize(Decimal("0.01")) if total_cost else None,
           "budget_used_pct": (total_cost / c.budget * 100).quantize(Decimal("0.1")) if c.budget else None}
    if show_cost:
        out["gross_profit"] = (net - cogs).quantize(Decimal("0.01"))
        out["profit_after_marketing"] = (net - cogs - total_cost).quantize(Decimal("0.01"))
    return out


router = APIRouter(tags=["marketing"])
VIEW, EDIT = require_access("marketing", "view"), require_access("marketing", "edit")


@router.put("/campaigns/{campaign_id}/metrics")
def put_metrics(campaign_id: int, body: list[MetricIn], db: DB, _: User = EDIT):
    """Upsert daily numbers (from Meta/Google exports or typed in)."""
    get_or_404(db, Campaign, campaign_id, "Campaign")
    for m in body:
        row = db.scalar(select(CampaignMetric).where(CampaignMetric.campaign_id == campaign_id,
                                                     CampaignMetric.metric_date == m.metric_date))
        if row is None:
            row = CampaignMetric(campaign_id=campaign_id, metric_date=m.metric_date)
            db.add(row)
        for k, v in m.model_dump().items():
            setattr(row, k, v)
    audit(db, "update", entity_type="campaigns", entity_id=campaign_id, note=f"{len(body)} metric days")
    return {"saved": len(body)}


@router.get("/campaigns/{campaign_id}/metrics")
def get_metrics(campaign_id: int, db: DB, _: User = VIEW):
    return [{k: getattr(m, k) for k in ("metric_date", "spend", "reach", "impressions", "clicks", "leads",
                                        "conversions")}
            for m in db.scalars(select(CampaignMetric).where(CampaignMetric.campaign_id == campaign_id)
                                .order_by(CampaignMetric.metric_date))]


@router.get("/campaigns/{campaign_id}/performance")
def campaign_performance(campaign_id: int, db: DB, user: User = VIEW):
    c = get_or_404(db, Campaign, campaign_id, "Campaign")
    return performance(db, c, None, None, can(db, user, "product_costs", "view"))


@router.get("/marketing/performance")
def marketing_performance(db: DB, range: Range = "month", date_from: date | None = None, date_to: date | None = None,
                          group_by: Literal["campaign", "platform"] = "campaign", platform: str | None = None,
                          user: User = VIEW):
    start, end = period(range, date_from, date_to)
    show = can(db, user, "product_costs", "view")
    q = select(Campaign).where(Campaign.archived_at.is_(None))
    if platform:
        q = q.where(Campaign.platform == platform)
    rows = [performance(db, c, start, end, show) for c in db.scalars(q)]
    rows = [r for r in rows if r["total_cost"] or r["orders"]]
    if group_by == "platform":
        agg: dict[str, dict] = {}
        keys = ("spend", "influencer_fees", "total_cost", "impressions", "clicks", "leads", "orders", "revenue",
                "new_customers", "gross_profit", "profit_after_marketing")
        for r in rows:
            a = agg.setdefault(r["platform"], {"platform": r["platform"], **{k: 0 for k in keys if k in r}})
            for k in keys:
                if k in r:
                    a[k] += r[k]
        for a in agg.values():
            a["roas"] = (a["revenue"] / a["total_cost"]).quantize(Decimal("0.01")) if a["total_cost"] else None
            a["cac"] = (a["total_cost"] / a["new_customers"]).quantize(Decimal("0.01")) if a["new_customers"] else None
        rows = list(agg.values())
    return {"from": start, "to": end, "rows": rows}


@router.get("/marketing/promo-codes")
def promo_codes(db: DB, range: Range = "year", date_from: date | None = None, date_to: date | None = None,
                _: User = VIEW):
    """Sales impact of each discount code."""
    start, end = period(range, date_from, date_to)
    rows = db.execute(select(DiscountCode.code, func.count(Order.id), func.coalesce(func.sum(Order.grand_total), 0),
                             func.coalesce(func.sum(Order.discount_total), 0))
                      .join(Order, Order.discount_code_id == DiscountCode.id)
                      .where(Order.status.in_(COUNTED), Order.order_date.between(start, end))
                      .group_by(DiscountCode.code).order_by(func.count(Order.id).desc()))
    return [{"code": code, "orders": n, "revenue": rev, "discount_given": disc,
             "average_order": (rev / n).quantize(Decimal("0.01")) if n else ZERO} for code, n, rev, disc in rows]


@router.post("/influencer-deals/{deal_id}/send-samples")
def send_samples(deal_id: int, warehouse_id: int, db: DB, _: User = require_access("inventory", "create")):
    d = get_or_404(db, InfluencerDeal, deal_id, "Deal")
    if d.samples_sent or not d.samples:
        raise AppError(409, "nothing_to_send", "No samples to send, or already sent")
    inf = db.get(Influencer, d.influencer_id)
    for s in d.samples:
        issue(db, product_id=s["product_id"], warehouse_id=warehouse_id, quantity=Decimal(s["quantity"]),
              reason="sample", ref=("influencer_deal", d.id, inf.name), note=f"Influencer samples: {inf.name}")
    d.samples_sent = True
    d.status = "samples_sent" if d.status == "agreed" else d.status
    audit(db, "samples_sent", entity_type="influencer_deals", entity_id=d.id)
    return {"sent": len(d.samples)}


@router.get("/marketing/calendar")
def calendar(db: DB, date_from: date, date_to: date, _: User = VIEW):
    """Campaigns, content, launches, promotions and influencer posts in one timeline."""
    items = []
    for c in db.scalars(select(Campaign).where(Campaign.archived_at.is_(None),
                                               Campaign.start_date <= date_to,
                                               func.coalesce(Campaign.end_date, Campaign.start_date) >= date_from)):
        items.append({"type": "campaign", "id": c.id, "title": c.name, "start": c.start_date,
                      "end": c.end_date, "status": c.status, "platform": c.platform})
    for ci in db.scalars(select(ContentItem).where(func.date(ContentItem.scheduled_for).between(date_from, date_to))):
        items.append({"type": "content", "id": ci.id, "title": ci.title, "start": ci.scheduled_for,
                      "status": ci.status, "platform": ci.platform})
    for p in db.scalars(select(Product).where(Product.launch_date.between(date_from, date_to))):
        items.append({"type": "launch", "id": p.id, "title": f"Launch: {p.name}", "start": p.launch_date})
    for dc in db.scalars(select(DiscountCode).where(DiscountCode.valid_from <= date_to,
                                                    func.coalesce(DiscountCode.valid_to, date_to) >= date_from)):
        items.append({"type": "promotion", "id": dc.id, "title": f"Code {dc.code}", "start": dc.valid_from,
                      "end": dc.valid_to})
    for d, inf in db.execute(select(InfluencerDeal, Influencer).join(Influencer)
                             .where(InfluencerDeal.posting_date.between(date_from, date_to))):
        items.append({"type": "influencer_post", "id": d.id, "title": f"{inf.name} post", "start": d.posting_date,
                      "status": d.status})
    return sorted(items, key=lambda i: str(i["start"]))


def marketing_dashboard(db: Session, start: date, end: date) -> dict:
    spend = db.scalar(select(func.coalesce(func.sum(CampaignMetric.spend), 0)).where(
        CampaignMetric.metric_date.between(start, end)))
    leads = db.scalar(select(func.coalesce(func.sum(CampaignMetric.leads), 0)).where(
        CampaignMetric.metric_date.between(start, end)))
    perf = [performance(db, c, start, end, False) for c in db.scalars(select(Campaign).where(
        Campaign.archived_at.is_(None)))]
    revenue = sum((p["revenue"] for p in perf), ZERO)
    new = sum(p["new_customers"] for p in perf)
    cost = sum((p["total_cost"] for p in perf), ZERO)
    return {"spend": spend, "total_campaigns": len(perf),
            "active_campaigns": db.scalar(select(func.count()).select_from(Campaign).where(Campaign.status == "active")),
            "leads": leads, "attributed_orders": sum(p["orders"] for p in perf), "marketing_revenue": revenue,
            "cac": (cost / new).quantize(Decimal("0.01")) if new else None,
            "roas": (revenue / cost).quantize(Decimal("0.01")) if cost else None}


crud_routers = [
    crud_router(Campaign, prefix="/campaigns", feature="marketing", create=CampaignIn, update=CampaignPatch,
                out=CampaignOut, search=(Campaign.name,), filters={"platform": Campaign.platform,
                                                                    "status": Campaign.status},
                default_sort=Campaign.start_date.desc().nulls_last(), tags=["marketing"]),
    crud_router(Influencer, prefix="/influencers", feature="marketing", create=InfluencerIn, update=InfluencerPatch,
                out=InfluencerOut, search=(Influencer.name, Influencer.handle), default_sort=Influencer.name,
                tags=["marketing"]),
    crud_router(InfluencerDeal, prefix="/influencer-deals", feature="marketing", create=DealIn, update=DealPatch,
                out=DealOut, filters={"campaign_id": InfluencerDeal.campaign_id,
                                      "influencer_id": InfluencerDeal.influencer_id, "status": InfluencerDeal.status},
                tags=["marketing"]),
    crud_router(ContentItem, prefix="/content", feature="marketing", create=ContentIn, update=ContentPatch,
                out=ContentOut, search=(ContentItem.title, ContentItem.caption),
                filters={"status": ContentItem.status, "campaign_id": ContentItem.campaign_id,
                         "platform": ContentItem.platform, "owner_id": ContentItem.owner_id},
                default_sort=ContentItem.scheduled_for.asc().nulls_last(), tags=["marketing"]),
]
routers = [router, *crud_routers]
