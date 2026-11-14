from datetime import date

from app.assets import depreciate
from tests.test_accounting import bal


def test_asset_purchase_depreciation_disposal(owner_client, db):
    c = owner_client
    oven = c.post("/assets", json={"asset_code": "EQ-001", "name": "Deck oven", "category": "equipment",
                                   "purchase_date": "2026-01-15", "cost": "240000", "useful_life_months": 24,
                                   "record_purchase": "bank_transfer", "warranty_until": "2027-01-15"}).json()
    assert oven["monthly_depreciation"] == "10000.00"
    assert depreciate(db, date(2026, 4, 10)) == "3 depreciation entries"  # Jan, Feb, Mar
    assert depreciate(db, date(2026, 4, 10)) == "0 depreciation entries"  # idempotent
    a = c.get(f"/assets/{oven['id']}").json()
    assert a["accumulated_depreciation"] == "30000.00" and a["book_value"] == "210000.00"
    c.post("/asset-maintenance", json={"asset_id": oven["id"], "kind": "repair", "record_date": "2026-03-01",
                                       "description": "Thermostat replaced", "cost": "8000", "downtime_hours": "6",
                                       "next_due_date": "2026-09-01"})
    assert c.get(f"/assets/{oven['id']}/maintenance").json()[0]["downtime_hours"] == "6.00"
    d = c.post(f"/assets/{oven['id']}/dispose", json={"disposed_on": "2026-04-30", "proceeds": "200000"}).json()
    assert d["status"] == "disposed" and d["book_value"] == "200000.00"  # April depreciation posted first
    assert bal(c, "1400") == "0.00" and bal(c, "1410") == "0.00"
    assert c.get("/accounting/trial-balance").json()["balanced"]
    assert c.get("/assets").json()["total_cost"] == "240000.00"
