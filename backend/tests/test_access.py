import pytest

from app.auth.access import require_access


def test_no_grant_is_forbidden(user_client):
    c = user_client()
    r = c.get("/audit")
    assert r.status_code == 403 and r.json()["code"] == "forbidden"


def test_grant_allows(user_client):
    c = user_client("audit.view")
    assert c.get("/audit").status_code == 200
    assert c.get("/auth/me/access").json() == {"audit": ["view"]}


def test_owner_has_everything(owner_client):
    access = owner_client.get("/auth/me/access").json()
    assert "view" in access["audit"] and "edit" in access["access_management"]


def test_record_history_needs_feature_view(user_client, make_user):
    other = make_user("other@example.com")
    c = user_client("access_management.view")
    assert c.get(f"/audit?entity_type=users&entity_id={other.id}").status_code == 200
    assert c.get("/audit").status_code == 403  # full log still needs audit.view


def test_typo_in_action_fails_fast():
    with pytest.raises(ValueError):
        require_access("audit", "delete")
