import pytest

from tests.test_inventory import bal, receive
from tests.test_orders import order_body
from tests.test_products import make_product, price_list, unit_id


@pytest.fixture
def prod(owner_client):
    c = owner_client
    wh = c.post("/warehouses", json={"code": "MAIN", "name": "Main"}).json()["id"]
    c.patch("/settings/company", json={"labour_rate_per_hour": "600", "overhead_pct": "10"})
    g = unit_id(c, "g")
    cocoa = make_product(c, "RAW-COCOA", name="Cocoa", type="raw", unit_id=g)
    flour = make_product(c, "RAW-FLOUR", name="Flour", type="raw", unit_id=g, track_batches=False)
    box = make_product(c, "PKG-BOX", name="Box", type="packaging", track_batches=False)
    cake = make_product(c, "MUG-1", name="Mug cake", shelf_life_days=30)
    c.post(f"/products/{cake['id']}/prices", json={"price_list_id": price_list(c), "price": "1180"})
    receive(c, wh, cocoa["id"], 2, cost=2000, unit="kg", batch="COCOA-A")  # 2 per g
    receive(c, wh, flour["id"], 5, cost=200, unit="kg")  # 0.2 per g
    receive(c, wh, box["id"], 100, cost=30)
    recipe = c.post("/recipes", json={
        "product_id": cake["id"], "yield_quantity": "10", "labour_minutes": 60, "instructions": "Mix, fill, bake",
        "lines": [{"product_id": cocoa["id"], "quantity": "500", "wastage_pct": "2"},
                  {"product_id": flour["id"], "quantity": "1", "unit": "kg"},
                  {"product_id": box["id"], "quantity": "10"}]}).json()
    c.post(f"/recipes/{recipe['id']}/activate")
    return {"c": c, "wh": wh, "cocoa": cocoa, "flour": flour, "box": box, "cake": cake, "recipe": recipe}


def test_recipe_versions_and_cost(prod):
    c, r = prod["c"], prod["recipe"]
    cost = c.get(f"/recipes/{r['id']}/cost").json()
    # materials: 510 g cocoa x2 + 1000 g flour x0.2 + 10 boxes x30 = 1020 + 200 + 300; labour 1h x 600; overhead 10%
    assert cost["materials"] == "1520.00" and cost["labour"] == "600.00" and cost["overhead"] == "152.00"
    assert cost["per_unit"] == "227.2000"
    assert c.put(f"/recipes/{r['id']}", json={"product_id": prod["cake"]["id"], "yield_quantity": "10",
                                              "lines": [{"product_id": prod["box"]["id"], "quantity": "1"}]}
                 ).status_code == 409  # active versions are frozen
    v2 = c.post(f"/recipes/{r['id']}/new-version").json()
    c.put(f"/recipes/{v2['id']}", json={"product_id": prod["cake"]["id"], "yield_quantity": "10",
                                        "lines": [{"product_id": prod["cocoa"]["id"], "quantity": "600"},
                                                  {"product_id": prod["box"]["id"], "quantity": "10"}]})
    c.post(f"/recipes/{v2['id']}/activate")
    assert c.get(f"/recipes/{r['id']}").json()["status"] == "superseded"
    diff = {x["name"]: x["change"] for x in c.get(f"/recipes/{v2['id']}/compare/{r['id']}").json()["lines"]}
    assert diff == {"Cocoa": "changed", "Flour": "added", "Box": "same"}


