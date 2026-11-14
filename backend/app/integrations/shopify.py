"""Shopify: product/variant mapping, order import (webhooks + polling), stock push, fulfilment sync, sync log.

This system is the master for stock; Shopify is the master for online orders. Every import is idempotent
(webhook id + unique (source, external_id) on orders), and failures land in the sync log with a retry button.
"""

import base64
import hashlib
import hmac
import json
import logging
from datetime import datetime
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, String, Text, func, select
from sqlalchemy.dialects.postgresql import JSONB, insert
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.audit import audit
from app.auth.access import require_access
from app.auth.models import User
from app.clock import local_today, utcnow
from app.config import settings
from app.customers import Customer, CustomerAddress, clean_phone
from app.db import DB, Base
from app.errors import AppError, not_found
from app.inventory.service import available
from app.listing import ListParams, Page, apply_filters, paginate
from app.numbering import next_number
from app.orders.calc import LineCalc, calculate
from app.orders.models import Order, OrderLine, OrderStatusHistory, Payment
from app.orders.service import change_status, refresh_payment_status
from app.products.models import Product
from app.products.pricing import money, tax_rate_of

log = logging.getLogger(__name__)
API_VERSION = "2025-01"
ZERO = Decimal(0)


# ---------- models ----------

class IntegrationSetting(Base):
    __tablename__ = "integration_settings"
    name: Mapped[str] = mapped_column(String(30), primary_key=True)  # "shopify"
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    config: Mapped[dict] = mapped_column(JSONB, default=dict)  # non-secret settings
    secret: Mapped[str | None] = mapped_column(Text)  # encrypted JSON of secrets
    last_order_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ShopifyVariant(Base):
    __tablename__ = "shopify_variants"
    variant_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    shopify_product_id: Mapped[str] = mapped_column(String(40))
    inventory_item_id: Mapped[str | None] = mapped_column(String(40))
    title: Mapped[str] = mapped_column(String(255))
    sku: Mapped[str | None] = mapped_column(String(100), index=True)
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"), index=True)  # mapping
    last_pushed_qty: Mapped[Decimal | None] = mapped_column()


class SyncLog(Base):
    __tablename__ = "sync_log"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    integration: Mapped[str] = mapped_column(String(30), default="shopify")
    direction: Mapped[str] = mapped_column(String(5))  # in | out
    kind: Mapped[str] = mapped_column(String(30))  # order | refund | cancel | stock | fulfillment | products
    external_id: Mapped[str | None] = mapped_column(String(60), index=True)
    status: Mapped[str] = mapped_column(String(10), index=True)  # ok | error | skipped
    message: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict | None] = mapped_column(JSONB)
    attempts: Mapped[int] = mapped_column(default=1)
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)


class ProcessedWebhook(Base):
    __tablename__ = "processed_webhooks"
    webhook_id: Mapped[str] = mapped_column(String(80), primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# ---------- settings & client ----------

def fernet():
    from cryptography.fernet import Fernet  # imported on use: most requests never touch Shopify

    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(settings.secret_key.encode()).digest()))


def get_setting(db: Session) -> IntegrationSetting:
    s = db.get(IntegrationSetting, "shopify")
    if s is None:
        s = IntegrationSetting(name="shopify", enabled=False, config={})
        db.add(s)
        db.flush()
    return s


def secrets_of(s: IntegrationSetting) -> dict:
    return json.loads(fernet().decrypt(s.secret.encode())) if s.secret else {}


# An httpx transport; tests replace it to talk to a fake Shopify.
transport = None


def client(db: Session) -> "httpx.Client":  # noqa: F821  (httpx is imported on use)
    import httpx

    s = get_setting(db)
    sec = secrets_of(s)
    if not s.config.get("shop_domain") or not sec.get("access_token"):
        raise AppError(422, "shopify_not_configured", "Shopify isn't connected yet")
    return httpx.Client(base_url=f"https://{s.config['shop_domain']}/admin/api/{API_VERSION}",
                        headers={"X-Shopify-Access-Token": sec["access_token"]}, timeout=30, transport=transport)


