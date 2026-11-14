import pytest

from tests.conftest import login
from tests.test_inventory import bal
from tests.test_products import make_product, unit_id

pytestmark = pytest.mark.usefixtures("approvals_required")  # these tests cover the approval workflow


@pytest.fixture
def pur(owner_client):
    c = owner_client
    wh = c.post("/warehouses", json={"code": "MAIN", "name": "Main"}).json()["id"]
    sup = c.post("/suppliers", json={"name": "Cocoa Traders", "payment_terms_days": 30}).json()
    cocoa = make_product(c, "RAW-COCOA", name="Cocoa", type="raw", unit_id=unit_id(c, "g"), shelf_life_days=365)
    return {"c": c, "wh": wh, "sup": sup, "cocoa": cocoa}


@pytest.fixture
def approver(make_user):
    make_user("approver@example.com", access=("purchasing.view", "purchasing.approve"))


def make_po(c, s, qty="5", cost="2000", unit="kg", tax="18"):
    line = {"product_id": s["cocoa"]["id"], "quantity": qty, "unit": unit, "tax_rate": tax}
    if cost is not None:
        line["unit_cost"] = cost
    r = c.post("/purchase-orders", json={"supplier_id": s["sup"]["id"], "lines": [line]})
    assert r.status_code == 201, r.text
    return r.json()


def as_user(c, email):
    c.post("/auth/logout")
    login(c, email)


def approved_po(c, s, **kw):
    po = make_po(c, s, **kw)
    c.post(f"/purchase-orders/{po['id']}/submit")
    as_user(c, "approver@example.com")
    r = c.post(f"/purchase-orders/{po['id']}/approve", json={})
    assert r.status_code == 200, r.text
    as_user(c, "owner@example.com")
    return r.json()


def test_po_totals_and_approval_rules(pur, approver):
    c = pur["c"]
    po = make_po(c, pur)
    assert po["subtotal"] == "10000.00" and po["tax_total"] == "1800.00" and po["grand_total"] == "11800.00"
    assert po["lines"][0]["base_quantity"] == "5000.000"
    c.post(f"/purchase-orders/{po['id']}/submit")
    assert c.post(f"/purchase-orders/{po['id']}/approve", json={}).json()["code"] == "own_request"
    c.patch("/settings/company", json={"purchase_approval_limit": "5000"})
    as_user(c, "approver@example.com")
    assert c.post(f"/purchase-orders/{po['id']}/approve", json={}).json()["code"] == "over_limit"


def test_receive_updates_stock_cost_batches_and_status(pur, approver):
    c = pur["c"]
    po = approved_po(c, pur)
    c.post(f"/purchase-orders/{po['id']}/send")
    line = po["lines"][0]["id"]
    g = c.post(f"/purchase-orders/{po['id']}/receive", json={"lines": [
        {"po_line_id": line, "quantity": "2", "supplier_batch_no": "SUP-77", "mfg_date": "2026-11-01"}]}).json()
    assert c.get(f"/purchase-orders/{po['id']}").json()["status"] == "partially_received"
    b = bal(c, pur["cocoa"]["id"], pur["wh"])
    assert b["on_hand"] == "2000.000" and b["avg_cost"] == "2.0000"  # 2000 per kg excl. tax = 2.00 per g
    batch = c.get(f"/stock/batches?product_id={pur['cocoa']['id']}").json()["items"][0]
    assert batch["supplier_batch_no"] == "SUP-77" and batch["expiry_date"] == "2027-11-01"
    r = c.post(f"/purchase-orders/{po['id']}/receive", json={"lines": [{"po_line_id": line, "quantity": "4"}]})
    assert r.status_code == 422  # more than ordered
    c.post(f"/purchase-orders/{po['id']}/receive", json={"lines": [{"po_line_id": line, "quantity": "3",
                                                                    "batch_number": "LOT2", "qc_result": "fail"}]})
    assert c.get(f"/purchase-orders/{po['id']}").json()["status"] == "received"
    b = bal(c, pur["cocoa"]["id"], pur["wh"])
    assert b["on_hand"] == "5000.000" and b["available"] == "2000.000"  # failed QC batch is not usable
    assert g["number"].startswith("GRN-")


def test_bill_from_received_and_payments(pur, approver):
    c = pur["c"]
    po = approved_po(c, pur)
    line = po["lines"][0]["id"]
    c.post(f"/purchase-orders/{po['id']}/receive", json={"lines": [{"po_line_id": line, "quantity": "2"}]})
    bill = c.post(f"/purchase-orders/{po['id']}/bill", json={"supplier_invoice_number": "CT-991",
                                                             "withholding_tax": "100"}).json()
    assert bill["grand_total"] == "4720.00" and bill["balance_due"] == "4620.00" and bill["due_date"]
    assert c.post(f"/purchase-orders/{po['id']}/bill", json={}).status_code == 422  # nothing left to bill
    assert c.post(f"/supplier-bills/{bill['id']}/payments", json={"method": "bank_transfer",
                                                                  "amount": "5000"}).status_code == 422
    c.post(f"/supplier-bills/{bill['id']}/payments", json={"method": "bank_transfer", "amount": "4620"})
    assert c.get(f"/supplier-bills/{bill['id']}").json()["status"] == "paid"


def test_request_to_po_and_price_changes(pur, approver):
    c = pur["c"]
    r = c.post("/purchase-requests", json={"lines": [{"product_id": pur["cocoa"]["id"], "quantity": "10",
                                                      "unit": "kg", "estimated_unit_cost": "2100",
                                                      "suggested_supplier_id": pur["sup"]["id"]}]}).json()
    as_user(c, "approver@example.com")
    assert c.post(f"/purchase-requests/{r['id']}/approve", json={}).json()["status"] == "approved"
    as_user(c, "owner@example.com")
    pos = c.post(f"/purchase-requests/{r['id']}/convert", json={}).json()
    assert len(pos) == 1 and pos[0]["status"] == "approved" and pos[0]["purchase_request_id"] == r["id"]
    make_po(c, pur, qty="1", cost="2500")
    changes = c.get("/purchasing/price-changes").json()
    assert changes[0]["change_pct"] == "19.0"
    po3 = make_po(c, pur, qty="1", cost=None)  # no cost given: last price from this supplier
    assert po3["lines"][0]["unit_cost"] == "2500.0000"


def test_po_pdf_and_performance(pur, approver):
    c = pur["c"]
    po = approved_po(c, pur)
    assert c.get(f"/purchase-orders/{po['id']}/pdf").content.startswith(b"%PDF")
    c.post(f"/purchase-orders/{po['id']}/receive", json={"lines": [{"po_line_id": po["lines"][0]["id"],
                                                                    "quantity": "5"}]})
    c.post(f"/suppliers/{pur['sup']['id']}/ratings", json={"price": 4, "quality": 5, "delivery": 3, "reliability": 4})
    perf = c.get(f"/suppliers/{pur['sup']['id']}/performance").json()
    assert perf["orders_received"] == 1 and perf["qc_pass_pct"] == "100.0" and perf["ratings"]["quality"] == "5.0"
