from tests.test_products import make_product


def test_supplier_contacts_items(owner_client):
    s = owner_client.post("/suppliers", json={"name": "Cocoa Traders", "city": "Karachi",
                                              "payment_terms_days": 30}).json()
    assert owner_client.get("/suppliers?city=Karachi").json()["total"] == 1
    r = owner_client.put(f"/suppliers/{s['id']}/contacts", json=[{"name": "Bilal", "phone": "0300 1112223"}])
    assert r.json()[0]["phone"] == "03001112223"
    p = make_product(owner_client, "RAW-COCOA", type="raw")
    r = owner_client.put(f"/suppliers/{s['id']}/items", json=[{"product_id": p["id"], "lead_time_days": 5,
                                                                "min_order_qty": "25", "is_preferred": True}])
    assert r.json()[0]["product_sku"] == "RAW-COCOA"
    assert owner_client.get(f"/products/{p['id']}/suppliers").json()[0]["lead_time_days"] == 5


def test_supplier_documents(owner_client):
    s = owner_client.post("/suppliers", json={"name": "Box Co"}).json()
    r = owner_client.post(f"/attachments?entity_type=suppliers&entity_id={s['id']}&category=agreement",
                          files={"file": ("agreement.pdf", b"%PDF", "application/pdf")})
    assert r.status_code == 201
