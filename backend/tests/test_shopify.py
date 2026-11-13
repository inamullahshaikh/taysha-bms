import base64
import hashlib
import hmac
import json

import httpx
import pytest

from app.integrations import shopify
from tests.test_inventory import bal, inv, receive  # noqa: F401

SECRET = "whsec"


class FakeShopify:
    """Minimal in-memory Shopify Admin API."""

    def __init__(self):
        self.stock, self.fulfilments, self.orders = {}, [], []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.split(f"/admin/api/{shopify.API_VERSION}")[1]
        if path == "/products.json":
            return httpx.Response(200, json={"products": [{"id": 1, "title": "Mug cake", "variants": [
                {"id": 11, "title": "Default Title", "sku": "MUG-1", "inventory_item_id": 111},
                {"id": 12, "title": "Big", "sku": "UNKNOWN", "inventory_item_id": 112}]}]})
        if path == "/inventory_levels/set.json":
            body = json.loads(request.content)
            self.stock[body["inventory_item_id"]] = body["available"]
            return httpx.Response(200, json={})
        if path.endswith("/fulfillment_orders.json"):
            return httpx.Response(200, json={"fulfillment_orders": [{"id": 900, "status": "open"}]})
        if path == "/fulfillments.json":
            self.fulfilments.append(json.loads(request.content))
            return httpx.Response(201, json={})
        if path == "/orders.json":
            return httpx.Response(200, json={"orders": self.orders})
        return httpx.Response(404)


@pytest.fixture
def shop(inv, monkeypatch):  # noqa: F811
    fake = FakeShopify()
    monkeypatch.setattr(shopify, "transport", httpx.MockTransport(fake))
    c = inv["c"]
    c.put("/integrations/shopify/config", json={"enabled": True, "shop_domain": "taysha.myshopify.com",
                                                "access_token": "shpat_x", "webhook_secret": SECRET,
                                                "location_id": "555", "warehouse_id": inv["wh"], "sync_stock": True})
    return {**inv, "fake": fake}


def order_payload(oid=5001, sku="MUG-1", qty=2, financial="paid", gateway="shopify_payments", **kw):
    return {"id": oid, "name": f"#{oid}", "email": "Zara@Example.com", "financial_status": financial,
            "payment_gateway_names": [gateway], "total_price": "2510.00",
            "customer": {"id": 77, "first_name": "Zara", "last_name": "Ali", "phone": "+92 300 1112233"},
            "shipping_address": {"name": "Zara Ali", "address1": "12 Main Blvd", "city": "Lahore", "phone": "03001112233"},
            "line_items": [{"variant_id": 11, "sku": sku, "title": "Mug cake", "quantity": qty, "price": "1180.00",
                            "discount_allocations": []}],
            "shipping_lines": [{"price": "150.00"}], **kw}


def send_webhook(c, topic, payload, webhook_id="w1", secret=SECRET):
    body = json.dumps(payload).encode()
    sig = base64.b64encode(hmac.new(secret.encode(), body, hashlib.sha256).digest()).decode()
    return c.post("/integrations/shopify/webhooks", content=body,
                  headers={"X-Shopify-Hmac-Sha256": sig, "X-Shopify-Topic": topic, "X-Shopify-Webhook-Id": webhook_id,
                           "Content-Type": "application/json"})


def test_config_hides_secrets_and_maps_by_sku(shop):
    c = shop["c"]
    cfg = c.get("/integrations/shopify/config").json()
    assert cfg["has_access_token"] and "access_token" not in cfg
    assert c.post("/integrations/shopify/pull-products").json() == {"variants": 2, "newly_mapped": 1}
    assert [v["sku"] for v in c.get("/integrations/shopify/variants?unmapped_only=true").json()] == ["UNKNOWN"]