def log_sync(db: Session, direction: str, kind: str, external_id, status: str, message: str | None = None,
             payload: dict | None = None) -> SyncLog:
    entry = SyncLog(direction=direction, kind=kind, external_id=str(external_id) if external_id else None,
                    status=status, message=message, payload=payload)
    db.add(entry)
    db.flush()
    return entry


# ---------- products ----------

def pull_products(db: Session) -> dict:
    """Fetch all Shopify variants; auto-map new ones to products with the same SKU."""
    url, n, mapped = "/products.json?limit=250&fields=id,title,variants", 0, 0
    with client(db) as c:
        while url:
            r = c.get(url)
            r.raise_for_status()
            for p in r.json()["products"]:
                for v in p["variants"]:
                    n += 1
                    row = db.get(ShopifyVariant, str(v["id"]))
                    if row is None:
                        row = ShopifyVariant(variant_id=str(v["id"]), shopify_product_id=str(p["id"]), title="")
                        db.add(row)
                    row.title = p["title"] if v.get("title") in (None, "Default Title") else f"{p['title']} / {v['title']}"
                    row.sku = v.get("sku") or None
                    row.inventory_item_id = str(v.get("inventory_item_id") or "") or None
                    if row.product_id is None and row.sku:
                        row.product_id = db.scalar(select(Product.id).where(Product.sku == row.sku))
                        mapped += row.product_id is not None
            nxt = r.links.get("next", {}).get("url")
            url = nxt.split(f"/admin/api/{API_VERSION}", 1)[1] if nxt else None
    log_sync(db, "in", "products", None, "ok", f"{n} variants, {mapped} newly mapped by SKU")
    return {"variants": n, "newly_mapped": mapped}


# ---------- orders ----------

def find_or_create_customer(db: Session, o: dict) -> Customer | None:
    sc = o.get("customer") or {}
    sid = str(sc["id"]) if sc.get("id") else None
    email = (sc.get("email") or o.get("email") or "").lower() or None
    phone = clean_phone(sc.get("phone") or o.get("phone") or (o.get("shipping_address") or {}).get("phone"))
    c = db.scalar(select(Customer).where(Customer.shopify_id == sid)) if sid else None
    if c is None and email:
        c = db.scalar(select(Customer).where(Customer.email == email))
    if c is None and phone:
        c = db.scalar(select(Customer).where(Customer.phone == phone))
    if c is None:
        name = " ".join(x for x in (sc.get("first_name"), sc.get("last_name")) if x) or \
            (o.get("shipping_address") or {}).get("name") or email or phone
        if not name:
            return None
        c = Customer(name=name, email=email, phone=phone, type="retail", source="shopify", tags=["shopify"],
                     shopify_id=sid, marketing_opt_in=bool(sc.get("accepts_marketing")))
        db.add(c)
        db.flush()
        a = o.get("shipping_address")
        if a and a.get("address1"):
            db.add(CustomerAddress(customer_id=c.id, line1=a["address1"], line2=a.get("address2"),
                                   city=a.get("city") or "", postal_code=a.get("zip"), phone=clean_phone(a.get("phone")),
                                   is_default_shipping=True, is_default_billing=True))
    elif sid and not c.shopify_id:
        c.shopify_id = sid
    return c


def address(a: dict | None) -> dict | None:
    if not a:
        return None
    return {"label": a.get("name"), "line1": a.get("address1") or "", "line2": a.get("address2"),
            "area": a.get("province"), "city": a.get("city") or "", "postal_code": a.get("zip"),
            "phone": clean_phone(a.get("phone"))}


