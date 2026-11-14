from datetime import timedelta
from unittest.mock import patch

from app.clock import local_today
from app.config import settings
from app.insights import run_scheduled
from tests.test_inventory import inv, receive  # noqa: F401
from tests.test_orders import order_body


def test_compare_slow_moving_wastage(inv):  # noqa: F811
    c, wh, pid = inv["c"], inv["wh"], inv["product"]["id"]
    receive(c, wh, pid, 10, cost=300, batch="B1")
    slow = c.get("/reports/slow-moving?days=30").json()
    assert slow[0]["product_id"] == pid and slow[0]["value"] == "3000.00" and slow[0]["last_used"] is None
    s = {"customer": inv["customer"], "product": inv["product"]}
    o = c.post("/orders", json={**order_body(s, confirm=True), "delivery_method": "pickup"}).json()
    c.post(f"/orders/{o['id']}/status", json={"status": "delivered"})
    assert c.get("/reports/slow-moving?days=30").json() == []
    t = local_today()
    cmp = c.get(f"/reports/compare?a_from={t - timedelta(days=60)}&a_to={t - timedelta(days=31)}"
                f"&b_from={t - timedelta(days=30)}&b_to={t}&group_by=channel").json()
    assert cmp["rows"][0]["b"] == "2360.00" and cmp["rows"][0]["a"] == "0"
    batch = c.get(f"/stock/batches?product_id={pid}").json()["items"][0]["id"]
    c.post("/stock/issue", json={"warehouse_id": wh, "reason": "damage", "note": "dropped",
                                 "lines": [{"product_id": pid, "quantity": "1", "batch_id": batch}]})
    w = c.get("/reports/wastage").json()["rows"][0]
    assert w["written_off_qty"] == "1.000" and w["written_off_value"] == "300.00"


def test_saved_views_and_scheduled_reports(owner_client, db):
    c = owner_client
    c.post("/saved-views", json={"name": "Lahore sales", "report": "sales", "params": {"city": "Lahore"},
                                 "shared": True})
    assert c.get("/saved-views?report=sales").json()[0]["mine"] is True
    r = c.post("/scheduled-reports", json={"name": "Weekly sales", "report": "sales", "frequency": "weekly",
                                           "recipients": ["boss@example.com"], "next_run": str(local_today())}).json()
    with patch.object(settings, "smtp_host", "smtp.test"), patch("smtplib.SMTP") as smtp:
        assert run_scheduled(db) == "1 scheduled reports sent"
        assert run_scheduled(db) == "0 scheduled reports sent"
        msg = smtp.return_value.__enter__.return_value.send_message.call_args[0][0]
        assert msg["To"] == "boss@example.com"
        assert any(p.get_filename().endswith(".xlsx") for p in msg.iter_attachments())
    assert c.get(f"/scheduled-reports/{r['id']}").json()["next_run"] == str(local_today() + timedelta(days=7))
