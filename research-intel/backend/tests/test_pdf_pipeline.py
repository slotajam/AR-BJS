import httpx
import pytest
from sqlalchemy import func, select

from app.config import get_settings
from app.db import session_factory
from app.models import Chunk, Embedding, File, Paper
from app.services import netsafe
from app.services.parsing import parse_pdf
from app.services.pdf_validate import validate_pdf
from tests.conftest import SAMPLE_PAGES, make_pdf
from tests.test_search_jobs import _search

PDF_URL = "https://repo.example.org/files/fx0001.pdf"


# ------------------------------------------------------------------ validation


def test_pdf_validation_rules():
    good = make_pdf(SAMPLE_PAGES)
    v = validate_pdf(good, max_bytes=10_000_000)
    assert v.ok and v.page_count == 3 and len(v.sha256) == 64
    html = b"<!DOCTYPE html><html><body>Please log in</body></html>"
    v = validate_pdf(html, max_bytes=10_000_000, declared_content_type="application/pdf")
    assert not v.ok and v.error == "HTML content disguised as PDF"
    assert validate_pdf(b"GIF89a....", max_bytes=100).error == "missing %PDF- signature"
    assert validate_pdf(b"", max_bytes=100).error == "empty file"
    assert "exceeds" in validate_pdf(good, max_bytes=100).error
    assert validate_pdf(b"%PDF-1.7\n garbage garbage", max_bytes=1000).error.startswith(("unreadable", "PDF has no"))


def test_parsing_produces_page_linked_chunks():
    res = parse_pdf(make_pdf(SAMPLE_PAGES, labels=["5"]))
    assert res.page_count == 3
    assert [c.page_index for c in res.chunks] == sorted(c.page_index for c in res.chunks)
    pages = {c.page_index for c in res.chunks}
    assert pages == {0, 1, 2}
    first = res.chunks[0]
    assert first.printed_page == "5"  # printed page label differs from PDF page index
    assert first.section_label == "Introduction"
    assert all(c.bboxes and c.char_end > c.char_start for c in res.chunks)
    methods = next(c for c in res.chunks if "serpentine" in c.text)
    assert methods.section_label == "Methods" and methods.page_index == 1
    assert "structured_tables" in res.unsupported


# ------------------------------------------------------------------ SSRF


@pytest.mark.parametrize("url,msg", [
    ("ftp://repo.example.org/a.pdf", "scheme"),
    ("http://127.0.0.1/a.pdf", "non-public"),
    ("http://169.254.169.254/latest/meta-data", "non-public"),
    ("http://[::1]/a.pdf", "non-public"),
    ("https://evil.example.net/a.pdf", "non-public"),
    ("https://rebind.example.net/a.pdf", "non-public"),  # any private A record blocks
    ("https://repo.example.org:8443/a.pdf", "port"),
    ("https://user:pw@repo.example.org/a.pdf", "credentials"),
])
def test_ssrf_blocked(web, url, msg):
    with pytest.raises(netsafe.UnsafeURL, match=msg):
        netsafe.safe_get(url)
    assert web.requests == []  # nothing was sent


def test_redirect_to_private_address_blocked(web):
    web.routes[PDF_URL] = httpx.Response(302, headers={"Location": "http://evil.example.net/x.pdf"})
    with pytest.raises(netsafe.UnsafeURL):
        netsafe.safe_get(PDF_URL)
    assert web.requests == [PDF_URL]


def test_redirect_limit_and_access_control_not_bypassed(web):
    web.routes[PDF_URL] = httpx.Response(302, headers={"Location": PDF_URL})
    with pytest.raises(netsafe.FetchError, match="too many redirects"):
        netsafe.safe_get(PDF_URL)
    web.routes[PDF_URL] = httpx.Response(403)
    with pytest.raises(netsafe.FetchError, match="not bypassed"):
        netsafe.safe_get(PDF_URL)