def import_order(db: Session, o: dict) -> Order:
    """Create (or return) the order for a Shopify order payload. Raises AppError for unmapped products."""
    ext = str(o["id"])
    existing = db.scalar(select(Order).where(Order.source == "shopify", Order.external_id == ext))
    if existing:
        return existing
    lines, calcs = [], []
    for li in o.get("line_items", []):
        v = db.get(ShopifyVariant, str(li.get("variant_id"))) if li.get("variant_id") else None
        pid = v.product_id if v else db.scalar(select(Product.id).where(Product.sku == li.get("sku"))) if li.get(
            "sku") else None
        if pid is None:
            raise AppError(422, "unmapped_product", f"Shopify item '{li.get('title')}' (SKU {li.get('sku')}) isn't "
                                                    f"mapped to a product")
        p = db.get(Product, pid)
        qty = Decimal(li["quantity"])
        disc = sum((Decimal(d["amount"]) for d in li.get("discount_allocations", [])), ZERO)
        calcs.append(LineCalc(quantity=qty, unit_price=Decimal(li["price"]), tax_rate=tax_rate_of(db, p),
                              discount_amount=disc))
        lines.append((p, li.get("title") or p.name))
    shipping = sum((Decimal(s["price"]) for s in o.get("shipping_lines", [])), ZERO)
    t = calculate(calcs, delivery_charge=shipping)
    c = find_or_create_customer(db, o)
    gateways = [g.lower() for g in o.get("payment_gateway_names") or []]
    cod = any("cash on delivery" in g or "cod" == g for g in gateways)
    order = Order(number=next_number(db, "order"), order_date=local_today(), source="shopify", external_id=ext,
                  channel="shopify", order_type="retail", status="draft", customer_id=c.id if c else None,
                  customer_name=c.name if c else None, customer_phone=c.phone if c else None,
                  shipping_address=address(o.get("shipping_address")), billing_address=address(o.get("billing_address")),
                  payment_method="cod" if cod else "online", notes=o.get("note"),
                  external_data={"shopify_name": o.get("name"), "total_price": o.get("total_price"),
                                 "financial_status": o.get("financial_status"), "gateways": gateways,
                                 "landing_site": o.get("landing_site")},
                  **{f: getattr(t, f) for f in ("subtotal", "discount_total", "tax_total", "net_total",
                                                "delivery_charge", "rounding", "grand_total")})
    db.add(order)
    db.flush()
    for i, ((p, title), lc) in enumerate(zip(lines, t.lines), start=1):
        db.add(OrderLine(order_id=order.id, line_no=i, product_id=p.id, sku=p.sku, description=title,
                         quantity=lc.quantity, unit_price=lc.unit_price, list_price=None, price_overridden=False,
                         discount_amount=lc.discount_amount, line_discount=lc.line_discount,
                         order_discount_share=lc.order_discount_share, tax_rate=lc.tax_rate, tax_amount=lc.tax,
                         net_amount=lc.net, line_total=lc.total))
    db.add(OrderStatusHistory(order_id=order.id, to_status="draft", note=f"Shopify {o.get('name')}"))
    db.info["source"] = "integration"
    audit(db, "create", order, note=f"Shopify {o.get('name')}")
    if o.get("total_price") and money(Decimal(o["total_price"])) != order.grand_total:
        log_sync(db, "in", "order", ext, "ok", f"Total differs: Shopify {o['total_price']} vs {order.grand_total}")
    if not o.get("cancelled_at"):
        change_status(db, order, "confirmed", "Imported from Shopify")
        if o.get("financial_status") == "paid":
            db.add(Payment(number=next_number(db, "payment"), customer_id=order.customer_id, order_id=order.id,
                           payment_date=local_today(), method="online", amount=order.grand_total,
                           reference=o.get("name"), note="Shopify"))
            refresh_payment_status(db, order)
    return order


