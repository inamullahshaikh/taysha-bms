import pytest

from tests.conftest import login
from tests.test_inventory import receive
from tests.test_orders import order_body
from tests.test_products import make_product, price_list, unit_id

pytestmark = pytest.mark.usefixtures("approvals_required")  # these tests cover the approval workflow


def acct(c, code):
    return next(a for a in c.get("/accounting/accounts?page_size=200").json()["items"] if a["code"] == code)


def bal(c, code, **params):
    tb = c.get("/accounting/trial-balance", params=params).json()
    row = next((r for r in tb["rows"] if r["code"] == code), None)
    return row and row["balance"]


@pytest.fixture
def books(owner_client, make_user):
    c = owner_client
    make_user("approver@example.com", access=("purchasing.view", "purchasing.approve", "accounting.view",
                                               "accounting.approve", "expenses.view", "expenses.approve"))
    wh = c.post("/warehouses", json={"code": "MAIN", "name": "Main"}).json()["id"]
    cake = make_product(c, "MUG-1", name="Mug cake")
    c.post(f"/products/{cake['id']}/prices", json={"price_list_id": price_list(c), "price": "1180"})
    cust = c.post("/customers", json={"name": "Hina"}).json()
    sup = c.post("/suppliers", json={"name": "Packaging Co"}).json()
    return {"c": c, "wh": wh, "cake": cake, "cust": cust, "sup": sup}


def as_user(c, email):
    c.post("/auth/logout")
    login(c, email)


def test_full_cycle_balances(books):
    c, wh = books["c"], books["wh"]
    # buy 10 cakes at 400 + 18% tax, receive, bill, pay
    po = c.post("/purchase-orders", json={"supplier_id": books["sup"]["id"], "lines": [
        {"product_id": books["cake"]["id"], "quantity": "10", "unit_cost": "400", "tax_rate": "18"}]}).json()
    c.post(f"/purchase-orders/{po['id']}/submit")
    as_user(c, "approver@example.com")
    c.post(f"/purchase-orders/{po['id']}/approve", json={})
    as_user(c, "owner@example.com")
    c.post(f"/purchase-orders/{po['id']}/receive", json={"lines": [{"po_line_id": po["lines"][0]["id"],
                                                                    "quantity": "10"}]})
    bill = c.post(f"/purchase-orders/{po['id']}/bill", json={"supplier_invoice_number": "PC-1"}).json()
    c.post(f"/supplier-bills/{bill['id']}/payments", json={"method": "bank_transfer", "amount": bill["grand_total"]})
    # sell 2, ship, get paid in cash
    o = c.post("/orders", json={**order_body({"customer": books["cust"], "product": books["cake"]}, confirm=True),
                                "delivery_method": "pickup"}).json()
    c.post(f"/orders/{o['id']}/status", json={"status": "delivered"})
    c.post(f"/orders/{o['id']}/payments", json={"method": "cash", "amount": o["grand_total"]})
    # an approved expense paid by bank
    cat = c.post("/expense-categories", json={"name": "Rent"}).json()["id"]
    e = c.post("/expenses", json={"category_id": cat, "description": "Rent", "amount": "5000",
                                  "payment_method": "bank_transfer"}).json()
    as_user(c, "approver@example.com")
    c.post(f"/expenses/{e['id']}/approve", json={})
    as_user(c, "owner@example.com")

    tb = c.get("/accounting/trial-balance").json()
    assert tb["balanced"] and tb["total_debit"] == tb["total_credit"]
    assert bal(c, "1200") == "3200.00"  # 8 cakes left at 400
    assert bal(c, "5000") == "800.00"  # COGS 2 x 400
    assert bal(c, "4000") == "2000.00" and bal(c, "2100") == "360.00"  # sale excl. tax, output tax
    assert bal(c, "1300") == "720.00"  # input tax on the bill
    assert bal(c, "2010") == "0.00" and bal(c, "2000") == "0.00"  # GRNI cleared by bill, bill paid
    assert bal(c, "1100") == "0.00" and bal(c, "1000") == "2360.00"
    assert bal(c, "1010") == "-9720.00"  # 4720 bill + 5000 rent out of the bank
    pl = c.get("/accounting/profit-loss").json()
    assert pl["income"] == "2000.00" and pl["gross_profit"] == "1200.00" and pl["net_profit"] == "-3800.00"
    bs = c.get("/accounting/balance-sheet").json()
    assert bs["balanced"]
    tax = c.get("/accounting/tax").json()
    assert tax["output_tax"] == "360.00" and tax["input_tax"] == "720.00" and tax["net_payable"] == "-360.00"
    cf = c.get("/accounting/cash-flow").json()
    assert cf["closing_cash"] == "-7360.00" and cf["operating"]["total"] == "-7360.00"
    led = c.get(f"/accounting/ledger/{acct(c, '1000')['id']}").json()
    assert led["closing_balance"] == "2360.00"
    assert c.post("/accounting/sync").json() == {k: 0 for k in ("orders", "documents", "returns", "payments",
                                                                "stock", "production", "bills", "expenses")}


