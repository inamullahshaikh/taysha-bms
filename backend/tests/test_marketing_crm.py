from app.clock import local_today
from app.crm import award_points
from app.notifications import check_alerts
from tests.test_orders import order_body, setup  # noqa: F401


def test_campaign_attribution_cac_roas(setup):  # noqa: F811
    c = setup["c"]
    code = c.post("/discount-codes", json={"code": "INSTA10", "kind": "percent", "value": "10"}).json()
    camp = c.post("/campaigns", json={"name": "Eid Insta", "platform": "meta", "budget": "20000",
                                      "discount_code_id": code["id"], "start_date": str(local_today())}).json()
    c.put(f"/campaigns/{camp['id']}/metrics", json=[{"metric_date": str(local_today()), "spend": "2000",
                                                     "impressions": 10000, "clicks": 250, "leads": 12}])
    c.post("/orders", json=order_body(setup, confirm=True, discount_code="INSTA10"))  # 2124
    c.post("/orders", json=order_body(setup, confirm=True, campaign_id=camp["id"]))  # 2360
    c.post("/orders", json=order_body(setup, confirm=True))  # not attributed
    perf = c.get(f"/campaigns/{camp['id']}/performance").json()
    assert perf["orders"] == 2 and perf["revenue"] == "4484.00" and perf["new_customers"] == 1
    assert perf["roas"] == "2.24" and perf["cac"] == "2000.00" and perf["ctr_pct"] == "2.50"
    assert "gross_profit" in perf
    plat = c.get("/marketing/performance?group_by=platform").json()["rows"]
    assert plat[0]["platform"] == "meta"
    assert c.get("/marketing/promo-codes").json()[0]["code"] == "INSTA10"
    assert c.get("/dashboard").json()["marketing"]["attributed_orders"] == 2


def test_content_pipeline_calendar_and_influencer_samples(setup):  # noqa: F811
    c = setup["c"]
    wh = c.post("/warehouses", json={"code": "MAIN", "name": "Main"}).json()["id"]
    c.post("/stock/receive", json={"warehouse_id": wh, "lines": [{"product_id": setup["product"]["id"],
                                                                  "quantity": "10", "batch_number": "B1"}]})
    item = c.post("/content", json={"title": "Reel: mug cake in 60s", "platform": "instagram",
                                    "scheduled_for": f"{local_today()}T18:00:00+05:00", "status": "scheduled"}).json()
    item = c.patch(f"/content/{item['id']}", json={"status": "published"}).json()
    assert item["published_at"] is not None
    inf = c.post("/influencers", json={"name": "Foodie Lahore", "handle": "@foodielhr", "followers": 50000}).json()
    deal = c.post("/influencer-deals", json={"influencer_id": inf["id"], "fee": "15000",
                                             "posting_date": str(local_today()),
                                             "samples": [{"product_id": setup["product"]["id"], "quantity": "2"}]}).json()
    assert c.post(f"/influencer-deals/{deal['id']}/send-samples?warehouse_id={wh}").json() == {"sent": 1}
    cal = c.get(f"/marketing/calendar?date_from={local_today()}&date_to={local_today()}").json()
    assert {i["type"] for i in cal} >= {"content", "influencer_post"}


def test_leads_follow_ups_segments(setup, db):  # noqa: F811
    c = setup["c"]
    me = c.get("/auth/me").json()
    lead = c.post("/leads", json={"name": "Grand Hotel", "company": "Grand Hotel", "source": "event"}).json()
    fu = c.post("/follow-ups", json={"lead_id": lead["id"], "due_date": str(local_today()), "note": "Send tasting box",
                                     "assigned_to_id": me["id"]}).json()
    cust = c.post(f"/leads/{lead['id']}/convert").json()
    assert cust["type"] == "corporate" and c.get(f"/leads/{lead['id']}").json()["status"] == "won"
    check_alerts(db)
    assert any(n["kind"] == "follow_up" for n in c.get("/notifications").json()["items"])
    c.post(f"/follow-ups/{fu['id']}/done", json={"outcome": "Booked tasting"})
    assert c.get("/follow-ups/mine").json() == []

    c.post("/orders", json=order_body(setup, confirm=True))
    c.post("/orders", json=order_body(setup, confirm=True))
    seg = c.post("/segments", json={"name": "Repeat buyers", "rules": {"min_orders": 2}}).json()
    assert c.get(f"/segments/{seg['id']}/customers").json()["total"] == 1
    assert c.post("/segments/preview", json={"min_spend": "999999"}).json()["total"] == 0
    assert c.get(f"/segments/{seg['id']}/export").status_code == 200


def test_loyalty_earn_redeem_reverse_and_referral(setup, db):  # noqa: F811
    c = setup["c"]
    c.patch("/settings/company", json={"loyalty_points_per_100": "1", "loyalty_point_value": "1",
                                       "referral_bonus_points": "50"})
    hina = setup["customer"]["id"]
    code = c.post(f"/customers/{hina}/referral-code").json()["referral_code"]
    friend = c.post("/customers", json={"name": "Sana"}).json()
    o = c.post("/orders", json={**order_body(setup, confirm=True, referral_code=code), "customer_id": friend["id"],
                                "delivery_method": "pickup"}).json()
    c.post(f"/orders/{o['id']}/status", json={"status": "delivered"})
    award_points(db)
    assert c.get(f"/customers/{friend['id']}/loyalty").json()["points"] == 23  # 2360 / 100
    assert c.get(f"/customers/{hina}/loyalty").json()["points"] == 50  # referral bonus
    award_points(db)
    assert c.get(f"/customers/{friend['id']}/loyalty").json()["points"] == 23  # not awarded twice

    o2 = c.post("/orders", json={**order_body(setup), "customer_id": friend["id"], "loyalty_points": 20}).json()
    assert o2["grand_total"] == "2340.00" and c.get(f"/customers/{friend['id']}/loyalty").json()["points"] == 3
    r = c.post("/orders", json={**order_body(setup), "customer_id": friend["id"], "loyalty_points": 50})
    assert r.json()["code"] == "not_enough_points"
    c.post(f"/orders/{o2['id']}/status", json={"status": "cancelled", "note": "changed mind"})
    assert c.get(f"/customers/{friend['id']}/loyalty").json()["points"] == 23
