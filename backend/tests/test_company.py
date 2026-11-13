from decimal import Decimal

from app.company import convert


def test_company_profile_and_logo(owner_client):
    assert owner_client.get("/settings/company").json()["name"] == "Taysha"
    r = owner_client.patch("/settings/company", json={"ntn": "1234567-8", "brand_color": "#8B4513"})
    assert r.json()["ntn"] == "1234567-8"
    assert owner_client.patch("/settings/company", json={"brand_color": "brown"}).status_code == 422
    png = b"\x89PNG\r\n\x1a\nfake"
    assert owner_client.put("/settings/company/logo", files={"file": ("l.png", png, "image/png")}).json()["has_logo"]
    assert owner_client.get("/settings/company/logo").content == png


def test_branch_crud_archive_and_duplicates(owner_client):
    b = owner_client.post("/settings/branches", json={"code": "LHR", "name": "Lahore"}).json()
    assert owner_client.post("/settings/branches", json={"code": "LHR", "name": "Again"}).status_code == 409
    assert owner_client.patch(f"/settings/branches/{b['id']}", json={"name": "Lahore HQ"}).json()["name"] == "Lahore HQ"
    owner_client.post(f"/settings/branches/{b['id']}/archive")
    assert owner_client.get("/settings/branches").json()["total"] == 0
    assert owner_client.get("/settings/branches?include_archived=true").json()["total"] == 1


def test_settings_need_access(user_client):
    c = user_client("settings.view")
    assert c.get("/settings/branches").status_code == 200
    assert c.post("/settings/branches", json={"code": "X", "name": "X"}).status_code == 403


def test_seeded_units_convert(db):
    assert convert(db, Decimal("2.5"), "kg", "g") == Decimal("2500")
    assert convert(db, Decimal("500"), "ml", "l") == Decimal("0.5")


def test_default_tax_rate_switch(owner_client):
    rates = owner_client.get("/settings/tax-rates").json()["items"]
    no_tax = next(r for r in rates if r["name"] == "No tax")
    owner_client.post(f"/settings/tax-rates/{no_tax['id']}/make-default")
    defaults = [r for r in owner_client.get("/settings/tax-rates").json()["items"] if r["is_default"]]
    assert [r["name"] for r in defaults] == ["No tax"]


def test_numbering_settings(owner_client):
    seqs = {s["doc_type"]: s for s in owner_client.get("/settings/numbering").json()}
    assert seqs["invoice"]["preview"].startswith("INV-")
    r = owner_client.patch("/settings/numbering/invoice", json={"prefix": "TAY-", "yearly_reset": False,
                                                                "next_value": 100})
    assert r.json()["preview"] == "TAY-00100"
    assert owner_client.patch("/settings/numbering/invoice", json={"next_value": 5}).status_code == 422


def test_period_dates_validated(owner_client):
    r = owner_client.post("/settings/periods", json={"name": "FY", "start_date": "2026-07-01",
                                                     "end_date": "2026-06-30"})
    assert r.status_code == 422
