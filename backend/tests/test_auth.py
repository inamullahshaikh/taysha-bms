from datetime import timedelta

from sqlalchemy import select

from app.auth.models import UserSession
from app.auth.security import now
from tests.conftest import login


def test_login_me_logout(client, make_user):
    make_user("a@example.com")
    r = login(client, "A@example.com")  # email is case-insensitive
    assert r.status_code == 200 and r.json()["user"]["email"] == "a@example.com"
    assert client.get("/auth/me").status_code == 200
    assert client.post("/auth/logout").status_code == 204
    assert client.get("/auth/me").status_code == 401


def test_wrong_password_and_lockout(client, make_user):
    make_user("b@example.com")
    for _ in range(5):
        r = login(client, "b@example.com", "wrong-password")
        assert r.status_code == 401 and r.json()["code"] == "invalid_login"
    assert login(client, "b@example.com").status_code == 429  # even the right password is blocked now


def test_unauthenticated_error_format(client):
    r = client.get("/auth/me")
    assert r.status_code == 401
    assert r.json() == {"code": "not_authenticated", "message": "Please log in", "fields": {}}


def test_deactivated_user_loses_access(client, make_user, db):
    u = make_user("c@example.com")
    login(client, "c@example.com")
    u.is_active = False
    db.flush()
    assert client.get("/auth/me").status_code == 401


def test_idle_session_expires(client, make_user, db):
    make_user("d@example.com")
    login(client, "d@example.com")
    s = db.scalar(select(UserSession))
    s.last_seen_at = now() - timedelta(days=1)
    db.flush()
    assert client.get("/auth/me").status_code == 401


def test_change_password_ends_other_sessions(client, make_user, db):
    u = make_user("e@example.com")
    login(client, "e@example.com")
    login(client, "e@example.com")  # second session (cookie replaced in this client)
    assert db.query(UserSession).filter_by(user_id=u.id).count() == 2
    r = client.post("/auth/change-password",
                    json={"current_password": "password123", "new_password": "a-new-long-password"})
    assert r.status_code == 204
    assert db.query(UserSession).filter_by(user_id=u.id).count() == 1
    assert client.get("/auth/me").status_code == 200
    r = client.post("/auth/change-password", json={"current_password": "a-new-long-password", "new_password": "short"})
    assert r.status_code == 422 and r.json()["code"] == "weak_password"