def test_size_cap_enforced_while_streaming(web, monkeypatch):
    monkeypatch.setattr(get_settings(), "pdf_max_bytes", 1000)
    web.routes[PDF_URL] = httpx.Response(200, content=b"%PDF-1.7" + b"0" * 5000)
    with pytest.raises(netsafe.FetchError, match="(too large|exceeds)"):
        netsafe.safe_get(PDF_URL)


# ------------------------------------------------------------------ collection


def _paper_id(client, owner, pid, doi):
    papers = client.get(f"/api/v1/projects/{pid}/papers?page_size=100&include_excluded=true", headers=owner).json()
    return next(p["id"] for p in papers["items"] if p["doi"] == doi)


def test_collect_permitted_pdf_end_to_end(client, owner, project, providers, web):
    pid = project["id"]
    _search(client, owner, pid)
    web.routes[PDF_URL] = httpx.Response(200, headers={"Content-Type": "application/pdf"},
                                         content=make_pdf(SAMPLE_PAGES))
    paper_id = _paper_id(client, owner, pid, "10.5555/fx.0001")
    r = client.post(f"/api/v1/projects/{pid}/papers/{paper_id}/collect", headers=owner)
    assert r.status_code == 202 and r.json()["status"] == "succeeded", r.json()

    d = client.get(f"/api/v1/projects/{pid}/papers/{paper_id}", headers=owner).json()
    assert d["record_type"] == "collected" and d["access_status"] == "collected"
    assert d["processing_status"] == "ready"
    f = d["file"]
    assert f["access_basis"] == "oa_license" and f["license"] == "cc-by" and f["version"] == "acceptedVersion"
    assert f["source_url"] == PDF_URL and len(f["sha256"]) == 64 and f["page_count"] == 3
    assert d["chunk_count"] >= 3 and "equations" in d["unsupported_content"]

    chunks = client.get(f"/api/v1/projects/{pid}/papers/{paper_id}/chunks", headers=owner).json()
    assert {c["page_index"] for c in chunks} == {0, 1, 2}
    ev = client.get(f"/api/v1/projects/{pid}/papers/{paper_id}/evidence?query=serpentine cooling",
                    headers=owner).json()
    assert ev["matches"] and ev["matches"][0]["kind"] == "lexical_term_match"
    hit = next(m for m in ev["matches"] if "serpentine" in m["matched_terms"])
    assert hit["pdf_page_number"] == 2

    target = next(c for c in chunks if "serpentine" in c["text"])
    start = target["char_start"] + target["text"].index("serpentine")
    r = client.post(f"/api/v1/projects/{pid}/papers/{paper_id}/evidence", headers=owner,
                    json={"chunk_id": target["id"], "char_start": start, "char_end": start + 19, "note": "design"})
    assert r.status_code == 201 and r.json()["quote"] == "serpentine channels"
    bad = client.post(f"/api/v1/projects/{pid}/papers/{paper_id}/evidence", headers=owner,
                      json={"chunk_id": target["id"], "char_start": 0, "char_end": 999999})
    assert bad.status_code == 422

    pdf = client.get(f"/api/v1/projects/{pid}/papers/{paper_id}/pdf", headers=owner)
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")

    # re-collecting does not download or store a second copy
    web.requests.clear()
    r = client.post(f"/api/v1/projects/{pid}/papers/{paper_id}/collect", headers=owner,
                    json={"idempotency_key": "again"})
    assert r.json()["status"] == "succeeded"
    assert web.requests == []
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(File)) == 1
        assert db.scalar(select(func.count()).select_from(Embedding).where(Embedding.kind == "chunk")) >= 3


