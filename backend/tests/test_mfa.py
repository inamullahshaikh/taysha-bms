import pyotp

from tests.conftest import login


def enable_2fa(client):
    secret = client.post("/auth/2fa/setup").json()["secret"]
    codes = client.post("/auth/2fa/enable", json={"code": pyotp.TOTP(secret).now()}).json()["recovery_codes"]
    return secret, codes


def test_2fa_login_flow(client, make_user):
    make_user("m@example.com")
    login(client, "m@example.com")
    secret, codes = enable_2fa(client)
    assert len(codes) == 10
    client.post("/auth/logout")

    assert login(client, "m@example.com").json() == {"mfa_required": True}
    assert client.get("/auth/me").status_code == 401  # half-logged-in session can't use the app
    assert client.post("/auth/2fa/verify", json={"code": "000000"}).status_code == 401
    assert client.post("/auth/2fa/verify", json={"code": pyotp.TOTP(secret).now()}).status_code == 200
    assert client.get("/auth/me").status_code == 200


def test_recovery_code_works_once(client, make_user):
    make_user("r@example.com")
    login(client, "r@example.com")
    _, codes = enable_2fa(client)
    for expected in (200, 401):
        client.post("/auth/logout")
        login(client, "r@example.com")
        assert client.post("/auth/2fa/verify", json={"code": codes[0]}).status_code == expected
