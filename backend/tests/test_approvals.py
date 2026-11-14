from tests.conftest import login
from tests.test_orders import order_body, setup  # noqa: F401


def test_big_discount_and_refund_need_approval(setup, client, make_user):  # noqa: F811
    c = setup["c"]
    c.patch("/settings/company", json={"discount_approval_pct": "15", "refund_approval_amount": "1000"})
    make_user("sales@example.com", access=("orders.view", "orders.create", "orders.edit", "order_pricing.edit",
                                           "order_payments.view", "order_payments.create", "customers.view"))
    make_user("boss@example.com", access=("approvals.view", "approvals.approve", "expenses.approve"))
    c.post("/auth/logout")
    login(client, "sales@example.com")
    r = client.post("/orders", json=order_body(setup, confirm=True, order_discount_pct="20"))
    assert r.status_code == 409 and r.json()["code"] == "approval_required"
    req_id = int(r.json()["fields"]["approval_request_id"])
    order = client.get("/orders?status=draft").json()["items"][0]  # the draft was kept
    assert client.post(f"/orders/{order['id']}/status", json={"status": "confirmed"}).status_code == 409
    small = client.post("/orders", json=order_body(setup, confirm=True, order_discount_pct="10"))
    assert small.status_code == 201  # under the limit
    client.post(f"/orders/{small.json()['id']}/payments", json={"method": "cash", "amount": "2124"})

    client.post("/auth/logout")
    login(client, "boss@example.com")
    inbox = client.get("/approvals/inbox").json()
    assert [i["type"] for i in inbox] == ["approval_request"] and "20.0% discount" in inbox[0]["title"]
    client.post(f"/approvals/{req_id}/approve", json={})

    client.post("/auth/logout")
    login(client, "sales@example.com")
    assert client.post(f"/orders/{order['id']}/status", json={"status": "confirmed"}).json()["status"] == "confirmed"
    r = client.post(f"/orders/{small.json()['id']}/payments", json={"kind": "refund", "method": "cash",
                                                                    "amount": "2124"})
    assert r.status_code == 409
    refund_req = int(r.json()["fields"]["approval_request_id"])
    assert client.post(f"/orders/{small.json()['id']}/payments", json={"kind": "refund", "method": "cash",
                                                                       "amount": "500"}).status_code == 201

    client.post("/auth/logout")
    login(client, "boss@example.com")
    client.post(f"/approvals/{refund_req}/approve", json={})  # the refund is carried out on approval
    client.post("/auth/logout")
    login(client, "sales@example.com")
    assert client.get(f"/orders/{small.json()['id']}").json()["payment_status"] == "refunded"


def test_inbox_excludes_own_items(owner_client):
    c = owner_client
    cat = c.post("/expense-categories", json={"name": "Misc"}).json()["id"]
    c.post("/expenses", json={"category_id": cat, "description": "Mine", "amount": "100"})
    assert c.get("/approvals/inbox").json() == []