def test_invoice_paperwork_and_standalone_invoice_and_credit(books):
    c = books["c"]
    receive(c, books["wh"], books["cake"]["id"], 5, cost=400)
    s = {"customer": books["cust"], "product": books["cake"]}
    o = c.post("/orders", json={**order_body(s, confirm=True), "delivery_method": "pickup"}).json()
    c.post(f"/orders/{o['id']}/status", json={"status": "delivered"})
    inv = c.post(f"/orders/{o['id']}/documents", json={"doc_type": "invoice"}).json()
    c.post(f"/documents/{inv['id']}/issue")
    assert bal(c, "4000") == "2000.00"  # the order's sale only, invoice adds nothing
    d = c.post("/documents", json={"customer_id": books["cust"]["id"], "lines": [
        {"description": "Catering", "quantity": "1", "unit_price": "5000", "tax_rate": "0"}]}).json()
    c.post(f"/documents/{d['id']}/issue")
    assert bal(c, "4000") == "7000.00" and bal(c, "1100") == "7360.00"
    cn = c.post(f"/documents/{d['id']}/credit-note", json={"reason": "discount agreed"}).json()
    c.post(f"/documents/{cn['id']}/issue")
    assert bal(c, "4020") == "-5000.00" and bal(c, "1100") == "2360.00"
    assert c.get("/accounting/trial-balance").json()["balanced"]


def test_cancelled_invoice_reverses(books):
    c = books["c"]
    d = c.post("/documents", json={"customer_id": books["cust"]["id"], "lines": [
        {"description": "Event", "quantity": "1", "unit_price": "1000", "tax_rate": "0"}]}).json()
    c.post(f"/documents/{d['id']}/issue")
    assert bal(c, "4000") == "1000.00"
    c.post(f"/documents/{d['id']}/cancel", json={"reason": "wrong customer"})
    assert bal(c, "4000") == "0.00"


def test_manual_entry_needs_second_person_and_closed_periods(books):
    c = books["c"]
    capital, bank = acct(c, "3000"), acct(c, "1010")
    e = c.post("/accounting/journal", json={"entry_date": "2026-11-01", "memo": "Partner capital",
                                            "lines": [{"account_id": bank["id"], "debit": "100000"},
                                                      {"account_id": capital["id"], "credit": "100000"}]}).json()
    assert e["status"] == "draft" and e["number"] is None
    assert c.post(f"/accounting/journal/{e['id']}/approve").json()["code"] == "own_entry"
    assert c.post("/accounting/journal", json={"entry_date": "2026-11-01", "memo": "bad", "lines": [
        {"account_id": bank["id"], "debit": "1"}, {"account_id": capital["id"], "credit": "2"}]}).status_code == 422
    as_user(c, "approver@example.com")
    assert c.post(f"/accounting/journal/{e['id']}/approve").json()["status"] == "posted"
    as_user(c, "owner@example.com")
    assert bal(c, "3000") == "100000.00"
    c.post("/settings/periods", json={"name": "Oct 2026", "start_date": "2026-10-01", "end_date": "2026-10-31"})
    pid = c.get("/settings/periods").json()["items"][0]["id"]
    c.patch(f"/settings/periods/{pid}", json={"is_closed": True})
    r = c.post("/accounting/journal", json={"entry_date": "2026-10-15", "memo": "late", "lines": [
        {"account_id": bank["id"], "debit": "1"}, {"account_id": capital["id"], "credit": "1"}]})
    assert r.status_code == 409 and r.json()["code"] == "period_closed"


def test_budget_hard_limit(books, client):
    c = books["c"]
    cat = c.post("/expense-categories", json={"name": "Travel"}).json()["id"]
    b = c.post("/budgets", json={"name": "Nov", "period_start": "2026-11-01", "period_end": "2026-11-30"}).json()
    c.put(f"/budgets/{b['id']}/lines", json=[{"category_id": cat, "amount": "1000", "hard_limit": True}])
    e = c.post("/expenses", json={"category_id": cat, "description": "Taxi", "amount": "1500",
                                  "expense_date": "2026-11-10"}).json()
    as_user(c, "approver@example.com")
    r = c.post(f"/expenses/{e['id']}/approve", json={})
    assert r.status_code == 409 and r.json()["code"] == "over_budget"
    as_user(c, "owner@example.com")
    vs = c.get(f"/budgets/{b['id']}/vs-actual").json()
    assert vs["lines"][0]["actual"] == "0" and vs["lines"][0]["remaining"] == "1000.00"


def test_stock_writeoff_posts(books):
    c, wh = books["c"], books["wh"]
    flour = make_product(c, "RAW-F", name="Flour", type="raw", unit_id=unit_id(c, "g"), track_batches=False)
    receive(c, wh, flour["id"], 1000, cost=1)
    c.post("/stock/issue", json={"warehouse_id": wh, "reason": "wastage", "note": "spilled",
                                 "lines": [{"product_id": flour["id"], "quantity": "100"}]})
    assert bal(c, "1200") == "900.00" and bal(c, "5010") == "100.00" and bal(c, "4910") == "1000.00"