def test_restricted_and_disguised_pdfs_never_enter_corpus(client, owner, project, providers, web):
    pid = project["id"]
    _search(client, owner, pid)
    restricted = _paper_id(client, owner, pid, "10.5555/fx.0006")  # bronze: no licence
    r = client.post(f"/api/v1/projects/{pid}/papers/{restricted}/collect", headers=owner)
    assert r.json()["status"] == "failed"
    assert web.requests == []  # never even attempted
    d = client.get(f"/api/v1/projects/{pid}/papers/{restricted}", headers=owner).json()
    assert d["access_status"] == "access_restricted" and d["record_type"] == "discovery"

    web.routes[PDF_URL] = httpx.Response(200, headers={"Content-Type": "application/pdf"},
                                         content=b"<html><body>Sign in to continue</body></html>")
    pid1 = _paper_id(client, owner, pid, "10.5555/fx.0001")
    r = client.post(f"/api/v1/projects/{pid}/papers/{pid1}/collect", headers=owner)
    assert r.json()["status"] == "failed"
    d = client.get(f"/api/v1/projects/{pid}/papers/{pid1}", headers=owner).json()
    assert d["access_status"] == "invalid_pdf" and d["record_type"] == "discovery" and d["file"] is None
    ev = client.get(f"/api/v1/projects/{pid}/papers/{pid1}/evidence", headers=owner).json()
    assert ev["matches"] == [] and ev["record_type"] == "discovery"
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Chunk)) == 0


def test_search_with_permitted_oa_mode_auto_collects(client, owner, project, providers, web):
    web.routes[PDF_URL] = httpx.Response(200, content=make_pdf(SAMPLE_PAGES))
    web.routes["https://repo.example.org/files/fx0005.pdf"] = httpx.Response(503)
    s = _search(client, owner, project["id"], pdf_mode="permitted_oa")
    collect_job_id = s["jobs"][0]["result"]["collect_job_id"]
    cj = client.get(f"/api/v1/jobs/{collect_job_id}", headers=owner).json()
    assert cj["status"] == "partial"  # one collected, one fetch failure (503)
    assert cj["result"]["collected"] == 1
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Paper).where(Paper.in_corpus.is_(True))) == 1
        failed = db.scalar(select(Paper).where(Paper.access_status == "fetch_failed"))
        assert failed is not None and failed.in_corpus is False


def test_upload_requires_attestation_and_dedups_by_checksum(client, owner, project):
    pid = project["id"]
    pdf = make_pdf(SAMPLE_PAGES)
    files = {"file": ("paper.pdf", pdf, "application/pdf")}
    r = client.post(f"/api/v1/projects/{pid}/uploads", headers=owner, files=files,
                    data={"access_basis": "user_upload_own_work", "rights_attested": "false"})
    assert r.status_code == 422
    r = client.post(f"/api/v1/projects/{pid}/uploads", headers=owner, files=files,
                    data={"access_basis": "because", "rights_attested": "true"})
    assert r.status_code == 422
    r = client.post(f"/api/v1/projects/{pid}/uploads", headers=owner,
                    files={"file": ("x.pdf", b"<html>nope</html>", "application/pdf")},
                    data={"access_basis": "user_upload_own_work", "rights_attested": "true"})
    assert r.status_code == 422 and "HTML" in r.json()["detail"]
    r = client.post(f"/api/v1/projects/{pid}/uploads", headers=owner, files=files,
                    data={"access_basis": "user_upload_own_work", "rights_attested": "true",
                          "title": "My uploaded study", "doi": "https://doi.org/10.5555/UP.1"})
    assert r.status_code == 201, r.text
    first = r.json()
    d = client.get(f"/api/v1/projects/{pid}/papers/{first['paper_id']}", headers=owner).json()
    assert d["access_status"] == "user_uploaded" and d["processing_status"] == "ready"
    assert d["doi"] == "10.5555/up.1" and d["file"]["redistributable"] is False
    r = client.post(f"/api/v1/projects/{pid}/uploads", headers=owner, files=files,
                    data={"access_basis": "user_upload_own_work", "rights_attested": "true"})
    assert r.json()["duplicate"] is True and r.json()["paper_id"] == first["paper_id"]
    assert r.json()["dedup_basis"] == "file_checksum"