def test_webhook_import_is_verified_and_idempotent(shop, db):
    c = shop["c"]
    receive(c, shop["wh"], shop["product"]["id"], 10, batch="B1")
    c.post("/integrations/shopify/pull-products")
    assert send_webhook(c, "orders/create", order_payload(), secret="wrong").status_code == 401
    assert send_webhook(c, "orders/create", order_payload()).json() == {"status": "ok"}
    assert send_webhook(c, "orders/create", order_payload()).json() == {"status": "duplicate"}  # same webhook id
    send_webhook(c, "orders/updated", order_payload(), webhook_id="w2")  # same order, new event: no new order
    orders = c.get("/orders?source=shopify").json()
    assert orders["total"] == 1
    o = c.get(f"/orders/{orders['items'][0]['id']}").json()
    assert o["status"] == "confirmed" and o["payment_status"] == "paid" and o["grand_total"] == "2510.00"
    assert o["customer_name"] == "Zara Ali"
    assert bal(c, shop["product"]["id"], shop["wh"])["reserved"] == "2.000"
    cust = c.get(f"/customers/{o['customer_id']}").json()
    assert cust["email"] == "zara@example.com" and "shopify" in cust["tags"]


def test_unmapped_product_goes_to_sync_log_and_retries(shop, db):
    c = shop["c"]
    payload = order_payload(oid=6001)
    payload["line_items"] = [{"variant_id": 999, "sku": "NOPE", "title": "Mystery", "quantity": 1, "price": "100",
                              "discount_allocations": []}]
    send_webhook(c, "orders/create", payload)
    errs = c.get("/integrations/sync-log?unresolved_errors=true").json()["items"]
    assert len(errs) == 1 and "isn't mapped" in errs[0]["message"]
    assert c.get("/orders?source=shopify").json()["total"] == 0
    db.add(shopify.ShopifyVariant(variant_id="999", shopify_product_id="9", title="Mystery",
                                  product_id=shop["product"]["id"]))  # someone maps it
    db.flush()
    r = c.post(f"/integrations/sync-log/{errs[0]['id']}/retry").json()
    assert r["status"] == "ok" and r["resolved"] and r["attempts"] == 2
    assert c.get("/orders?source=shopify").json()["total"] == 1


def test_stock_push_fulfilment_and_cod(shop, db):
    c, fake = shop["c"], shop["fake"]
    receive(c, shop["wh"], shop["product"]["id"], 10, batch="B1")
    c.post("/integrations/shopify/pull-products")
    send_webhook(c, "orders/create", order_payload(oid=7001, financial="pending", gateway="Cash on Delivery (COD)"))
    o = c.get("/orders?source=shopify").json()["items"][0]
    assert o["payment_status"] == "cod_pending"
    assert shopify.push_stock(db) == "1 stock levels pushed" and fake.stock[111] == 8  # 10 on hand - 2 reserved
    assert shopify.push_stock(db) == "0 stock levels pushed"  # unchanged
    c.patch(f"/orders/{o['id']}/delivery", json={"courier": "TCS", "tracking_number": "T1"})
    c.post(f"/orders/{o['id']}/status", json={"status": "dispatched"})
    assert shopify.push_fulfilments(db) == "1 fulfilments sent"
    assert fake.fulfilments[0]["fulfillment"]["tracking_info"] == {"company": "TCS", "number": "T1"}
    assert shopify.push_fulfilments(db) == "nothing to fulfil"


def test_cancel_and_refund_webhooks(shop):
    c = shop["c"]
    c.post("/integrations/shopify/pull-products")
    send_webhook(c, "orders/create", order_payload(oid=8001))
    o = c.get("/orders?source=shopify").json()["items"][0]
    send_webhook(c, "refunds/create", {"id": 1, "order_id": 8001, "transactions": [
        {"kind": "refund", "status": "success", "amount": "500.00"}]}, webhook_id="r1")
    assert c.get(f"/orders/{o['id']}").json()["payment_status"] == "partially_paid"
    send_webhook(c, "orders/cancelled", {"id": 8001, "cancel_reason": "customer"}, webhook_id="c1")
    assert c.get(f"/orders/{o['id']}").json()["status"] == "cancelled"
