def test_paging_search_sort(owner_client, make_user):
    for i in range(5):
        make_user(f"p{i}@example.com", name=f"Person {i}")
    r = owner_client.get("/users?page=1&page_size=2&sort=-name&q=person").json()
    assert r["total"] == 5 and r["page_size"] == 2
    assert [u["name"] for u in r["items"]] == ["Person 4", "Person 3"]
    assert owner_client.get("/users?sort=password_hash").status_code == 422


def test_export_csv_and_xlsx_are_audited(owner_client):
    r = owner_client.get("/users/export?format=csv")
    assert r.status_code == 200 and "owner@example.com" in r.text
    assert r.headers["content-disposition"].startswith('attachment; filename="users-')
    assert owner_client.get("/users/export?format=xlsx").content[:2] == b"PK"  # zip container
    assert len(owner_client.get("/audit?action=export").json()) == 2


def test_export_needs_export_access(user_client):
    c = user_client("access_management.view")
    assert c.get("/users/export").status_code == 403
