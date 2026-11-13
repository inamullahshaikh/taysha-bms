from decimal import Decimal

import pytest

from app.orders.calc import LineCalc, calculate
from tests.test_products import make_product, price_list

D = Decimal


def test_calc_tax_inclusive_discounts_rounding():
    lines = [LineCalc(quantity=D(2), unit_price=D("1180"), tax_rate=D(18)),
             LineCalc(quantity=D(1), unit_price=D("500"), tax_rate=D(0), discount_pct=D(10))]
    t = calculate(lines, order_discount_amount=D("286"), delivery_charge=D("199.50"))
    assert t.subtotal == D("2810.00")  # 2360 + 450
    assert lines[0].order_discount_share + lines[1].order_discount_share == D("286.00")
    assert t.tax_total == lines[0].tax  # zero-rated line adds no tax
    assert t.net_total + t.tax_total == t.subtotal - t.order_discount
    assert t.grand_total == D("2724.00") and t.rounding == D("0.50")  # 2524 + 199.50 = 2723.50 -> 2724


@pytest.fixture
def setup(owner_client):
    p = make_product(owner_client, "MUG-1", name="Mug cake")
    owner_client.post(f"/products/{p['id']}/prices", json={"price_list_id": price_list(owner_client), "price": "1180"})
    owner_client.post(f"/products/{p['id']}/prices", json={"price_list_id": price_list(owner_client, "wholesale"),
                                                            "price": "900"})
    owner_client.post(f"/products/{p['id']}/costs", json={"materials": "300"})
    cust = owner_client.post("/customers", json={"name": "Hina", "phone": "03001234567"}).json()
    owner_client.post(f"/customers/{cust['id']}/addresses",
                      json={"line1": "House 5", "city": "Lahore", "is_default_shipping": True})
    return {"c": owner_client, "product": p, "customer": cust}


def order_body(s, **kw):
    return {"customer_id": s["customer"]["id"], "channel": "direct",
            "lines": [{"product_id": s["product"]["id"], "quantity": "2"}], **kw}


def test_preview_equals_saved_and_snapshots(setup):
    c = setup["c"]
    prev = c.post("/orders/preview", json=order_body(setup, delivery_charge="150")).json()
    o = c.post("/orders", json=order_body(setup, delivery_charge="150")).json()
    assert prev["grand_total"] == o["grand_total"] == "2510.00"
    assert o["tax_total"] == "360.00" and o["number"].startswith("SO-")
    assert o["shipping_address"]["city"] == "Lahore" and o["customer_name"] == "Hina"
    assert o["lines"][0]["list_price"] == "1180.00" and not o["lines"][0]["price_overridden"]


def test_price_list_by_order_type(setup):
    o = setup["c"].post("/orders", json=order_body(setup, order_type="wholesale")).json()
    assert o["lines"][0]["unit_price"] == "900.00"


def test_status_flow_and_rules(setup):
    c = setup["c"]
    o = c.post("/orders", json=order_body(setup, confirm=True)).json()
    assert o["status"] == "confirmed"
    oid = o["id"]
    assert c.post(f"/orders/{oid}/status", json={"status": "dispatched"}).status_code == 422  # courier needed
    c.patch(f"/orders/{oid}/delivery", json={"courier": "TCS", "tracking_number": "TCS123"})
    assert c.post(f"/orders/{oid}/status", json={"status": "dispatched"}).json()["status"] == "dispatched"
    assert c.post(f"/orders/{oid}/status", json={"status": "draft"}).status_code == 409
    o = c.post(f"/orders/{oid}/status", json={"status": "delivered"}).json()
    assert [h["to_status"] for h in o["history"]] == ["draft", "confirmed", "dispatched", "delivered"]
    assert c.put(f"/orders/{oid}", json=order_body(setup)).status_code == 409  # not draft


