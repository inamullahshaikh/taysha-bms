from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.inventory.models import StockBalance, StockMovement, Warehouse
from app.inventory.service import move
from app.products.models import Product
from tests.test_orders import order_body
from tests.test_products import make_product, price_list, unit_id

D = Decimal


@pytest.fixture
def inv(owner_client):
    c = owner_client
    wh = c.post("/warehouses", json={"code": "MAIN", "name": "Main store"}).json()
    wh2 = c.post("/warehouses", json={"code": "STALL", "name": "Stall"}).json()
    p = make_product(c, "MUG-1", name="Mug cake", shelf_life_days=30)
    c.post(f"/products/{p['id']}/prices", json={"price_list_id": price_list(c), "price": "1180"})
    cust = c.post("/customers", json={"name": "Hina"}).json()
    return {"c": c, "wh": wh["id"], "wh2": wh2["id"], "product": p, "customer": cust}


def receive(c, wh, pid, qty, cost=None, batch=None, expiry=None, unit=None):
    line = {"product_id": pid, "quantity": str(qty)}
    if cost is not None:
        line["unit_cost"] = str(cost)
    if batch:
        line["batch_number"] = batch
    if expiry:
        line["expiry_date"] = expiry
    if unit:
        line["unit"] = unit
    r = c.post("/stock/receive", json={"warehouse_id": wh, "lines": [line]})
    assert r.status_code == 201, r.text
    return r.json()


def bal(c, pid, wh=None):
    url = f"/stock/balances?q={c.get(f'/products/{pid}').json()['sku']}" + (f"&warehouse_id={wh}" if wh else "")
    return c.get(url).json()["items"][0]


def test_ledger_and_weighted_average(inv):
    c, wh, pid = inv["c"], inv["wh"], inv["product"]["id"]
    receive(c, wh, pid, 10, cost=100, batch="B1", expiry="2027-01-01")
    receive(c, wh, pid, 30, cost=200, batch="B2", expiry="2027-02-01")
    b = bal(c, pid, wh)
    assert b["on_hand"] == "40.000" and b["avg_cost"].startswith("175")  # (10*100 + 30*200) / 40
    moves = c.get(f"/stock/movements?product_id={pid}").json()["items"]
    assert [m["balance_after"] for m in moves] == ["30.000", "10.000"]  # per batch, newest first


def test_fefo_issue_and_insufficient(inv):
    c, wh, pid = inv["c"], inv["wh"], inv["product"]["id"]
    receive(c, wh, pid, 5, batch="LATE", expiry="2027-06-01")
    receive(c, wh, pid, 5, batch="SOON", expiry="2027-01-01")
    moves = c.post("/stock/issue", json={"warehouse_id": wh, "reason": "sample", "note": "Tasting",
                                         "lines": [{"product_id": pid, "quantity": "7"}]}).json()
    batches = {b["id"]: b["number"] for b in c.get(f"/stock/batches?product_id={pid}").json()["items"]}
    assert [(batches[m["batch_id"]], m["quantity"]) for m in moves] == [("SOON", "-5.000"), ("LATE", "-2.000")]
    r = c.post("/stock/issue", json={"warehouse_id": wh, "note": "x", "lines": [{"product_id": pid, "quantity": "9"}]})
    assert r.status_code == 409 and r.json()["code"] == "insufficient_stock"


def test_held_and_expired_batches_are_not_available(inv):
    c, wh, pid = inv["c"], inv["wh"], inv["product"]["id"]
    receive(c, wh, pid, 5, batch="OLD", expiry="2020-01-01")
    receive(c, wh, pid, 5, batch="OK", expiry="2030-01-01")
    assert bal(c, pid, wh)["available"] == "5.000"
    ok = next(b for b in c.get(f"/stock/batches?product_id={pid}").json()["items"] if b["number"] == "OK")
    c.patch(f"/stock/batches/{ok['id']}", json={"status": "hold"})
    assert bal(c, pid, wh)["available"] == "0.000"
    assert c.get(f"/stock/batches?product_id={pid}&expired=true").json()["total"] == 1


