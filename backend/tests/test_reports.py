from tests.conftest import login
from tests.test_orders import order_body, setup  # noqa: F401


def seed(s, n=2, **kw):
    for _ in range(n):
        s["c"].post("/orders", json=order_body(s, confirm=True, **kw))


def test_dashboard_numbers(setup):  # noqa: F811
    c = setup["c"]
    seed(setup)  # 2 orders x (2 x 1180) = 4720 revenue, 4000 net, cost 300/unit -> COGS 1200
    c.post("/orders", json=order_body(setup))  # draft: not counted
    cat = c.post("/expense-categories", json={"name": "Rent"}).json()["id"]
    c.post("/expenses", json={"category_id": cat, "description": "Rent", "amount": "1000"})
    dash = c.get("/dashboard?range=today").json()
    s = dash["sales"]
    assert s["order_count"] == 2 and s["revenue"] == "4720.00" and s["net_sales"] == "4000.00"
    assert s["status_counts"]["draft"] == 1
    assert s["top_products"][0]["quantity"] == "4.000"
    p = dash["profit"]
    assert p["cogs"] == "1200.00" and p["gross_profit"] == "2800.00" and p["gross_margin_pct"] == "70.0"
    assert p["expenses"] == "0" and dash["expenses"]["pending_approvals"] == 1  # submitted, not yet approved
    assert dash["customers"]["active_customers"] == 1


def test_dashboard_hides_sections_without_access(setup, client, make_user):  # noqa: F811
    seed(setup, 1)
    setup["c"].post("/auth/logout")
    make_user("sales@example.com", access=("orders.view",))
    login(client, "sales@example.com")
    dash = client.get("/dashboard").json()
    assert "sales" in dash and "profit" not in dash and "expenses" not in dash and "customers" not in dash
    assert all(set(m) == {"month", "revenue", "net_sales"} for m in dash["trend"])


def test_reports_and_exports(setup):  # noqa: F811
    c = setup["c"]
    seed(setup)
    r = c.get("/reports/sales?group_by=channel&range=year").json()
    assert r["rows"][0]["label"] == "direct" and r["rows"][0]["orders"] == 2
    assert c.get("/reports/sales?group_by=product&format=xlsx").content[:2] == b"PK"
    assert c.get("/reports/sales?group_by=month&format=pdf").content.startswith(b"%PDF")
    pl = c.get("/reports/profit-loss?range=year").json()
    assert pl["net_sales"] == "4000.00" and pl["gross_margin_pct"] == "70.0"
    assert c.get("/reports/profit-loss?format=pdf").content.startswith(b"%PDF")
    assert c.get("/reports/sales?range=custom&date_from=2026-02-01&date_to=2026-01-01").status_code == 422


def test_layout_saved_per_user(owner_client):
    assert "sales_summary" in owner_client.get("/dashboard/layout").json()["widgets"]
    owner_client.put("/dashboard/layout", json={"widgets": ["top_products"]})
    assert owner_client.get("/dashboard/layout").json()["widgets"] == ["top_products"]
