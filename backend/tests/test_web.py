import gzip

from fastapi.testclient import TestClient

from app import web


def test_single_service_serves_api_and_frontend(tmp_path, monkeypatch):
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<html>app</html>")
    (tmp_path / "assets" / "index-abc123.js").write_text("console.log(1)")
    (tmp_path / "assets" / "index-abc123.js.gz").write_bytes(gzip.compress(b"console.log(1)"))
    (tmp_path / "favicon.svg").write_text("<svg/>")
    monkeypatch.setattr(web, "DIST", tmp_path.resolve())
    c = TestClient(web.app)

    r = c.get("/api/health")
    assert r.json() == {"status": "ok"}
    assert r.headers["x-content-type-options"] == "nosniff" and r.headers["x-frame-options"] == "DENY"

    # app routes fall back to index.html, which browsers always re-check
    r = c.get("/orders/12")
    assert r.text == "<html>app</html>" and r.headers["cache-control"] == "no-cache"

    # fingerprinted assets: pre-compressed when accepted, cached for a year
    r = c.get("/assets/index-abc123.js", headers={"Accept-Encoding": "gzip"})
    assert r.headers["content-encoding"] == "gzip" and r.text == "console.log(1)"
    assert "immutable" in r.headers["cache-control"] and r.headers["content-type"].startswith("text/javascript")
    r = c.get("/assets/index-abc123.js", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in r.headers and r.text == "console.log(1)"

    assert c.get("/favicon.svg").headers["cache-control"] == "public, max-age=86400"
    # phones only offer "Install app" when the manifest comes with its proper type
    (tmp_path / "manifest.webmanifest").write_text("{}")
    assert c.get("/manifest.webmanifest").headers["content-type"] == "application/manifest+json"
    # nothing outside the build folder is reachable
    assert c.get("/..%2F..%2Fetc%2Fpasswd").text == "<html>app</html>"