def test_units_and_packs(inv):
    c, wh = inv["c"], inv["wh"]
    flour = make_product(c, "RAW-FLOUR", name="Flour", type="raw", unit_id=unit_id(c, "g"), track_batches=False)
    receive(c, wh, flour["id"], "2.5", unit="kg")
    assert bal(c, flour["id"], wh)["on_hand"] == "2500.000"
    c.put(f"/products/{inv['product']['id']}/units", json=[{"name": "carton", "factor": "12"}])
    receive(c, wh, inv["product"]["id"], 2, unit="carton", batch="C1")
    assert bal(c, inv["product"]["id"], wh)["on_hand"] == "24.000"


def test_order_reserve_backorder_and_fill(inv):
    c, wh, pid = inv["c"], inv["wh"], inv["product"]["id"]
    receive(c, wh, pid, 3, batch="B1")
    s = {"customer": inv["customer"], "product": inv["product"]}
    o = c.post("/orders", json={**order_body(s, confirm=True), "lines": [{"product_id": pid, "quantity": "5"}]}).json()
    line = o["lines"][0]
    assert line["reserved_qty"] == "3.000" and line["backorder_qty"] == "2.000"
    assert bal(c, pid, wh)["available"] == "0.000"
    c.patch(f"/orders/{o['id']}/delivery", json={"courier": "TCS"})
    r = c.post(f"/orders/{o['id']}/status", json={"status": "dispatched"})
    assert r.status_code == 409 and r.json()["code"] == "backordered"
    receive(c, wh, pid, 10, batch="B2")  # arrival fills the backorder automatically
    line = c.get(f"/orders/{o['id']}").json()["lines"][0]
    assert line["backorder_qty"] == "0.000"
    o = c.post(f"/orders/{o['id']}/status", json={"status": "dispatched"}).json()
    assert o["fulfilment_status"] == "fulfilled" and o["lines"][0]["shipped_qty"] == "5.000"
    assert bal(c, pid, wh)["on_hand"] == "8.000"


def test_partial_shipments(inv):
    c, wh, pid = inv["c"], inv["wh"], inv["product"]["id"]
    receive(c, wh, pid, 10, cost=300, batch="B1")
    s = {"customer": inv["customer"], "product": inv["product"]}
    o = c.post("/orders", json={**order_body(s, confirm=True), "lines": [{"product_id": pid, "quantity": "4"}]}).json()
    lid = o["lines"][0]["id"]
    o = c.post(f"/orders/{o['id']}/shipments", json={"courier": "Leopards",
                                                       "lines": [{"order_line_id": lid, "quantity": "1"}]}).json()
    assert o["status"] == "processing" and o["fulfilment_status"] == "partial"
    o = c.post(f"/orders/{o['id']}/shipments", json={"lines": [{"order_line_id": lid, "quantity": "3"}]}).json()
    assert o["status"] == "dispatched" and o["fulfilment_status"] == "fulfilled"
    assert len(c.get(f"/orders/{o['id']}/shipments").json()) == 2
    r = c.post(f"/orders/{o['id']}/status", json={"status": "cancelled", "note": "x"})
    assert r.status_code == 409


def test_cancel_releases_reservation(inv):
    c, wh, pid = inv["c"], inv["wh"], inv["product"]["id"]
    receive(c, wh, pid, 5, batch="B1")
    s = {"customer": inv["customer"], "product": inv["product"]}
    o = c.post("/orders", json={**order_body(s, confirm=True), "lines": [{"product_id": pid, "quantity": "5"}]}).json()
    assert bal(c, pid, wh)["available"] == "0.000"
    c.post(f"/orders/{o['id']}/status", json={"status": "cancelled", "note": "customer cancelled"})
    assert bal(c, pid, wh)["available"] == "5.000"


def test_bundle_consumes_components(inv):
    c, wh, pid = inv["c"], inv["wh"], inv["product"]["id"]
    box = make_product(c, "BOX", name="Gift box", kind="bundle")
    c.put(f"/products/{box['id']}/components", json=[{"component_id": pid, "quantity": "3"}])
    c.post(f"/products/{box['id']}/prices", json={"price_list_id": price_list(c), "price": "3000"})
    receive(c, wh, pid, 6, batch="B1")
    s = {"customer": inv["customer"], "product": box}
    o = c.post("/orders", json={**order_body(s, confirm=True, delivery_method="pickup"),
                                "lines": [{"product_id": box["id"], "quantity": "2"}]}).json()
    assert o["lines"][0]["backorder_qty"] == "0.000"
    c.post(f"/orders/{o['id']}/status", json={"status": "delivered"})
    assert bal(c, pid, wh)["on_hand"] == "0.000"


