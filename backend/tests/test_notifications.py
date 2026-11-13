from app.notifications import check_alerts
from tests.conftest import login
from tests.test_inventory import inv, receive  # noqa: F401


def test_low_stock_alert_once_then_again_after_clearing(inv, db, make_user, client):  # noqa: F811
    c, wh, pid = inv["c"], inv["wh"], inv["product"]["id"]
    c.put("/stock/rules", json={"product_id": pid, "warehouse_id": wh, "reorder_point": "5", "max_qty": "100"})
    receive(c, wh, pid, 3, batch="B1")
    make_user("store@example.com", access=("inventory.view",))
    make_user("sales@example.com", access=("orders.view",))

    check_alerts(db)
    check_alerts(db)  # still low: no duplicate
    mine = c.get("/notifications").json()
    assert mine["unread"] == 1 and mine["items"][0]["kind"] == "low_stock"

    receive(c, wh, pid, 10, batch="B2")
    check_alerts(db)  # cleared
    c.post("/stock/issue", json={"warehouse_id": wh, "note": "tasting", "lines": [{"product_id": pid,
                                                                                    "quantity": "10"}]})
    check_alerts(db)  # low again -> new alert
    assert c.get("/notifications").json()["unread"] == 2

    c.post("/auth/logout")
    login(client, "store@example.com")
    assert client.get("/notifications").json()["unread"] == 2
    client.post("/auth/logout")
    login(client, "sales@example.com")
    assert client.get("/notifications").json()["unread"] == 0  # no inventory access, no stock alerts


def test_preferences_and_read(inv, db):  # noqa: F811
    c, wh, pid = inv["c"], inv["wh"], inv["product"]["id"]
    prefs = c.put("/notifications/preferences", json={"expiring_stock": {"in_app": False}}).json()
    assert next(p for p in prefs if p["kind"] == "expiring_stock")["in_app"] is False
    receive(c, wh, pid, 2, batch="OLD", expiry="2020-01-01")
    check_alerts(db)
    items = c.get("/notifications").json()["items"]
    assert [i["kind"] for i in items] == ["expired_stock"]
    c.post(f"/notifications/{items[0]['id']}/read")
    assert c.get("/notifications?unread_only=true").json()["items"] == []