def handle(db: Session, topic: str, payload: dict) -> str:
    """Apply one Shopify event. Used by webhooks, polling and retries."""
    ext = str(payload.get("id") or payload.get("order_id"))
    if topic in ("orders/create", "orders/paid", "orders/updated"):
        o = import_order(db, payload)
        if payload.get("cancelled_at") and o.status not in ("cancelled", "dispatched", "delivered"):
            change_status(db, o, "cancelled", payload.get("cancel_reason") or "Cancelled in Shopify")
        elif payload.get("financial_status") == "paid" and o.paid_total < o.grand_total:
            db.add(Payment(number=next_number(db, "payment"), customer_id=o.customer_id, order_id=o.id,
                           payment_date=local_today(), method="online", amount=o.grand_total - o.paid_total,
                           reference=payload.get("name"), note="Shopify"))
            refresh_payment_status(db, o)
        return o.number
    if topic == "orders/cancelled":
        o = db.scalar(select(Order).where(Order.source == "shopify", Order.external_id == ext))
        if o and o.status not in ("cancelled", "dispatched", "delivered"):
            change_status(db, o, "cancelled", payload.get("cancel_reason") or "Cancelled in Shopify")
        return o.number if o else "not found"
    if topic == "refunds/create":
        o = db.scalar(select(Order).where(Order.source == "shopify", Order.external_id == str(payload["order_id"])))
        if o is None:
            raise AppError(404, "not_found", "Refund for an order that isn't imported")
        amount = sum((Decimal(t["amount"]) for t in payload.get("transactions", [])
                      if t.get("kind") == "refund" and t.get("status") == "success"), ZERO)
        if amount:
            db.add(Payment(number=next_number(db, "payment"), kind="refund", customer_id=o.customer_id, order_id=o.id,
                           payment_date=local_today(), method="online", amount=min(amount, o.paid_total) or amount,
                           reference=str(payload["id"]), note="Shopify refund"))
            refresh_payment_status(db, o)
        return o.number
    return "ignored"


def process(db: Session, topic: str, payload: dict, existing_log: SyncLog | None = None) -> SyncLog:
    kind = topic.split("/")[0].rstrip("s") if topic.startswith(("orders", "refunds")) else topic
    ext = payload.get("id")
    try:
        with db.begin_nested():
            msg = handle(db, topic, payload)
        if existing_log:
            existing_log.status, existing_log.message, existing_log.resolved = "ok", msg, True
            existing_log.attempts += 1
            return existing_log
        return log_sync(db, "in", kind, ext, "ok", msg)
    except (AppError, KeyError, ValueError) as e:
        msg = e.message if isinstance(e, AppError) else f"Bad payload: {e}"
        if existing_log:
            existing_log.message, existing_log.attempts = msg, existing_log.attempts + 1
            return existing_log
        return log_sync(db, "in", kind, ext, "error", msg, {"topic": topic, "data": payload})


def verify_hmac(secret: str, body: bytes, header: str | None) -> bool:
    digest = base64.b64encode(hmac.new(secret.encode(), body, hashlib.sha256).digest()).decode()
    return bool(header) and hmac.compare_digest(digest, header)


def poll_orders(db: Session) -> str:
    """Fallback for missed webhooks: import orders updated since the last poll."""
    s = get_setting(db)
    if not s.enabled:
        return "disabled"
    since = (s.last_order_sync_at or utcnow()).isoformat()
    started = utcnow()
    n = 0
    with client(db) as c:
        r = c.get(f"/orders.json?status=any&limit=250&updated_at_min={since}")
        r.raise_for_status()
        for o in r.json()["orders"]:
            topic = "orders/cancelled" if o.get("cancelled_at") else "orders/updated"
            process(db, topic, o)
            n += 1
    s.last_order_sync_at = started
    return f"{n} orders checked"


# ---------- stock & fulfilment ----------

def push_stock(db: Session) -> str:
    """Send available stock for mapped variants whose quantity changed since the last push."""
    s = get_setting(db)
    if not s.enabled or not s.config.get("sync_stock"):
        return "disabled"
    loc, wh = s.config.get("location_id"), s.config.get("warehouse_id")
    if not loc or not wh:
        return "location/warehouse not set"
    n = 0
    with client(db) as c:
        for v in db.scalars(select(ShopifyVariant).where(ShopifyVariant.product_id.is_not(None),
                                                         ShopifyVariant.inventory_item_id.is_not(None))):
            qty = max(available(db, v.product_id, wh), ZERO).to_integral_value(rounding="ROUND_FLOOR")
            if v.last_pushed_qty is not None and v.last_pushed_qty == qty:
                continue
            r = c.post("/inventory_levels/set.json", json={"location_id": int(loc),
                                                           "inventory_item_id": int(v.inventory_item_id),
                                                           "available": int(qty)})
            if r.is_success:
                v.last_pushed_qty = qty
                n += 1
            else:
                log_sync(db, "out", "stock", v.variant_id, "error", f"{r.status_code}: {r.text[:300]}")
    return f"{n} stock levels pushed"


