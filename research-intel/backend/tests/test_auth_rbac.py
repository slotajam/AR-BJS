from sqlalchemy import select

from app.db import session_factory
from app.models import AuditLog
from tests.conftest import make_pdf, register


def test_unauthenticated_requests_rejected(client):
    assert client.get("/api/v1/projects").status_code == 401
    assert client.get("/api/v1/connectors/status").status_code == 401
    bad = {"Authorization": "Bearer not-a-token"}
    assert client.get("/api/v1/projects", headers=bad).status_code == 401


def test_password_policy_and_duplicate_email(client):
    r = client.post("/api/v1/auth/register", json={"email": "a@example.org", "password": "short", "display_name": "A"})
    assert r.status_code == 422
    register(client, "a@example.org")
    r = client.post("/api/v1/auth/register",
                    json={"email": "A@example.org", "password": "another-long-pass", "display_name": "A"})
    assert r.status_code == 409
    r = client.post("/api/v1/auth/login", json={"email": "a@example.org", "password": "wrong-password!"})
    assert r.status_code == 401


def test_project_isolation(client, owner, project):
    other = register(client, "other@example.org")
    pid = project["id"]
    assert client.get(f"/api/v1/projects/{pid}", headers=other).status_code == 404
    assert client.get(f"/api/v1/projects/{pid}/papers", headers=other).status_code == 404
    assert client.post(f"/api/v1/projects/{pid}/searches", headers=other,
                       json={"name": "x", "original_query": "x"}).status_code == 404
    assert [p["id"] for p in client.get("/api/v1/projects", headers=other).json()] == []
    assert [p["id"] for p in client.get("/api/v1/projects", headers=owner).json()] == [pid]


def test_viewer_is_read_only(client, owner, project):
    viewer = register(client, "viewer@example.org")
    pid = project["id"]
    r = client.put(f"/api/v1/projects/{pid}/members", headers=owner,
                   json={"email": "viewer@example.org", "role": "viewer"})
    assert r.status_code == 200
    assert client.get(f"/api/v1/projects/{pid}/papers", headers=viewer).status_code == 200
    assert client.post(f"/api/v1/projects/{pid}/searches", headers=viewer,
                       json={"name": "x", "original_query": "x", "run_now": False}).status_code == 403
    assert client.post(f"/api/v1/projects/{pid}/imports", headers=viewer,
                       json={"format": "doi", "content": "10.5555/x"}).status_code == 403
    assert client.post(f"/api/v1/projects/{pid}/rankings", headers=viewer, json={}).status_code == 403
    r = client.post(f"/api/v1/projects/{pid}/uploads", headers=viewer,
                    files={"file": ("a.pdf", make_pdf(["x"]), "application/pdf")},
                    data={"access_basis": "user_upload_own_work", "rights_attested": "true"})
    assert r.status_code == 403
    assert client.put(f"/api/v1/projects/{pid}/members", headers=viewer,
                      json={"email": "viewer@example.org", "role": "owner"}).status_code == 403
    assert client.get(f"/api/v1/projects/{pid}/audit", headers=viewer).status_code == 403


def test_last_owner_cannot_be_demoted_and_audit_logged(client, owner, project):
    pid = project["id"]
    r = client.put(f"/api/v1/projects/{pid}/members", headers=owner,
                   json={"email": "owner@example.org", "role": "viewer"})
    assert r.status_code == 409
    log = client.get(f"/api/v1/projects/{pid}/audit", headers=owner).json()
    assert any(e["action"] == "project.create" for e in log)
    with session_factory()() as db:
        assert db.scalar(select(AuditLog).where(AuditLog.action == "user.login")) is not None


def test_security_headers(client):
    r = client.get("/api/v1/health")
    assert r.status_code == 200
    assert r.headers["X-Content-Type-Options"] == "nosniff"


def test_owner_can_delete_project_and_its_files(client, owner, project):
    from app.models import File
    from app.services.storage import get_storage

    pid = project["id"]
    r = client.post(f"/api/v1/projects/{pid}/uploads", headers=owner,
                    files={"file": ("a.pdf", make_pdf(["Delete me"]), "application/pdf")},
                    data={"access_basis": "user_upload_own_work", "rights_attested": "true"})
    with session_factory()() as db:
        key = db.get(File, r.json()["file_id"]).storage_key
    assert get_storage().exists(key)
    editor = register(client, "ed@example.org")
    client.put(f"/api/v1/projects/{pid}/members", headers=owner, json={"email": "ed@example.org", "role": "admin"})
    assert client.delete(f"/api/v1/projects/{pid}", headers=editor).status_code == 403
    assert client.delete(f"/api/v1/projects/{pid}", headers=owner).status_code == 204
    assert not get_storage().exists(key)
    assert client.get(f"/api/v1/projects/{pid}", headers=owner).status_code == 404
    with session_factory()() as db:
        assert db.scalar(select(AuditLog).where(AuditLog.action == "project.delete")) is not None
