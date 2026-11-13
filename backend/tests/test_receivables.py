from datetime import timedelta

from app.clock import local_today
from app.documents.models import SalesDocument
from tests.test_inventory import inv, receive  # noqa: F401
from tests.test_orders import order_body, setup  # noqa: F401


def issued_invoice(s, db, days_overdue=0):
    c = s["c"]
    o = c.post("/orders", json=order_body(s, confirm=True)).json()
    inv_doc = c.post(f"/orders/{o['id']}/documents", json={"doc_type": "invoice"}).json()
    inv_doc = c.post(f"/documents/{inv_doc['id']}/issue").json()
    if days_overdue:
        d = db.get(SalesDocument, inv_doc["id"])
        d.due_date = local_today() - timedelta(days=days_overdue)
        db.flush()
    return inv_doc


def test_aging_buckets(setup, db):  # noqa: F811
    issued_invoice(setup, db)
    issued_invoice(setup, db, days_overdue=45)
    a = setup["c"].get("/reports/receivables-aging").json()
    row = a["rows"][0]
    assert row["current"] == "2360.00" and row["31_60"] == "2360.00" and row["total"] == "4720.00"
    assert setup["c"].get("/reports/receivables-aging?format=xlsx").content[:2] == b"PK"


def test_statement_and_on_account_allocation(setup, db):  # noqa: F811
    c, cid = setup["c"], setup["customer"]["id"]
    inv_doc = issued_invoice(setup, db)
    pay = c.post(f"/customers/{cid}/payments", json={"method": "bank_transfer", "amount": "1000"}).json()
    assert len(c.get(f"/customers/{cid}/unallocated-payments").json()) == 1
    st = c.get(f"/customers/{cid}/statement").json()
    assert st["closing_balance"] == "1360.00" and [ln["type"] for ln in st["lines"]] == ["invoice", "payment"]
    r = c.post(f"/payments/{pay['id']}/allocate", json={"invoice_id": inv_doc["id"]})
    assert r.status_code == 200
    assert c.get(f"/documents/{inv_doc['id']}").json()["status"] == "partially_paid"
    assert c.post(f"/payments/{pay['id']}/allocate", json={"invoice_id": inv_doc["id"]}).status_code == 409
    assert c.get(f"/customers/{cid}/statement?format=pdf").content.startswith(b"%PDF")


def test_payables_aging_and_dashboard_sections(inv):  # noqa: F811
    c, wh, pid = inv["c"], inv["wh"], inv["product"]["id"]
    receive(c, wh, pid, 4, cost=300, batch="B1")
    c.put("/stock/rules", json={"product_id": pid, "warehouse_id": wh, "reorder_point": "5"})
    sup = c.post("/suppliers", json={"name": "Box Co"}).json()
    c.post("/supplier-bills", json={"supplier_id": sup["id"], "lines": [{"description": "Boxes", "quantity": "100",
                                                                         "unit_cost": "20"}]})
    assert c.get("/reports/payables-aging").json()["totals"]["total"] == "2000.00"
    d = c.get("/dashboard").json()
    assert d["inventory"]["low_stock"] == 1 and d["inventory"]["valuation"] == "1200.00"
    assert d["purchasing"]["outstanding_payables"] == "2000.00" and d["purchasing"]["total_suppliers"] == 1
