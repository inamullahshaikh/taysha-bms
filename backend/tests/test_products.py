from datetime import timedelta
from decimal import Decimal

from app.clock import local_today
from app.products.pricing import split_tax, valid_gtin


def lookups(c):
    return c.get("/lookups").json()


def unit_id(c, code="pcs"):
    return next(u["id"] for u in lookups(c)["units"] if u["code"] == code)


def price_list(c, code="retail"):
    return next(p["id"] for p in lookups(c)["price_lists"] if p["code"] == code)


def make_product(c, sku="MUG-001", **kw):
    body = {"sku": sku, "name": kw.pop("name", "Choc Mug Cake"), "unit_id": unit_id(c), **kw}
    r = c.post("/products", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def test_tax_maths_and_gtin():
    assert split_tax(Decimal("1180"), Decimal("18")) == (Decimal("1000.00"), Decimal("180.00"))
    assert split_tax(Decimal("999"), Decimal("18")) == (Decimal("846.61"), Decimal("152.39"))
    assert valid_gtin("4006381333931") and not valid_gtin("4006381333932")


def test_create_search_filter(owner_client):
    make_product(owner_client, channels=["shopify", "pos"])
    make_product(owner_client, "RAW-COCOA", name="Cocoa powder", type="raw")
    assert owner_client.get("/products?q=cocoa").json()["total"] == 1
    assert owner_client.get("/products?type=raw").json()["items"][0]["sku"] == "RAW-COCOA"
    assert owner_client.get("/products?channel=pos").json()["total"] == 1
    assert owner_client.post("/products", json={"sku": "MUG-001", "name": "x", "unit_id": unit_id(owner_client)}
                             ).status_code == 409
    assert owner_client.post("/products", json={"sku": "Z", "name": "x", "unit_id": unit_id(owner_client),
                                                "channels": ["tiktok"]}).status_code == 422


def test_barcodes(owner_client):
    p = make_product(owner_client, barcode="4006381333931")
    assert owner_client.get("/products/lookup?barcode=4006381333931").json()["id"] == p["id"]
    r = owner_client.post("/products", json={"sku": "B2", "name": "x", "unit_id": unit_id(owner_client),
                                             "barcode": "4006381333932"})
    assert r.status_code == 422  # bad check digit
    r = owner_client.post("/products", json={"sku": "B3", "name": "x", "unit_id": unit_id(owner_client),
                                             "barcode": "4006381333931"})
    assert r.status_code == 409
    # pack-size barcode is also unique against product barcodes and resolves to the product
    r = owner_client.put(f"/products/{p['id']}/units", json=[{"name": "carton", "factor": "24",
                                                               "barcode": "96385074"}])
    assert r.status_code == 200
    assert owner_client.get("/products/lookup?barcode=96385074").json()["id"] == p["id"]


def test_variants_and_bundles(owner_client):
    parent = make_product(owner_client, "MUG", name="Mug cake")
    v = make_product(owner_client, "MUG-250", parent_id=parent["id"], variant_attributes={"size": "250 g"})
    assert owner_client.get(f"/products?parent_id={parent['id']}").json()["total"] == 1
    r = owner_client.post("/products", json={"sku": "X", "name": "x", "unit_id": unit_id(owner_client),
                                             "parent_id": v["id"]})
    assert r.status_code == 422  # no variants of variants

    box = make_product(owner_client, "BOX", kind="bundle", name="Gift box")
    r = owner_client.put(f"/products/{box['id']}/components", json=[{"component_id": v["id"], "quantity": "3"}])
    assert r.json()[0]["sku"] == "MUG-250"
    assert owner_client.put(f"/products/{v['id']}/components", json=[]).status_code == 422  # not a bundle


def test_price_history_and_resolution(owner_client):
    p = make_product(owner_client)
    retail = price_list(owner_client)
    today = local_today()
    owner_client.post(f"/products/{p['id']}/prices", json={"price_list_id": retail, "price": "1200"})
    later = (today + timedelta(days=10)).isoformat()
    owner_client.post(f"/products/{p['id']}/prices", json={"price_list_id": retail, "price": "1350",
                                                            "effective_from": later})
    assert owner_client.get(f"/products/{p['id']}/price?price_list=retail").json()["price"] == "1200.00"
    assert owner_client.get(f"/products/{p['id']}/price?price_list=retail&on={later}").json()["price"] == "1350.00"
    assert len(owner_client.get(f"/products/{p['id']}/prices").json()["history"]) == 2
    past = (today - timedelta(days=1)).isoformat()
    r = owner_client.post(f"/products/{p['id']}/prices", json={"price_list_id": retail, "price": "1",
                                                               "effective_from": past})
    assert r.status_code == 422


def test_costs_and_margins_need_cost_access(owner_client, client, make_user):
    p = make_product(owner_client)
    owner_client.post(f"/products/{p['id']}/prices", json={"price_list_id": price_list(owner_client),
                                                            "price": "1180"})
    owner_client.post(f"/products/{p['id']}/costs", json={"materials": "400", "packaging": "100"})
    m = owner_client.get(f"/products/{p['id']}/margins").json()
    retail = next(x for x in m["price_lists"] if x["price_list"] == "retail")
    assert retail["net_price"] == "1000.00" and retail["margin"] == "500.00" and retail["margin_pct"] == "50.00"
    assert owner_client.get(f"/products/{p['id']}/margins?price=2360").json()["what_if"]["margin"] == "1500.00"

    owner_client.post("/auth/logout")
    make_user("sales@example.com", access=("products.view",))
    client.post("/auth/login", json={"email": "sales@example.com", "password": "password123"})
    assert client.get(f"/products/{p['id']}").status_code == 200
    assert client.get(f"/products/{p['id']}/costs").status_code == 403
    assert client.get(f"/products/{p['id']}/margins").status_code == 403
    assert client.post(f"/products/{p['id']}/prices", json={"price_list_id": 1, "price": "1"}).status_code == 403


def test_archive_hides_but_keeps(owner_client):
    p = make_product(owner_client)
    owner_client.post(f"/products/{p['id']}/archive")
    assert owner_client.get("/products").json()["total"] == 0
    assert owner_client.get(f"/products/{p['id']}").status_code == 200
