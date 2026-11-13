from tests.conftest import login


def setup_category(owner_client):
    return owner_client.post("/expense-categories", json={"name": "Utilities"}).json()["id"]


def test_submit_attach_receipt_and_approve(owner_client, client, make_user):
    cat = setup_category(owner_client)
    owner_client.post("/auth/logout")

    make_user("staff@example.com", access=("expenses.create",))
    login(client, "staff@example.com")
    assert any(c["name"] == "Utilities" for c in client.get("/lookups").json()["expense_categories"])
    e = client.post("/expenses", json={"category_id": cat, "description": "Electricity Oct", "amount": "15000",
                                       "tax_amount": "2288.14"}).json()
    assert e["number"].startswith("EXP-") and e["status"] == "submitted"
    r = client.post(f"/attachments?entity_type=expenses&entity_id={e['id']}&category=receipt",
                    files={"file": ("bill.jpg", b"\xff\xd8jpeg", "image/jpeg")})
    assert r.status_code == 201  # submitter may attach to their own expense
    assert client.get(f"/expenses/{e['id']}").json()["has_receipt"]
    assert client.get("/expenses").status_code == 403  # can't list everyone's
    assert client.get("/expenses?mine=true").json()["total"] == 1
    assert client.post(f"/expenses/{e['id']}/approve", json={}).status_code == 403
    client.post("/auth/logout")

    make_user("manager@example.com", access=("expenses.view", "expenses.approve"))
    login(client, "manager@example.com")
    assert client.post(f"/expenses/{e['id']}/approve", json={}).json()["status"] == "approved"
    assert client.post(f"/expenses/{e['id']}/approve", json={}).status_code == 409


def test_cannot_approve_own_and_limit(owner_client, client, make_user):
    cat = setup_category(owner_client)
    owner_client.patch("/settings/company", json={"expense_approval_limit": "50000"})
    owner_client.post("/auth/logout")
    make_user("mgr@example.com", access=("expenses.view", "expenses.create", "expenses.approve"))
    login(client, "mgr@example.com")
    own = client.post("/expenses", json={"category_id": cat, "description": "Taxi", "amount": "800"}).json()
    assert client.post(f"/expenses/{own['id']}/approve", json={}).json()["code"] == "own_expense"
    client.post("/auth/logout")

    make_user("other@example.com", access=("expenses.create",))
    login(client, "other@example.com")
    big = client.post("/expenses", json={"category_id": cat, "description": "Oven", "amount": "250000"}).json()
    client.post("/auth/logout")
    login(client, "mgr@example.com")
    assert client.post(f"/expenses/{big['id']}/approve", json={}).json()["code"] == "over_limit"
    assert client.post(f"/expenses/{big['id']}/reject", json={}).status_code == 422  # reason needed
    assert client.post(f"/expenses/{big['id']}/reject", json={"note": "Get 3 quotes"}).json()["status"] == "rejected"


def test_filters_and_validation(owner_client):
    cat = setup_category(owner_client)
    owner_client.post("/expenses", json={"category_id": cat, "description": "Gas", "amount": "100",
                                         "expense_date": "2026-10-05"})
    owner_client.post("/expenses", json={"category_id": cat, "description": "Water", "amount": "100",
                                         "expense_date": "2026-11-05"})
    assert owner_client.get("/expenses?date_from=2026-11-01").json()["total"] == 1
    r = owner_client.post("/expenses", json={"category_id": cat, "description": "x", "amount": "10",
                                             "tax_amount": "20"})
    assert r.status_code == 422
