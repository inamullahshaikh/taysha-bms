import pytest
from sqlalchemy import select

from app.clock import local_today
from app.wholesale import RecurringOrder, advance, run_due_recurring
from tests.conftest import login
from tests.test_inventory import receive
from tests.test_products import make_product, price_list


@pytest.fixture
def ws(owner_client):
    c = owner_client
    wh = c.post("/warehouses", json={"code": "MAIN", "name": "Main"}).json()["id"]
    p = make_product(c, "MUG-1", name="Mug cake")
    p2 = make_product(c, "MUG-2", name="Brownie")
    for prod in (p, p2):
        c.post(f"/products/{prod['id']}/prices", json={"price_list_id": price_list(c, "wholesale"), "price": "900"})
    receive(c, wh, p["id"], 100, batch="B1")
    cafe = c.post("/customers", json={"name": "Beans Cafe", "type": "cafe", "credit_limit": "10000",
                                      "payment_terms_days": 30}).json()
    return {"c": c, "wh": wh, "p": p, "p2": p2, "cafe": cafe}


def body(s, qty="10", pid=None, **kw):
    return {"customer_id": s["cafe"]["id"], "order_type": "wholesale", "payment_method": "bank_transfer",
            "lines": [{"product_id": pid or s["p"]["id"], "quantity": qty}], **kw}


def test_customer_price_list_with_fallback_and_moq(ws):
    c = ws["c"]
    pl = c.post(f"/customers/{ws['cafe']['id']}/price-list").json()
    c.post(f"/products/{ws['p']['id']}/prices", json={"price_list_id": pl["price_list_id"], "price": "850"})
    o = c.post("/orders/preview", json=body(ws)).json()
    assert o["lines"][0]["unit_price"] == "850.00"  # their own price
    o2 = c.post("/orders/preview", json=body(ws, pid=ws["p2"]["id"])).json()
    assert o2["lines"][0]["unit_price"] == "900.00"  # falls back to the wholesale list
    c.put(f"/customers/{ws['cafe']['id']}/terms", json=[{"product_id": ws["p"]["id"], "min_order_qty": "12"}])
    r = c.post("/orders/preview", json=body(ws, qty="10"))
    assert r.status_code == 422 and r.json()["code"] == "below_moq"


def test_credit_limit_blocks_confirm_for_non_owner(ws, client, make_user):
    c = ws["c"]
    c.post("/orders", json=body(ws, qty="10", confirm=True))  # 9000 owed; owner may confirm
    c.post("/auth/logout")
    make_user("sales@example.com", access=("orders.view", "orders.create", "orders.edit", "customers.view"))
    login(client, "sales@example.com")
    o = client.post("/orders", json=body(ws, qty="2")).json()  # +1800 -> over 10000
    r = client.post(f"/orders/{o['id']}/status", json={"status": "confirmed"})
    assert r.status_code == 409 and r.json()["code"] == "credit_limit_exceeded"


def test_recurring_orders(ws, db):
    c = ws["c"]
    rec = c.post("/recurring-orders", json={
        "customer_id": ws["cafe"]["id"], "name": "Weekly cafe stock", "frequency": "weekly",
        "next_date": str(local_today()), "auto_confirm": True,
        "template": {"order_type": "wholesale", "payment_method": "bank_transfer",
                     "lines": [{"product_id": ws["p"]["id"], "quantity": "5"}]}}).json()
    assert rec["template"]["lines"][0]["quantity"] == "5"
    assert run_due_recurring(db) == "1 recurring orders created"
    assert run_due_recurring(db) == "0 recurring orders created"  # next one is next week
    r = db.scalar(select(RecurringOrder))
    o = c.get(f"/orders/{r.last_order_id}").json()
    assert o["status"] == "confirmed" and o["customer_id"] == ws["cafe"]["id"]


def test_monthly_advance_clamps():
    from datetime import date

    assert advance(date(2026, 1, 31), "monthly") == date(2026, 2, 28)
    assert advance(date(2026, 12, 15), "monthly") == date(2027, 1, 15)


def test_delivery_route_with_cod_and_reports(ws):
    c = ws["c"]
    o1 = c.post("/orders", json=body(ws, qty="2", payment_method="cod", confirm=True)).json()
    o2 = c.post("/orders", json=body(ws, qty="1", payment_method="cod", confirm=True)).json()
    route = c.post("/routes", json={"driver_name": "Imran", "order_ids": [o1["id"], o2["id"]]}).json()
    route = c.post(f"/routes/{route['id']}/start").json()
    assert c.get(f"/orders/{o1['id']}").json()["status"] == "dispatched"
    s1, s2 = route["stops"]
    assert s1["cod_due"] == "1800.00"
    route = c.post(f"/routes/{route['id']}/stops/{s1['id']}/deliver",
                   json={"recipient_name": "Manager", "cod_collected": "1800"}).json()
    assert c.get(f"/orders/{o1['id']}").json()["payment_status"] == "paid"
    assert c.post(f"/routes/{route['id']}/complete").status_code == 409
    c.post(f"/routes/{route['id']}/stops/{s2['id']}/fail", json={"reason": "Shop closed"})
    done = c.post(f"/routes/{route['id']}/complete").json()
    assert done["status"] == "completed" and done["cod_total"] == "1800.00"
    t = c.post("/territories", json={"name": "Lahore North"}).json()
    c.patch(f"/customers/{ws['cafe']['id']}", json={"territory_id": t["id"]})
    rep = c.get("/reports/sales?group_by=territory&range=year").json()["rows"]
    assert rep[0]["label"] == t["id"] and rep[0]["orders"] == 2
    c.post("/sell-through", json={"customer_id": ws["cafe"]["id"], "product_id": ws["p"]["id"],
                                  "period_start": str(local_today().replace(day=1)), "period_end": str(local_today()),
                                  "sold": "2"})
    st = c.get(f"/reports/sell-through?customer_id={ws['cafe']['id']}").json()["rows"]
    assert st[0]["sell_in"] == "3.000" and st[0]["sell_through_pct"] == "66.7"
