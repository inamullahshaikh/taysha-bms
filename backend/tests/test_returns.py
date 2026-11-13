import pytest

from tests.test_inventory import bal, inv, receive  # noqa: F401
from tests.test_orders import order_body


@pytest.fixture
def shipped(inv):  # noqa: F811
    c, wh, pid = inv["c"], inv["wh"], inv["product"]["id"]
    receive(c, wh, pid, 10, cost=300, batch="B1")
    s = {"customer": inv["customer"], "product": inv["product"]}
    o = c.post("/orders", json={**order_body(s, confirm=True, delivery_method="pickup"),
                                "lines": [{"product_id": pid, "quantity": "3"}]}).json()
    c.post(f"/orders/{o['id']}/payments", json={"method": "cash", "amount": o["grand_total"]})
    o = c.post(f"/orders/{o['id']}/status", json={"status": "delivered"}).json()
    return {**inv, "order": o}


def start_return(c, o, qty="1", reason="damaged"):
    r = c.post(f"/returns/from-order/{o['id']}", json={"reason": reason, "lines": [
        {"order_line_id": o["lines"][0]["id"], "quantity": qty}]})
    assert r.status_code == 201, r.text
    return r.json()


def test_restock_and_refund(shipped):
    c, o, pid, wh = shipped["c"], shipped["order"], shipped["product"]["id"], shipped["wh"]
    assert bal(c, pid, wh)["on_hand"] == "7.000"
    r = start_return(c, o)
    assert c.post(f"/returns/from-order/{o['id']}", json={"reason": "other", "lines": [
        {"order_line_id": o["lines"][0]["id"], "quantity": "3"}]}).status_code == 422  # only 2 left to return
    line = r["lines"][0]["id"]
    c.post(f"/returns/{r['id']}/receive", json={"lines": [{"line_id": line, "condition": "unopened",
                                                           "disposition": "restock"}]})
    assert bal(c, pid, wh)["on_hand"] == "8.000"
    done = c.post(f"/returns/{r['id']}/complete", json={"resolution": "refund", "refund_method": "cash"}).json()
    assert done["status"] == "completed" and done["refund_amount"] == "1180.00"
    assert c.get(f"/orders/{o['id']}").json()["payment_status"] == "partially_paid"


def test_damaged_not_restocked_and_full_return_marks_order(shipped):
    c, o, pid, wh = shipped["c"], shipped["order"], shipped["product"]["id"], shipped["wh"]
    r = start_return(c, o, qty="3")
    c.post(f"/returns/{r['id']}/receive", json={"lines": [{"line_id": r["lines"][0]["id"], "condition": "damaged",
                                                           "disposition": "dispose"}]})
    assert bal(c, pid, wh)["on_hand"] == "7.000"
    c.post(f"/returns/{r['id']}/complete", json={"resolution": "refund", "refund_method": "cash"})
    assert c.get(f"/orders/{o['id']}").json()["status"] == "refunded"


def test_credit_note_resolution(shipped):
    c, o = shipped["c"], shipped["order"]
    inv_doc = c.post(f"/orders/{o['id']}/documents", json={"doc_type": "invoice"}).json()
    c.post(f"/documents/{inv_doc['id']}/issue")
    r = start_return(c, o, qty="2")
    c.post(f"/returns/{r['id']}/receive", json={"lines": [{"line_id": r["lines"][0]["id"], "condition": "opened",
                                                           "disposition": "dispose"}]})
    done = c.post(f"/returns/{r['id']}/complete", json={"resolution": "credit_note"}).json()
    cn = c.get(f"/documents/{done['credit_note_id']}").json()
    assert cn["doc_type"] == "credit_note" and cn["status"] == "issued" and cn["grand_total"] == "2360.00"


def test_replacement_order(shipped):
    c, o = shipped["c"], shipped["order"]
    r = start_return(c, o)
    c.post(f"/returns/{r['id']}/receive", json={"lines": [{"line_id": r["lines"][0]["id"], "condition": "damaged",
                                                           "disposition": "damaged"}]})
    done = c.post(f"/returns/{r['id']}/complete", json={"resolution": "replacement"}).json()
    rep = c.get(f"/orders/{done['replacement_order_id']}").json()
    assert rep["order_type"] == "replacement" and rep["grand_total"] == "0.00"


def test_complaints_and_stats(shipped):
    c, o = shipped["c"], shipped["order"]
    cmp = c.post("/complaints", json={"order_id": o["id"], "category": "quality",
                                      "description": "Cake was dry"}).json()
    assert cmp["customer_id"] == shipped["customer"]["id"] and cmp["number"].startswith("CMP-")
    assert c.patch(f"/complaints/{cmp['id']}", json={"status": "resolved"}).status_code == 422  # needs resolution
    upd = c.patch(f"/complaints/{cmp['id']}", json={"status": "resolved", "resolution": "Sent a fresh one"}).json()
    assert upd["response_hours"] is not None and upd["resolution_hours"] is not None
    stats = c.get("/complaints/stats").json()
    assert stats["by_category"] == {"quality": 1} and stats["open"] == 0
    rep = c.get("/reports/returns").json()
    assert rep["orders_shipped"] == 1
