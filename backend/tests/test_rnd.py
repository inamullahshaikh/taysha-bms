from tests.test_production import prod  # noqa: F401


def test_idea_trials_compare_and_approve(prod):  # noqa: F811
    c = prod["c"]
    idea = c.post("/rnd/ideas", json={"title": "Less-sugar mug cake", "target_cost": "200"}).json()
    v2 = c.post(f"/recipes/{prod['recipe']['id']}/new-version").json()
    c.put(f"/recipes/{v2['id']}", json={"product_id": prod["cake"]["id"], "yield_quantity": "10",
                                        "lines": [{"product_id": prod["cocoa"]["id"], "quantity": "400"},
                                                  {"product_id": prod["box"]["id"], "quantity": "10"}]})
    t1 = c.post("/rnd/trials", json={"idea_id": idea["id"], "kind": "recipe", "recipe_id": prod["recipe"]["id"],
                                     "rating": 3}).json()
    t2 = c.post("/rnd/trials", json={"idea_id": idea["id"], "kind": "recipe", "recipe_id": v2["id"],
                                     "rating": 4}).json()
    for who, r in (("Ali", 5), ("Sana", 4)):
        c.post(f"/rnd/trials/{t2['id']}/feedback", json={"who": who, "rating": r, "comment": "nice"})
    c.post(f"/rnd/trials/{t2['id']}/observations", json={"day": 7, "note": "Still moist"})
    c.post(f"/rnd/trials/{t2['id']}/observations", json={"day": 3, "note": "Fine"})
    assert [o["day"] for o in c.get(f"/rnd/trials/{t2['id']}").json()["observations"]] == [3, 7]
    cmp = {row["trial_id"]: row for row in c.get(f"/rnd/ideas/{idea['id']}/compare").json()}
    assert cmp[t2["id"]]["avg_feedback"] == "4.5" and cmp[t2["id"]]["recipe_version"] == 2
    assert cmp[t2["id"]]["cost_per_unit"] < cmp[t1["id"]]["cost_per_unit"]
    r = c.post(f"/rnd/trials/{t2['id']}/approve-recipe").json()
    assert r["status"] == "active" and r["version"] == 2
    assert c.get(f"/rnd/ideas/{idea['id']}").json()["status"] == "approved"


def test_rnd_is_confidential(user_client):
    c = user_client("products.view", "production.view")
    assert c.get("/rnd/ideas").status_code == 403