def push_fulfilments(db: Session) -> str:
    """Tell Shopify about dispatched orders (with courier and tracking)."""
    import httpx

    if not get_setting(db).enabled:
        return "disabled"
    n = 0
    orders = db.scalars(select(Order).where(Order.source == "shopify", Order.status.in_(("dispatched", "delivered")))
                        ).all()
    todo = [o for o in orders if not (o.external_data or {}).get("fulfilled")]
    if not todo:
        return "nothing to fulfil"
    with client(db) as c:
        for o in todo:
            try:
                r = c.get(f"/orders/{o.external_id}/fulfillment_orders.json")
                r.raise_for_status()
                fos = [{"fulfillment_order_id": fo["id"]} for fo in r.json()["fulfillment_orders"]
                       if fo.get("status") in ("open", "in_progress")]
                if fos:
                    body = {"fulfillment": {"line_items_by_fulfillment_order": fos, "notify_customer": True,
                                            "tracking_info": {"company": o.courier, "number": o.tracking_number}}}
                    c.post("/fulfillments.json", json=body).raise_for_status()
                o.external_data = {**(o.external_data or {}), "fulfilled": True}
                log_sync(db, "out", "fulfillment", o.external_id, "ok", o.number)
                n += 1
            except httpx.HTTPError as e:
                log_sync(db, "out", "fulfillment", o.external_id, "error", str(e)[:300])
    return f"{n} fulfilments sent"


# ---------- API ----------

router = APIRouter(prefix="/integrations/shopify", tags=["integrations"])
SETTINGS_EDIT = require_access("settings", "edit")
SETTINGS_VIEW = require_access("settings", "view")


class ShopifyConfigIn(BaseModel):
    enabled: bool | None = None
    shop_domain: str | None = None  # mystore.myshopify.com
    access_token: str | None = None  # write-only
    webhook_secret: str | None = None  # write-only
    location_id: str | None = None
    warehouse_id: int | None = None
    sync_stock: bool | None = None


def config_out(s: IntegrationSetting) -> dict:
    sec = secrets_of(s)
    return {"enabled": s.enabled, **s.config, "has_access_token": bool(sec.get("access_token")),
            "has_webhook_secret": bool(sec.get("webhook_secret")), "last_order_sync_at": s.last_order_sync_at,
            "webhook_url": "/api/integrations/shopify/webhooks"}


@router.get("/config")
def get_config(db: DB, _: User = SETTINGS_VIEW):
    return config_out(get_setting(db))


@router.put("/config")
def put_config(body: ShopifyConfigIn, db: DB, _: User = SETTINGS_EDIT):
    s = get_setting(db)
    data = body.model_dump(exclude_unset=True)
    sec = secrets_of(s)
    for k in ("access_token", "webhook_secret"):
        if k in data:
            sec[k] = data.pop(k)
    if "enabled" in data:
        s.enabled = data.pop("enabled")
    s.config = {**s.config, **data}
    s.secret = fernet().encrypt(json.dumps(sec).encode()).decode()
    audit(db, "update", entity_type="integration_settings", note="shopify",
          after={k: v for k, v in data.items()} | {"secrets_changed": bool(body.access_token or body.webhook_secret)})
    return config_out(s)


@router.post("/pull-products")
def pull(db: DB, _: User = SETTINGS_EDIT):
    return pull_products(db)


class VariantOut(BaseModel):
    model_config = {"from_attributes": True}
    variant_id: str
    shopify_product_id: str
    title: str
    sku: str | None
    product_id: int | None
    last_pushed_qty: Decimal | None


@router.get("/variants", response_model=list[VariantOut])
def variants(db: DB, unmapped_only: bool = False, _: User = SETTINGS_VIEW):
    q = select(ShopifyVariant).order_by(ShopifyVariant.title)
    if unmapped_only:
        q = q.where(ShopifyVariant.product_id.is_(None))
    return db.scalars(q).all()


