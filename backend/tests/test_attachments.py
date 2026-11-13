def upload(c, entity_id, name="contract.pdf", data=b"%PDF-1.4 test", ctype="application/pdf"):
    return c.post(f"/attachments?entity_type=users&entity_id={entity_id}", files={"file": (name, data, ctype)})


def test_upload_list_download_version(owner_client, make_user):
    u = make_user("f@example.com")
    assert upload(owner_client, u.id).json()["version"] == 1
    a2 = upload(owner_client, u.id, data=b"%PDF-1.4 v2").json()
    assert a2["version"] == 2
    files = owner_client.get(f"/attachments?entity_type=users&entity_id={u.id}").json()
    assert len(files) == 2
    assert owner_client.get(f"/attachments/{a2['id']}/download").content == b"%PDF-1.4 v2"
    owner_client.post(f"/attachments/{a2['id']}/archive")
    assert len(owner_client.get(f"/attachments?entity_type=users&entity_id={u.id}").json()) == 1


def test_rejects_bad_type_and_missing_record(owner_client, make_user):
    u = make_user("g@example.com")
    assert upload(owner_client, u.id, "x.exe", b"MZ", "application/x-msdownload").status_code == 422
    assert upload(owner_client, 999999).status_code == 404
    r = owner_client.post("/attachments?entity_type=audit_log&entity_id=1",
                          files={"file": ("a.pdf", b"x", "application/pdf")})
    assert r.status_code == 422


def test_access_follows_parent_record(user_client, make_user, owner_client):
    u = make_user("h@example.com")
    a = upload(owner_client, u.id).json()
    owner_client.post("/auth/logout")
    c = user_client("access_management.view")
    assert c.get(f"/attachments/{a['id']}/download").status_code == 200
    assert upload(c, u.id).status_code == 403  # needs edit to add files
