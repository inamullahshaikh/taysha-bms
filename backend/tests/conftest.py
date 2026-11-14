import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.auth.access import UserAccess
from app.auth.models import User
from app.auth.security import hash_password
from app.config import settings
from app.db import get_db
from app.errors import KeepChangesError
from app.main import app

TEST_URL = settings.test_database_url
settings.cookie_secure = False  # TestClient talks plain http
settings.upload_dir = "/tmp/taysha-test-uploads"
PASSWORD = "password123"
_HASH = hash_password(PASSWORD)  # hash once, argon2 is slow on purpose


@pytest.fixture(scope="session")
def engine():
    """Fresh test database, built with the real migrations."""
    url = make_url(TEST_URL)
    admin = create_engine(url.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{url.database}" WITH (FORCE)'))
        conn.execute(text(f'CREATE DATABASE "{url.database}"'))
    admin.dispose()

    cfg = Config("alembic.ini")
    cfg.set_main_option("sqlalchemy.url", TEST_URL)
    command.upgrade(cfg, "head")

    eng = create_engine(TEST_URL)
    yield eng
    eng.dispose()


@pytest.fixture
def db(engine):
    """Each test runs inside a transaction that is rolled back afterwards."""
    conn = engine.connect()
    trans = conn.begin()
    session = Session(bind=conn, join_transaction_mode="create_savepoint", expire_on_commit=False)
    yield session
    session.close()
    trans.rollback()
    conn.close()


@pytest.fixture
def client(db):
    def override():
        try:
            yield db
            db.commit()
        except KeepChangesError:
            db.commit()
            raise
        except BaseException:
            db.rollback()
            raise

    app.dependency_overrides[get_db] = override
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def make_user(db):
    def _make(email="user@example.com", owner=False, active=True, name="Test User", access=()):
        """access: iterable of "feature.action" strings, e.g. ("orders.view", "orders.create")."""
        u = User(name=name, email=email, password_hash=_HASH, is_owner=owner, is_active=active)
        db.add(u)
        db.flush()
        for fa in access:
            f, a = fa.split(".")
            db.add(UserAccess(user_id=u.id, feature=f, action=a))
        db.flush()
        return u

    return _make


def login(client, email, password=PASSWORD):
    return client.post("/auth/login", json={"email": email, "password": password})


@pytest.fixture
def owner_client(client, make_user):
    make_user("owner@example.com", owner=True, name="Owner")
    assert login(client, "owner@example.com").status_code == 200
    return client


@pytest.fixture
def user_client(client, make_user):
    """Log in as a non-owner with the given grants: user_client("orders.view", ...)."""

    def _login(*access, email="staff@example.com"):
        make_user(email, access=access, name="Staff")
        assert login(client, email).status_code == 200
        return client

    return _login
