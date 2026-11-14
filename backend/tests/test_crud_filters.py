def test_filter_accepts_several_values(owner_client):
    c = owner_client
    for title, status in (("a", "todo"), ("b", "blocked"), ("c", "done")):
        assert c.post("/tasks", json={"title": title, "status": status}).status_code == 201
    titles = lambda q: sorted(t["title"] for t in c.get(f"/tasks?{q}").json()["items"])  # noqa: E731
    assert titles("status=todo,blocked") == ["a", "b"]
    assert titles("status=done") == ["c"]
    assert c.get("/tasks?priority=nope,high").status_code in (200, 422)  # bad values never 500