class MapIn(BaseModel):
    product_id: int | None


@router.put("/variants/{variant_id}", response_model=VariantOut)
def map_variant(variant_id: str, body: MapIn, db: DB, _: User = SETTINGS_EDIT):
    v = db.get(ShopifyVariant, variant_id)
    if v is None:
        raise not_found("Shopify variant")
    if body.product_id and db.get(Product, body.product_id) is None:
        raise not_found("Product")
    v.product_id, v.last_pushed_qty = body.product_id, None
    audit(db, "update", entity_type="integration_settings", note=f"map variant {variant_id} -> {body.product_id}")
    return v


@router.post("/webhooks")
async def webhook(request: Request, db: DB):
    """Shopify calls this. Verified by HMAC; each webhook id is processed once."""
    body = await request.body()
    s = get_setting(db)
    secret = secrets_of(s).get("webhook_secret")
    if not secret or not verify_hmac(secret, body, request.headers.get("x-shopify-hmac-sha256")):
        return JSONResponse({"code": "invalid_signature", "message": "Bad signature", "fields": {}}, 401)
    wid = request.headers.get("x-shopify-webhook-id")
    if wid:
        inserted = db.execute(insert(ProcessedWebhook).values(webhook_id=wid).on_conflict_do_nothing()
                              .returning(ProcessedWebhook.webhook_id)).scalar()
        if inserted is None:
            return {"status": "duplicate"}
    process(db, request.headers.get("x-shopify-topic", ""), json.loads(body))
    return {"status": "ok"}  # always 200 once verified: failures are in the sync log, Shopify mustn't retry forever


class SyncOut(BaseModel):
    model_config = {"from_attributes": True}
    id: int
    at: datetime
    direction: str
    kind: str
    external_id: str | None
    status: str
    message: str | None
    attempts: int
    resolved: bool


sync_router = APIRouter(prefix="/integrations/sync-log", tags=["integrations"])


@sync_router.get("", response_model=Page[SyncOut])
def sync_log(db: DB, p: Annotated[ListParams, Depends()], status: str | None = None, kind: str | None = None,
             unresolved_errors: bool = False, _: User = SETTINGS_VIEW):
    q = apply_filters(select(SyncLog), SyncLog, p, (SyncLog.message, SyncLog.external_id), {})
    if status:
        q = q.where(SyncLog.status == status)
    if kind:
        q = q.where(SyncLog.kind == kind)
    if unresolved_errors:
        q = q.where(SyncLog.status == "error", SyncLog.resolved.is_(False))
    return paginate(db, q, p, SyncOut)


@sync_router.post("/{log_id}/retry", response_model=SyncOut)
def retry(log_id: int, db: DB, _: User = SETTINGS_EDIT):
    entry = db.get(SyncLog, log_id)
    if entry is None or entry.status != "error" or not entry.payload:
        raise AppError(422, "not_retryable", "Only failed incoming events can be retried")
    return process(db, entry.payload["topic"], entry.payload["data"], existing_log=entry)


@router.get("/reconciliation")
def reconciliation(db: DB, date_from: str | None = None, _: User = require_access("orders", "view")):
    """Shopify orders whose Shopify total differs from ours, or that are paid in Shopify but not here."""
    q = select(Order).where(Order.source == "shopify")
    if date_from:
        q = q.where(Order.order_date >= date_from)
    rows = []
    for o in db.scalars(q):
        ext = o.external_data or {}
        shop_total = money(Decimal(ext["total_price"])) if ext.get("total_price") else None
        issues = []
        if shop_total is not None and shop_total != o.grand_total:
            issues.append(f"total {shop_total} vs {o.grand_total}")
        if ext.get("financial_status") == "paid" and o.payment_status != "paid":
            issues.append("paid in Shopify, not here")
        if issues:
            rows.append({"order_id": o.id, "number": o.number, "shopify": ext.get("shopify_name"), "issues": issues})
    return rows


routers = [router, sync_router]
