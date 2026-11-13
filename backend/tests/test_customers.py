def make_customer(c, name="Ayesha Khan", **kw):
    r = c.post("/customers", json={"name": name, **kw})
    assert r.status_code == 201, r.text
    return r.json()


def test_customer_crud_search_filters(owner_client):
    a = make_customer(owner_client, phone="+92 300 123-4567", email="Ayesha@Example.com", tags=["vip"])
    assert a["phone"] == "+923001234567" and a["email"] == "ayesha@example.com"
    make_customer(owner_client, "Beans Cafe", type="cafe", tags=["cafe"])
    assert owner_client.get("/customers?q=3001234").json()["total"] == 1
    assert owner_client.get("/customers?type=cafe").json()["items"][0]["name"] == "Beans Cafe"
    assert owner_client.get("/customers?tag=vip").json()["total"] == 1
    r = owner_client.patch(f"/customers/{a['id']}", json={"tags": ["vip", "returning"]})
    assert r.json()["tags"] == ["vip", "returning"]


def test_addresses_single_default(owner_client):
    c = make_customer(owner_client)
    a1 = owner_client.post(f"/customers/{c['id']}/addresses",
                           json={"line1": "House 1", "city": "Lahore", "is_default_shipping": True}).json()
    owner_client.post(f"/customers/{c['id']}/addresses",
                      json={"label": "Office", "line1": "Plaza 2", "city": "Lahore", "is_default_shipping": True})
    addrs = owner_client.get(f"/customers/{c['id']}/addresses").json()
    assert [a["label"] for a in addrs if a["is_default_shipping"]] == ["Office"]
    owner_client.post(f"/customers/{c['id']}/addresses/{a1['id']}/archive")
    assert len(owner_client.get(f"/customers/{c['id']}/addresses").json()) == 1


def test_notes_log(owner_client):
    c = make_customer(owner_client)
    owner_client.post(f"/customers/{c['id']}/notes", json={"kind": "call", "body": "Wants a 12-pack"})
    notes = owner_client.get(f"/customers/{c['id']}/notes").json()
    assert notes[0]["kind"] == "call" and notes[0]["created_by_id"]


def test_export_needs_permission(user_client):
    c = user_client("customers.view")
    assert c.get("/customers").status_code == 200
    assert c.get("/customers/export").status_code == 403
    assert c.post("/customers", json={"name": "x"}).status_code == 403
