import uuid

import pytest

from tests.test_inventory import bal, receive
from tests.test_products import make_product, price_list

pytestmark = pytest.mark.usefixtures("approvals_required")  # these tests cover the approval workflow


@pytest.fixture
def stall(owner_client):
    c = owner_client
    wh = c.post("/warehouses", json={"code": "STALL", "name": "Stall stock"}).json()["id"]
    p = make_product(c, "MUG-1", name="Mug cake")
    c.post(f"/products/{p['id']}/prices", json={"price_list_id": price_list(c), "price": "500"})
    receive(c, wh, p["id"], 20, cost=200, batch="B1")
    ev = c.post("/pos/events", json={"name": "Packages Mall pop-up", "warehouse_id": wh,
                                     "start_date": "2026-11-14"}).json()
    c.post(f"/pos/events/{ev['id']}/open")
    c.put(f"/pos/events/{ev['id']}/counts/opening", json=[{"product_id": p["id"], "quantity": "20"}])
    sess = c.post("/pos/sessions", json={"event_id": ev["id"], "opening_cash": "1000"}).json()
    return {"c": c, "wh": wh, "p": p, "ev": ev, "sess": sess}


def sale(s, qty="3", payments=None, client_id=None, **kw):
    return {"client_id": client_id or str(uuid.uuid4()), "session_id": s["sess"]["id"],
            "lines": [{"product_id": s["p"]["id"], "quantity": qty}],
            "payments": payments or [{"method": "cash", "amount": "2000"}], **kw}


def test_sale_change_stock_and_idempotency(stall):
    c = stall["c"]
    body = sale(stall)
    r = c.post("/pos/sales", json=body).json()
    assert r["grand_total"] == "1500.00" and r["change"] == "500.00" and not r["duplicate"]
    again = c.post("/pos/sales", json=body).json()
    assert again["duplicate"] and again["order_id"] == r["order_id"]
    o = c.get(f"/orders/{r['order_id']}").json()
    assert o["status"] == "delivered" and o["payment_status"] == "paid" and o["paid_total"] == "1500.00"
    assert bal(c, stall["p"]["id"], stall["wh"])["on_hand"] == "17.000"
    assert c.get(f"/pos/sales/{r['order_id']}/receipt").content.startswith(b"%PDF")
    assert c.post("/pos/sales", json=sale(stall, payments=[{"method": "cash", "amount": "100"}])).status_code == 422
    assert c.post("/pos/sales", json=sale(stall, payments=[{"method": "card", "amount": "9999"}])).status_code == 422


def test_split_payment_offline_sync_and_session_close(stall):
    c = stall["c"]
    c.post("/pos/sales", json=sale(stall, qty="2", payments=[{"method": "card", "amount": "600"},
                                                             {"method": "cash", "amount": "500"}]))
    offline = [sale(stall, qty="1", sold_at="2026-11-14T15:00:00+05:00"),
               sale(stall, qty="999", sold_at="2026-11-14T15:05:00+05:00",
                    payments=[{"method": "cash", "amount": "500000"}])]
    res = c.post("/pos/sales/sync", json=offline).json()
    assert [r["ok"] for r in res] == [True, False] and res[1]["code"] in ("backordered", "insufficient_stock")
    closed = c.post(f"/pos/sessions/{stall['sess']['id']}/close", json={"counted_cash": "1890"}).json()
    # 1000 opening + 400 cash (2nd sale net of change: 500 - 100) + 500 offline sale (paid 2000, change 1500)
    assert closed["expected_cash"] == "1900.00" and closed["cash_variance"] == "-10.00"


def test_event_report_with_samples_expenses_and_counts(stall):
    c = stall["c"]
    c.post("/pos/sales", json=sale(stall, qty="4", payments=[{"method": "cash", "amount": "2000"}]))
    c.post("/pos/consumption", json={"event_id": stall["ev"]["id"], "reason": "sample",
                                     "lines": [{"product_id": stall["p"]["id"], "quantity": "1"}]})
    cat = c.post("/expense-categories", json={"name": "Stall rent"}).json()["id"]
    exp = c.post("/expenses", json={"category_id": cat, "description": "Stall rent", "amount": "1000",
                                    "event_id": stall["ev"]["id"]}).json()
    c.put(f"/pos/events/{stall['ev']['id']}/counts/closing", json=[{"product_id": stall["p"]["id"], "quantity": "14"}])
    rep = c.get(f"/pos/events/{stall['ev']['id']}/report").json()
    assert rep["sales"] == 1 and rep["revenue"] == "2000.00"
    recon = rep["stock_reconciliation"][0]
    assert recon["expected_closing"] == "15.000" and recon["variance"] == "-1.000"
    assert rep["consumption_cost"] == "200.00" and exp["status"] == "submitted"
    assert len(c.get(f"/pos/events/compare?ids={stall['ev']['id']}").json()) == 1
    assert c.post(f"/pos/events/{stall['ev']['id']}/close").status_code == 409  # session still open
