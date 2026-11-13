from app.auth.models import UserSession
from tests.conftest import login


def test_owner_creates_user_and_grants_access(owner_client, client):
    r = owner_client.post("/users", json={"name": "Sara", "email": "Sara@Example.com", "password": "long-password-1"})
    assert r.status_code == 201
    uid = r.json()["id"]
    r = owner_client.put(f"/users/{uid}/access", json={"access": {"audit": ["view"]}})
    assert r.status_code == 200 and r.json() == {"audit": ["view"]}
    history = owner_client.get(f"/audit?entity_type=users&entity_id={uid}").json()
    assert {h["action"] for h in history} == {"create", "access_change"}


def test_duplicate_email(owner_client, make_user):
    make_user("dup@example.com")
    r = owner_client.post("/users", json={"name": "X", "email": "DUP@example.com", "password": "long-password-1"})
    assert r.status_code == 409


def test_unknown_feature_rejected(owner_client, make_user):
    u = make_user("t@example.com")
    r = owner_client.put(f"/users/{u.id}/access", json={"access": {"nope": ["view"]}})
    assert r.status_code == 422


def test_manager_cannot_grant_what_they_lack(user_client, make_user):
    target = make_user("t@example.com")
    c = user_client("access_management.view", "access_management.edit")
    ok = c.put(f"/users/{target.id}/access", json={"access": {"access_management": ["view"]}})
    assert ok.status_code == 200
    r = c.put(f"/users/{target.id}/access", json={"access": {"audit": ["view"]}})
    assert r.status_code == 403


def test_manager_cannot_touch_self_or_owner(user_client, make_user, db):
    owner = make_user("boss@example.com", owner=True)
    c = user_client("access_management.view", "access_management.edit")
    me = c.get("/auth/me").json()
    assert c.put(f"/users/{me['id']}/access", json={"access": {}}).status_code == 403
    assert c.post(f"/users/{owner.id}/deactivate").status_code == 403
    assert c.post("/users", json={"name": "O", "email": "o@example.com", "password": "long-password-1",
                                  "is_owner": True}).status_code == 403


def test_copy_access(owner_client, make_user):
    src = make_user("src@example.com", access=("audit.view", "settings.view"))
    dst = make_user("dst@example.com")
    r = owner_client.post(f"/users/{dst.id}/access/copy-from/{src.id}")
    assert r.json() == {"audit": ["view"], "settings": ["view"]}


def test_deactivate_ends_sessions(owner_client, make_user, db):
    u = make_user("leaver@example.com")
    db.add(UserSession(user_id=u.id, token_hash="x" * 64, last_seen_at=u.created_at, expires_at=u.created_at))
    db.flush()
    assert owner_client.post(f"/users/{u.id}/deactivate").json()["is_active"] is False
    assert db.query(UserSession).filter_by(user_id=u.id).count() == 0
    assert login(owner_client, "leaver@example.com").status_code == 401
