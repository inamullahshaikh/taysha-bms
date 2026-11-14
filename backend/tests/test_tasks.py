from app.notifications import check_alerts


def test_projects_tasks_subtasks_comments_and_overdue(owner_client, db):
    c = owner_client
    me = c.get("/auth/me").json()
    p = c.post("/projects", json={"name": "Ramadan launch", "kind": "launch", "due_date": "2027-02-01"}).json()
    t = c.post("/tasks", json={"title": "Design gift box", "project_id": p["id"], "assignee_id": me["id"],
                               "priority": "high", "due_date": "2026-01-01",
                               "checklist": [{"text": "Sketch"}, {"text": "Print proof"}]}).json()
    sub = c.post("/tasks", json={"title": "Get printer quotes", "parent_id": t["id"]}).json()
    assert c.get(f"/tasks?parent_id={t['id']}").json()["items"][0]["id"] == sub["id"]
    c.post(f"/tasks/{t['id']}/comments", json={"body": "Use the brown kraft paper"})
    assert c.get(f"/tasks/{t['id']}/comments").json()[0]["body"].startswith("Use")
    assert c.get("/tasks/mine").json()[0]["id"] == t["id"]
    ov = c.get(f"/tasks/overview?project_id={p['id']}").json()
    assert ov["overdue"] == 1 and ov["by_status"]["todo"] == 2
    check_alerts(db)
    assert any(n["kind"] == "task_overdue" for n in c.get("/notifications").json()["items"])
    done = c.patch(f"/tasks/{t['id']}", json={"status": "done",
                                              "checklist": [{"text": "Sketch", "done": True}]}).json()
    assert done["completed_at"] and done["checklist"][0]["done"]
    assert c.get("/tasks/mine").json() == []
    assert "tasks" in c.get("/dashboard").json()
