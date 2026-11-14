from datetime import timedelta
from decimal import Decimal

from app.clock import local_today
from app.forecast import forecast_series, month_add
from app.orders.models import Order
from tests.test_production import prod  # noqa: F401

D = Decimal


def test_forecast_series_weighting_and_seasonality():
    assert forecast_series([D(10), D(20), D(30)], 2) == [D("23.333"), D("23.333")]  # (10 + 40 + 90) / 6
    flat = [D(10)] * 11 + [D(10)]
    assert forecast_series(flat, 1) == [D("10.000")]
    seasonal = [D(20)] + [D(10)] * 11  # this month last year was double
    assert forecast_series(seasonal, 1)[0] > D(10)


def test_production_and_material_suggestions(prod, db):  # noqa: F811
    c = prod["c"]
    s = {"customer": c.post("/customers", json={"name": "Hina"}).json(), "product": prod["cake"]}
    last_month = month_add(local_today().replace(day=1), -1)
    for _ in range(3):  # 3 orders of 10 last month -> demand 30/month in the latest month
        o = c.post("/orders", json={"customer_id": s["customer"]["id"], "delivery_method": "pickup",
                                    "lines": [{"product_id": prod["cake"]["id"], "quantity": "10"}]}).json()
        order = db.get(Order, o["id"])
        order.order_date, order.status = last_month + timedelta(days=3), "delivered"
    db.flush()
    d = c.get(f"/forecast/demand?product_id={prod['cake']['id']}").json()[0]
    assert d["history"][-1]["quantity"] == "30.000" and d["forecast"][0]["quantity"] == "15.000"  # 30*3/6
    plan = c.get("/forecast/production").json()[0]
    assert plan["suggested_quantity"] == "20.000" and plan["batches"] == "2"  # 15 needed -> 2 batches of 10
    mats = {m["name"]: m for m in c.get("/forecast/materials").json()}
    assert "Box" not in mats  # 100 boxes in stock cover the need
    assert set(mats) <= {"Cocoa", "Flour"}
