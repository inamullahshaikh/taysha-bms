from sqlalchemy import text


def test_migrations_applied(db):
    assert db.execute(text("select version_num from alembic_version")).scalar() is not None