def test_cancel_needs_reason(setup):
    c = setup["c"]
    oid = c.post("/orders", json=order_body(setup)).json()["id"]
    assert c.post(f"/orders/{oid}/status", json={"status": "cancelled"}).status_code == 422
    assert c.post(f"/orders/{oid}/status", json={"status": "cancelled", "note": "dup"}).json()["status"] == "cancelled"


def test_payments_drive_payment_status(setup):
    c = setup["c"]
    oid = c.post("/orders", json=order_body(setup, confirm=True)).json()["id"]  # total 2360
    pay = c.post(f"/orders/{oid}/payments", json={"method": "cash", "amount": "1000"})
    assert pay.status_code == 201
    assert c.get(f"/orders/{oid}").json()["payment_status"] == "partially_paid"
    assert c.post(f"/orders/{oid}/payments", json={"method": "cash", "amount": "5000"}).status_code == 422
    c.post(f"/orders/{oid}/payments", json={"method": "bank_transfer", "amount": "1360"})
    assert c.get(f"/orders/{oid}").json()["payment_status"] == "paid"
    c.post(f"/orders/{oid}/payments", json={"kind": "refund", "method": "cash", "amount": "2360"})
    assert c.get(f"/orders/{oid}").json()["payment_status"] == "refunded"


def test_cod_pending(setup):
    o = setup["c"].post("/orders", json=order_body(setup, payment_method="cod", confirm=True)).json()
    assert o["payment_status"] == "cod_pending"


def test_discount_codes(setup):
    c = setup["c"]
    c.post("/discount-codes", json={"code": "eid10", "kind": "percent", "value": "10", "max_uses": 1})
    o = c.post("/orders", json=order_body(setup, discount_code="EID10")).json()
    assert o["discount_total"] == "236.00" and o["grand_total"] == "2124.00"
    r = c.post("/orders", json=order_body(setup, discount_code="eid10"))
    assert r.status_code == 422 and r.json()["code"] == "discount_used_up"


def test_price_override_needs_permission(setup, client, make_user):
    setup["c"].post("/auth/logout")
    make_user("sales@example.com", access=("orders.view", "orders.create", "customers.view"))
    client.post("/auth/login", json={"email": "sales@example.com", "password": "password123"})
    body = order_body(setup)
    assert client.post("/orders", json=body).status_code == 201
    body["lines"][0]["unit_price"] = "1000"
    assert client.post("/orders", json=body).json()["code"] == "pricing_not_allowed"


def test_filters_and_customer_stats(setup):
    c = setup["c"]
    o1 = c.post("/orders", json=order_body(setup, confirm=True)).json()
    c.post("/orders", json=order_body(setup, order_type="wholesale", confirm=True))
    assert c.get(f"/orders?product_id={setup['product']['id']}").json()["total"] == 2
    assert c.get("/orders?order_type=wholesale").json()["total"] == 1
    assert c.get(f"/orders?q={o1['number']}").json()["total"] == 1
    stats = c.get(f"/customers/{setup['customer']['id']}/stats").json()
    assert stats["order_count"] == 2 and stats["total_spend"] == "4160.00" and stats["returning"]
    assert c.get("/orders/export?format=xlsx").status_code == 200


def test_walk_in_sample_order_is_free(setup):
    body = {"customer_name": "Walk-in", "order_type": "sample",
            "lines": [{"product_id": setup["product"]["id"], "quantity": "1"}]}
    o = setup["c"].post("/orders", json=body).json()
    assert o["grand_total"] == "0.00" and o["customer_id"] is None


def test_order_pdfs(setup):
    c = setup["c"]
    o1 = c.post("/orders", json=order_body(setup, payment_method="cod", confirm=True)).json()
    o2 = c.post("/orders", json=order_body(setup, confirm=True)).json()
    for doc in ("summary", "packing_slip"):
        r = c.get(f"/orders/{o1['id']}/pdf?doc={doc}")
        assert r.status_code == 200 and r.content.startswith(b"%PDF")
    r = c.get(f"/orders/dispatch-list?ids={o1['id']},{o2['id']}")
    assert r.headers["content-type"] == "application/pdf" and r.content.startswith(b"%PDF")
