from datetime import timedelta

from sqlalchemy import select, update

from app.automation import run_all
from app.clock import utcnow
from app.orders.models import OrderStatusHistory
from tests.test_inventory import inv, receive  # noqa: F401
from tests.test_orders import order_body


def test_rules_notify_task_and_auto_deliver(inv, db):  # noqa: F811
    c, wh, pid = inv["c"], inv["wh"], inv["product"]["id"]
    me = c.get("/auth/me").json()
    receive(c, wh, pid, 3, batch="B1")
    assert c.post("/automation/rules", json={"name": "bad", "trigger": "order_in_status", "action": "email",
                                             "action_params": {"to": ["x@example.com"]}}).status_code == 422
    low = c.post("/automation/rules", json={"name": "Cake running out", "trigger": "low_stock",
                                            "params": {"product_id": pid, "below": 5}, "action": "create_task",
                                            "action_params": {"assignee_id": me["id"], "due_in_days": 1}}).json()
    deliver = c.post("/automation/rules", json={
        "name": "Auto-deliver after 3 days", "trigger": "order_in_status",
        "params": {"status": "dispatched", "older_than_hours": 72}, "action": "mark_delivered"}).json()
    c.post("/automation/rules", json={"name": "Tell stores", "trigger": "low_stock",
                                      "params": {"product_id": pid, "below": 5}, "action": "notify_users",
                                      "action_params": {"user_ids": [me["id"]]}})
    assert c.post(f"/automation/rules/{low['id']}/test").json()[0]["already_handled"] is False

    s = {"customer": inv["customer"], "product": inv["product"]}
    o = c.post("/orders", json={**order_body(s, confirm=True), "lines": [{"product_id": pid, "quantity": "1"}]}).json()
    c.patch(f"/orders/{o['id']}/delivery", json={"courier": "TCS"})
    c.post(f"/orders/{o['id']}/status", json={"status": "dispatched"})
    db.execute(update(OrderStatusHistory).where(OrderStatusHistory.order_id == o["id"])
               .values(at=utcnow() - timedelta(days=4)))
    db.flush()

    assert run_all(db) == "3 automation actions"
    assert run_all(db) == "0 automation actions"  # each match acts once
    assert c.get("/tasks/mine").json()[0]["title"].startswith("Cake running out")
    assert any(n["kind"] == "automation" for n in c.get("/notifications").json()["items"])
    assert c.get(f"/orders/{o['id']}").json()["status"] == "delivered"
    assert len(c.get(f"/automation/rules/{deliver['id']}/hits").json()) == 1
    assert db.scalar(select(OrderStatusHistory.note).where(OrderStatusHistory.order_id == o["id"],
                                                           OrderStatusHistory.to_status == "delivered")).startswith(
        "Automation")
