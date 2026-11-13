from unittest.mock import patch

from app.config import settings
from tests.test_orders import order_body, setup  # noqa: F401  (fixture)


def confirmed_order(s, **kw):
    return s["c"].post("/orders", json=order_body(s, confirm=True, **kw)).json()


def invoice_for(s, order):
    r = s["c"].post(f"/orders/{order['id']}/documents", json={"doc_type": "invoice"})
    assert r.status_code == 201, r.text
    return r.json()


def test_invoice_from_order_issue_and_lock(setup):  # noqa: F811
    c = setup["c"]
    o = confirmed_order(setup)
    inv = invoice_for(setup, o)
    assert inv["status"] == "draft" and inv["number"] is None and inv["grand_total"] == o["grand_total"]
    assert c.post(f"/orders/{o['id']}/documents", json={"doc_type": "invoice"}).status_code == 409  # one per order
    issued = c.post(f"/documents/{inv['id']}/issue").json()
    assert issued["number"].startswith("INV-") and issued["status"] == "issued" and issued["due_date"]
    body = {"lines": [{"product_id": setup["product"]["id"], "quantity": "1"}]}
    assert c.put(f"/documents/{inv['id']}", json=body).status_code == 409  # issued = frozen
    assert c.get(f"/documents/{inv['id']}/pdf").content.startswith(b"%PDF")


def test_order_payments_flow_into_invoice(setup):  # noqa: F811
    c = setup["c"]
    o = confirmed_order(setup)  # 2360
    inv = c.post(f"/documents/{invoice_for(setup, o)['id']}/issue").json()
    c.post(f"/orders/{o['id']}/payments", json={"method": "cash", "amount": "1000"})
    assert c.get(f"/documents/{inv['id']}").json()["status"] == "partially_paid"
    r = c.post(f"/documents/{inv['id']}/payments", json={"method": "bank_transfer", "amount": "1360"})
    assert r.status_code == 201
    assert c.get(f"/documents/{inv['id']}").json()["status"] == "paid"
    assert c.get(f"/orders/{o['id']}").json()["payment_status"] == "paid"
    receipt = c.post(f"/payments/{r.json()['id']}/receipt").json()
    assert receipt["number"].startswith("RCT-") and receipt["grand_total"] == "1360.00"
    assert c.post(f"/payments/{r.json()['id']}/receipt").json()["id"] == receipt["id"]  # reused
    assert c.get(f"/documents/{receipt['id']}/pdf").content.startswith(b"%PDF")


def test_full_and_partial_credit_notes(setup):  # noqa: F811
    c = setup["c"]
    inv = c.post(f"/documents/{invoice_for(setup, confirmed_order(setup))['id']}/issue").json()
    line_id = c.get(f"/documents/{inv['id']}").json()["lines"][0]["id"]
    cn = c.post(f"/documents/{inv['id']}/credit-note",
                json={"reason": "1 damaged", "lines": [{"line_id": line_id, "quantity": "1"}]}).json()
    assert cn["grand_total"] == "1180.00" and cn["tax_total"] == "180.00"
    c.post(f"/documents/{cn['id']}/issue")
    after = c.get(f"/documents/{inv['id']}").json()
    assert after["credited_total"] == "1180.00" and after["balance_due"] == "1180.00"
    r = c.post(f"/documents/{inv['id']}/credit-note", json={"reason": "all"})
    assert r.status_code == 422  # partly credited -> must pick lines

    inv2 = c.post(f"/documents/{invoice_for(setup, confirmed_order(setup))['id']}/issue").json()
    cn2 = c.post(f"/documents/{inv2['id']}/credit-note", json={"reason": "cancelled sale"}).json()
    c.post(f"/documents/{cn2['id']}/issue")
    assert c.get(f"/documents/{inv2['id']}").json()["status"] == "credited"


def test_quotation_to_order(setup):  # noqa: F811
    c = setup["c"]
    q = c.post("/documents", json={"doc_type": "quotation", "customer_id": setup["customer"]["id"],
                                   "lines": [{"product_id": setup["product"]["id"], "quantity": "10",
                                              "discount_pct": "5"}]}).json()
    assert q["grand_total"] == "11210.00"
    c.post(f"/documents/{q['id']}/issue")
    c.post(f"/documents/{q['id']}/quote-status", json={"status": "accepted"})
    r = c.post(f"/documents/{q['id']}/convert-to-order").json()
    o = c.get(f"/orders/{r['order_id']}").json()
    assert o["grand_total"] == "11210.00" and o["status"] == "draft"
    assert c.get(f"/documents/{q['id']}").json()["status"] == "converted"


def test_standalone_invoice_with_free_text_and_charges(setup):  # noqa: F811
    c = setup["c"]
    d = c.post("/documents", json={
        "customer_name": "Event Co", "lines": [{"description": "Catering setup", "quantity": "1",
                                               "unit_price": "5000", "tax_rate": "0"}],
        "delivery_charge": "300", "other_charges": [{"label": "Packaging", "amount": "150"}]}).json()
    assert d["grand_total"] == "5450.00" and d["tax_total"] == "0.00"


def test_cancel_rules(setup):  # noqa: F811
    c = setup["c"]
    o = confirmed_order(setup)
    inv = c.post(f"/documents/{invoice_for(setup, o)['id']}/issue").json()
    c.post(f"/orders/{o['id']}/payments", json={"method": "cash", "amount": "100"})
    assert c.post(f"/documents/{inv['id']}/cancel", json={"reason": "x"}).status_code == 409


def test_overdue_job(setup, db):  # noqa: F811
    from datetime import timedelta

    from app.clock import local_today
    from app.documents.models import SalesDocument
    from app.documents.service import mark_overdue

    c = setup["c"]
    inv = c.post(f"/documents/{invoice_for(setup, confirmed_order(setup))['id']}/issue").json()
    doc = db.get(SalesDocument, inv["id"])
    doc.due_date = local_today() - timedelta(days=1)
    db.flush()
    assert mark_overdue(db) == 1 and doc.status == "overdue"
    assert mark_overdue(db) == 0  # idempotent


def test_email_invoice(setup):  # noqa: F811
    c = setup["c"]
    c.patch(f"/customers/{setup['customer']['id']}", json={"email": "hina@example.com"})
    inv = c.post(f"/documents/{invoice_for(setup, confirmed_order(setup))['id']}/issue").json()
    with patch.object(settings, "smtp_host", "smtp.test"), patch("smtplib.SMTP") as smtp:
        assert c.post(f"/documents/{inv['id']}/email", json={}).status_code == 204
        sent = smtp.return_value.__enter__.return_value.send_message.call_args[0][0]
        assert sent["To"] == "hina@example.com" and inv["number"] in sent["Subject"]
    history = c.get(f"/audit?entity_type=sales_documents&entity_id={inv['id']}").json()
    assert any(h["action"] == "email" for h in history)
