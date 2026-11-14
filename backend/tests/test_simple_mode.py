"""A small team's defaults: no approval steps, one-step batches, supplies bought at a total price."""

from tests.conftest import login
from tests.test_inventory import bal
from tests.test_production import prod  # noqa: F401  (fixture)
from tests.test_products import make_product


def test_without_approvals_things_go_through_on_save(owner_client, client, make_user):
    c = owner_client
    cat = c.post("/expense-categories", json={"name": "Gas"}).json()["id"]
    e = c.post("/expenses", json={"description": "Cylinder", "amount": "3000", "category_id": cat}).json()
    assert e["status"] == "approved"

    wh = c.post("/warehouses", json={"code": "HOME", "name": "Home"}).json()["id"]
    sugar = make_product(c, "RAW-SUGAR", name="Sugar", type="raw", track_batches=False)
    count = c.post("/stock/counts", json={"warehouse_id": wh, "product_ids": [sugar["id"]]}).json()
    c.put(f"/stock/counts/{count['id']}/lines", json=[{"product_id": sugar["id"], "counted_quantity": "4"}])
    assert c.post(f"/stock/counts/{count['id']}/submit").json()["status"] == "approved"
    assert bal(c, sugar["id"])["on_hand"] == "4.000"

    # family members' own expenses go through too
    c.post("/auth/logout")
    make_user("mum@example.com", access=("expenses.create", "expenses.approve", "expenses.view"))
    login(client, "mum@example.com")
    assert client.post("/expenses", json={"description": "Eggs", "amount": "500", "category_id": cat}
                       ).json()["status"] == "approved"


def test_receive_at_total_price(prod):
    c = prod["c"]
    c.post("/stock/receive", json={"lines": [{"product_id": prod["box"]["id"], "quantity": "50",
                                              "total_cost": "2000"}]})  # main warehouse by default
    assert bal(c, prod["box"]["id"])["on_hand"] == "150.000"
    cost = c.get(f"/recipes/{prod['recipe']['id']}/cost").json()
    assert cost["materials"] == "1553.33"  # boxes now average (100x30 + 2000) / 150 = 33.33


def test_check_ingredients_and_quick_batch(prod):
    c, r = prod["c"], prod["recipe"]
    check = c.get(f"/recipes/{r['id']}/check?batches=2").json()
    assert check["makes"] == "20.000"
    cocoa = next(ln for ln in check["lines"] if ln["product_id"] == prod["cocoa"]["id"])
    assert cocoa["needed"] == "1020.000" and cocoa["short"] == "0"  # 2 x 500 g + 2% wastage, 2000 g in stock

    po = c.post("/production-orders/quick", json={"product_id": prod["cake"]["id"], "batches": "2"}).json()
    assert po["status"] == "completed" and po["output_quantity"] == "20.000"
    assert bal(c, prod["cocoa"]["id"])["on_hand"] == "980.000"

    short = c.post("/production-orders/quick", json={"product_id": prod["cake"]["id"], "batches": "10"})
    assert short.status_code == 409 and short.json()["code"] == "material_shortage"
    assert bal(c, prod["cocoa"]["id"])["on_hand"] == "980.000"  # nothing taken
