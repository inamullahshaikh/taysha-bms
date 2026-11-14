from datetime import timedelta

from sqlalchemy import select

from app import jobs
from app.auth.models import UserSession
from app.clock import utcnow
from app.integrations.shopify import SyncLog
from app.notifications import Notification


def test_housekeeping_removes_only_dead_rows(db, make_user):
    u = make_user()
    now = utcnow()
    db.add_all([
        UserSession(user_id=u.id, token_hash="a" * 64, last_seen_at=now, expires_at=now + timedelta(days=1)),
        UserSession(user_id=u.id, token_hash="b" * 64, last_seen_at=now, expires_at=now - timedelta(minutes=1)),
        Notification(user_id=u.id, kind="x", title="old read", read_at=now, created_at=now - timedelta(days=91)),
        Notification(user_id=u.id, kind="x", title="old unread", created_at=now - timedelta(days=91)),
        Notification(user_id=u.id, kind="x", title="recent read", read_at=now, created_at=now - timedelta(days=5)),
        SyncLog(direction="in", kind="order", status="ok", payload={"big": 1}, at=now - timedelta(days=31)),
        SyncLog(direction="in", kind="order", status="error", payload={"keep": 1}, at=now - timedelta(days=31)),
    ])
    db.flush()

    assert jobs._housekeeping(db) == "1 sessions, 1 notifications, 1 sync payloads removed"
    assert db.scalars(select(UserSession.token_hash)).all() == ["a" * 64]
    assert sorted(db.scalars(select(Notification.title))) == ["old unread", "recent read"]
    # sync rows stay (they keep webhooks idempotent); only the successful one loses its payload
    assert sorted(str(p) for p in db.scalars(select(SyncLog.payload))) == ["None", "{'keep': 1}"]
