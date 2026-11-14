from datetime import timedelta

from app.clock import local_today
from app.notifications import check_alerts
from tests.conftest import login


def test_documents_versions_expiry_and_confidential(owner_client, client, make_user, db):
    c = owner_client
    lic = c.post("/document-records", json={"title": "PFA food license", "category": "license",
                                            "expiry_date": str(local_today() + timedelta(days=10)),
                                            "tags": ["regulatory"]}).json()
    for content in (b"%PDF v1", b"%PDF v2"):
        c.post(f"/attachments?entity_type=document_records&entity_id={lic['id']}",
               files={"file": ("license.pdf", content, "application/pdf")})
    files = c.get(f"/attachments?entity_type=document_records&entity_id={lic['id']}").json()
    assert [f["version"] for f in files] == [2, 1]
    assert c.get("/document-records?expiring_within_days=30").json()["items"][0]["file_count"] == 2
    assert c.get("/document-records?tag=regulatory&category=license").json()["total"] == 1
    check_alerts(db)
    assert any(n["kind"] == "document_expiry" for n in c.get("/notifications").json()["items"])

    secret = c.post("/document-records", json={"title": "Partnership deed", "category": "agreement",
                                               "confidential": True}).json()
    c.post(f"/attachments?entity_type=document_records&entity_id={secret['id']}",
           files={"file": ("deed.pdf", b"%PDF", "application/pdf")})
    c.post("/auth/logout")
    make_user("staff@example.com", access=("documents.view",))
    login(client, "staff@example.com")
    assert client.get("/document-records").json()["total"] == 1  # confidential one hidden
    assert client.get(f"/document-records/{secret['id']}").status_code == 404
    assert client.get(f"/attachments?entity_type=document_records&entity_id={secret['id']}").status_code == 403
