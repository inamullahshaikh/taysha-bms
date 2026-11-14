import pytest

from tests.conftest import login
from tests.test_accounting import bal

pytestmark = pytest.mark.usefixtures("approvals_required")  # these tests cover the approval workflow


def test_ownership_votes_and_capital(owner_client, make_user, client):
    c = owner_client
    a = c.post("/partners", json={"name": "Ali"}).json()
    b = c.post("/partners", json={"name": "Bushra"}).json()
    r = c.put("/partners/ownership", json={"shares": {str(a["id"]): "60", str(b["id"]): "40"}}).json()
    assert r["total_pct"] == "100.000"
    assert c.put("/partners/ownership", json={"shares": {str(a["id"]): "70"}}).status_code == 422  # 110%
    res = c.post("/resolutions", json={"title": "Bring in a third partner"}).json()
    c.post(f"/resolutions/{res['id']}/votes", json={"partner_id": b["id"], "vote": "yes"})
    assert c.get(f"/resolutions/{res['id']}").json()["status"] == "proposed"  # 40% isn't a majority
    assert c.post(f"/resolutions/{res['id']}/votes", json={"partner_id": a["id"], "vote": "yes"}).json()[
        "status"] == "approved"
    hist = c.get(f"/partners/{a['id']}/ownership-history").json()
    assert hist[0]["new_pct"] == "60.000"

    t = c.post("/partner-transactions", json={"partner_id": a["id"], "kind": "capital_contribution",
                                              "amount": "500000"}).json()
    assert t["status"] == "pending"
    assert c.post(f"/partner-transactions/{t['id']}/approve").json()["code"] == "own_entry"
    c.post("/auth/logout")
    make_user("b@example.com", access=("partners.view", "partners.approve", "accounting.view"))
    login(client, "b@example.com")
    assert client.post(f"/partner-transactions/{t['id']}/approve").json()["status"] == "approved"
    assert bal(client, "3000") == "500000.00" and bal(client, "1010") == "500000.00"
    rep = client.get("/partners/report").json()
    assert next(p for p in rep["partners"] if p["name"] == "Ali")["capital_contributed"] == "500000.00"


def test_partners_are_confidential(user_client):
    c = user_client("orders.view")
    assert c.get("/partners").status_code == 403
