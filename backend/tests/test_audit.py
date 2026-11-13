from sqlalchemy import select

from app.audit import AuditLog, audit


def test_audit_records_only_changed_fields(db):
    db.info["user_id"] = 7
    audit(db, "update", entity_type="thing", entity_id=1, before={"a": 1, "b": 2}, after={"a": 1, "b": 3})
    db.flush()
    row = db.scalar(select(AuditLog))
    assert row.user_id == 7 and row.action == "update"
    assert row.before == {"b": 2} and row.after == {"b": 3}
