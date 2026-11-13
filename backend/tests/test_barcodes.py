from tests.test_inventory import inv, receive  # noqa: F401
from tests.test_products import make_product


def test_lookup_product_pack_batch_location(inv):  # noqa: F811
    c, wh = inv["c"], inv["wh"]
    p = make_product(c, "EAN-1", name="Brownie", barcode="4006381333931")
    c.put(f"/products/{p['id']}/units", json=[{"name": "box", "factor": "6", "barcode": "96385074"}])
    assert c.get("/barcodes/lookup?code=4006381333931").json()["type"] == "product"
    assert c.get("/barcodes/lookup?code=EAN-1").json()["product_id"] == p["id"]  # SKU works too
    assert c.get("/barcodes/lookup?code=96385074").json()["type"] == "pack"
    receive(c, wh, p["id"], 5, batch="LOT-9", expiry="2027-03-01")
    batch = c.get(f"/stock/batches?product_id={p['id']}").json()["items"][0]
    assert c.get(f"/barcodes/lookup?code=B{batch['id']}").json()["batch"] == "LOT-9"
    loc = c.post(f"/stock/warehouses/{wh}/locations", json={"code": "A-01"}).json()
    assert c.get(f"/barcodes/lookup?code=L{loc['id']}").json()["code"] == "A-01"
    assert c.get("/barcodes/lookup?code=nothing").status_code == 404


def test_images_and_label_pdfs(inv):  # noqa: F811
    c = inv["c"]
    p = make_product(c, "EAN-2", name="Mug", barcode="4006381333931")
    r = c.get("/barcodes/image?value=4006381333931&symbology=ean13")
    assert r.headers["content-type"].startswith("image/svg") and b"<svg" in r.content
    assert b"<svg" in c.get("/barcodes/image?value=https://taysha.pk&symbology=qr").content
    for layout in ("a4_3x8", "thermal_50x25"):
        r = c.post("/labels", json={"kind": "product", "items": [{"id": p["id"], "copies": 3}], "layout": layout,
                                    "show_price": True})
        assert r.status_code == 200 and r.content.startswith(b"%PDF")