def test_full_production_run_with_qc_trace_and_recall(prod):
    c, wh = prod["c"], prod["wh"]
    s = {"customer": c.post("/customers", json={"name": "Hina"}).json(), "product": prod["cake"]}
    o = c.post("/orders", json={**order_body(s, confirm=True, delivery_method="pickup"),
                                "lines": [{"product_id": prod["cake"]["id"], "quantity": "5"}]}).json()
    assert o["lines"][0]["backorder_qty"] == "5.000"
    sug = c.get("/production/suggestions").json()
    assert sug[0]["suggested_quantity"] == "10.000" and sug[0]["reason"] == "backorders"

    po = c.post("/production-orders", json={"product_id": prod["cake"]["id"], "quantity": "20"}).json()
    req = {m["sku"]: m["required"] for m in po["materials"]}
    assert req == {"RAW-COCOA": "1020.000", "RAW-FLOUR": "2000.000", "PKG-BOX": "20.000"}
    po = c.post(f"/production-orders/{po['id']}/release").json()
    assert bal(c, prod["cocoa"]["id"], wh)["reserved"] == "1020.000"
    po = c.post(f"/production-orders/{po['id']}/start").json()
    assert po["status"] == "in_progress" and bal(c, prod["cocoa"]["id"], wh)["on_hand"] == "980.000"
    stage = po["stages"][0]
    c.patch(f"/production-orders/{po['id']}/stages/{stage['id']}", json={"status": "done"})
    po = c.post(f"/production-orders/{po['id']}/complete", json={
        "output_quantity": "19", "rejected_quantity": "1", "labour_minutes": 120,
        "materials": [{"product_id": prod["cocoa"]["id"], "quantity": "1000"}]}).json()
    assert bal(c, prod["cocoa"]["id"], wh)["on_hand"] == "1000.000"  # 20 g returned
    # cost: cocoa 1000x2 + flour 2000x0.2 + boxes 20x30 = 3000; labour 2h x600 = 1200; overhead 300
    assert po["material_cost"] == "3000.00" and po["actual_cost"] == "4500.00" and po["yield_pct"] == "95.0"
    assert po["unit_cost"] == "236.8421"

    cake_bal = bal(c, prod["cake"]["id"], wh)
    assert cake_bal["on_hand"] == "19.000" and cake_bal["available"] == "0.000"  # on QC hold
    qc = c.post("/qc/checks", json={"stage": "finished", "production_order_id": po["id"], "results": [
        {"name": "Weight", "value": "250", "passed": True}, {"name": "Seal", "value": True}]}).json()
    assert qc["result"] == "pass" and qc["batch_id"] == po["batch_id"]
    line = c.get(f"/orders/{o['id']}").json()["lines"][0]
    assert line["backorder_qty"] == "0.000"  # QC release filled the waiting order
    c.post(f"/orders/{o['id']}/status", json={"status": "delivered"})

    cocoa_batch = c.get(f"/stock/batches?product_id={prod['cocoa']['id']}").json()["items"][0]["id"]
    fwd = c.get(f"/trace/batches/{cocoa_batch}").json()
    assert fwd["affected_orders"][0]["order"] == o["number"] and len(fwd["affected_batches"]) == 2
    back = c.get(f"/trace/batches/{po['batch_id']}?direction=backward").json()
    assert {i["product"] for i in back["made_by"]["inputs"]} == {"Cocoa", "Flour", "Box"}

    recall = c.post("/recalls", json={"batch_id": cocoa_batch, "reason": "Supplier reported contamination"}).json()
    assert len(recall["affected"]["orders"]) == 1
    assert c.get(f"/stock/batches?product_id={prod['cake']['id']}").json()["items"][0]["status"] == "hold"

    for doc in ("batch_sheet", "pick_list"):
        assert c.get(f"/production-orders/{po['id']}/pdf?doc={doc}").content.startswith(b"%PDF")
    d = c.get("/dashboard").json()["production"]
    assert d["completed_orders"] == 1 and d["efficiency_pct"] == "95.0"


def test_shortage_blocks_start_and_qc_fail_rejects(prod):
    c = prod["c"]
    po = c.post("/production-orders", json={"product_id": prod["cake"]["id"], "quantity": "100"}).json()
    r = c.post(f"/production-orders/{po['id']}/start")
    assert r.status_code == 409 and r.json()["code"] == "material_shortage"
    po2 = c.post("/production-orders", json={"product_id": prod["cake"]["id"], "quantity": "10"}).json()
    c.post(f"/production-orders/{po2['id']}/start")
    po2 = c.post(f"/production-orders/{po2['id']}/complete", json={"output_quantity": "10"}).json()
    tpl = c.post("/qc/templates", json={"name": "Finished cake", "stage": "finished", "checks": [
        {"name": "Weight", "type": "number", "min": 240, "max": 260, "unit": "g"}]}).json()
    assert c.post("/qc/checks", json={"template_id": tpl["id"], "stage": "finished", "batch_id": po2["batch_id"],
                                      "results": [{"name": "Weight", "value": "200"}]}).status_code == 422
    qc = c.post("/qc/checks", json={"template_id": tpl["id"], "stage": "finished", "batch_id": po2["batch_id"],
                                    "results": [{"name": "Weight", "value": "200"}], "defects": "Underweight"}).json()
    assert qc["result"] == "fail"
    assert c.get(f"/stock/batches?product_id={prod['cake']['id']}").json()["items"][0]["status"] == "rejected"


def test_food_safety_due(prod):
    c = prod["c"]
    c.post("/food-safety", json={"kind": "cleaning", "title": "Deep clean ovens", "record_date": "2026-11-01",
                                 "result": "ok", "next_due_date": "2026-11-08"})
    assert c.get("/food-safety/due?days=3650").json()[0]["title"] == "Deep clean ovens"