def test_transfer_in_transit(inv):
    c, wh, wh2, pid = inv["c"], inv["wh"], inv["wh2"], inv["product"]["id"]
    receive(c, wh, pid, 10, batch="B1")
    t = c.post("/stock/transfers", json={"from_warehouse_id": wh, "to_warehouse_id": wh2,
                                         "lines": [{"product_id": pid, "quantity": "4"}]}).json()
    c.post(f"/stock/transfers/{t['id']}/ship")
    assert bal(c, pid, wh)["on_hand"] == "6.000" and bal(c, pid)["in_transit"] == "4.000"
    line = c.get(f"/stock/transfers/{t['id']}").json()["lines"][0]
    c.post(f"/stock/transfers/{t['id']}/receive", json=[{"line_id": line["id"], "received_quantity": "4"}])
    assert bal(c, pid, wh2)["on_hand"] == "4.000" and bal(c, pid)["in_transit"] == "0.000"


def test_stock_count_reconciles(inv):
    c, wh, pid = inv["c"], inv["wh"], inv["product"]["id"]
    receive(c, wh, pid, 10, batch="B1")
    cnt = c.post("/stock/counts", json={"warehouse_id": wh}).json()
    line = cnt["lines"][0]
    assert line["system_quantity"] == "10.000"
    assert c.post(f"/stock/counts/{cnt['id']}/submit").status_code == 422  # not counted yet
    c.put(f"/stock/counts/{cnt['id']}/lines", json=[{"line_id": line["id"], "counted_quantity": "8"}])
    c.post(f"/stock/counts/{cnt['id']}/submit")
    assert c.post(f"/stock/counts/{cnt['id']}/approve").json()["status"] == "approved"
    assert bal(c, pid, wh)["on_hand"] == "8.000"


def test_adjust_requires_note_and_valuation(inv):
    c, wh, pid = inv["c"], inv["wh"], inv["product"]["id"]
    receive(c, wh, pid, 10, cost=150, batch="B1")
    batch = c.get(f"/stock/batches?product_id={pid}").json()["items"][0]["id"]
    assert c.post("/stock/adjust", json={"warehouse_id": wh, "product_id": pid, "batch_id": batch,
                                         "new_quantity": "9", "note": ""}).status_code == 422
    c.post("/stock/adjust", json={"warehouse_id": wh, "product_id": pid, "batch_id": batch, "new_quantity": "9",
                                  "note": "Dropped one"})
    v = c.get("/stock/valuation?group_by=product").json()
    assert v["total"] == "1350.00"


def test_balance_always_equals_sum_of_movements(engine):
    """20 concurrent +1/-1 movements on one balance row: final balance == sum of ledger."""
    with Session(engine) as s, s.begin():
        wh = Warehouse(code="CONC", name="Concurrency")
        unit = s.execute(select(func.min(Product.unit_id))).scalar() or 1
        p = Product(sku="CONC-1", name="Concurrency", unit_id=unit, track_batches=False)
        s.add_all([wh, p])
        s.flush()
        move(s, product_id=p.id, warehouse_id=wh.id, quantity=D(100), reason="receipt")
        pid, wid = p.id, wh.id

    def work(i):
        with Session(engine) as s, s.begin():
            move(s, product_id=pid, warehouse_id=wid, quantity=D(1) if i % 2 else D(-1), reason="adjustment")

    try:
        with ThreadPoolExecutor(8) as pool:
            list(pool.map(work, range(20)))
        with Session(engine) as s:
            balance = s.scalar(select(StockBalance.quantity).where(StockBalance.product_id == pid))
            ledger = s.scalar(select(func.sum(StockMovement.quantity)).where(StockMovement.product_id == pid))
            assert balance == ledger == D(100)
    finally:
        with Session(engine) as s, s.begin():
            s.execute(delete(StockMovement).where(StockMovement.product_id == pid))
            s.execute(delete(StockBalance).where(StockBalance.product_id == pid))
            s.execute(delete(Product).where(Product.id == pid))
            s.execute(delete(Warehouse).where(Warehouse.id == wid))
