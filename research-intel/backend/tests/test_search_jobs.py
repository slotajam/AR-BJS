from sqlalchemy import func, select

from app.db import session_factory
from app.models import DedupCandidate, Paper, PaperRelation, SourceObservation

SEARCH = {
    "name": "Cooling",
    "original_query": "battery cooling",
    "keywords": ["battery", "thermal management"],
    "synonyms": {"battery": ["cell", "Battery"]},
    "exclusion_terms": ["erratum"],
    "sources": ["openalex", "crossref"],
    "result_limit": 50,
}


def _search(client, owner, pid, **over):
    r = client.post(f"/api/v1/projects/{pid}/searches", headers=owner, json={**SEARCH, **over})
    assert r.status_code == 201, r.text
    return r.json()


def test_search_runs_with_provenance_dedup_and_exclusions(client, owner, project, providers):
    pid = project["id"]
    s = _search(client, owner, pid)
    assert s["original_query"] == "battery cooling"
    assert s["expanded_query"]["text"] == '(battery OR cell) AND "thermal management" NOT erratum'
    assert s["expanded_query"]["ai_expansion"] is False
    job = s["jobs"][0]
    assert job["status"] == "succeeded", job
    runs = {r["source"]: r for r in s["runs"]}
    oa, cr = runs["openalex"], runs["crossref"]
    assert oa["exact_query"] == s["expanded_query"]["text"]
    assert cr["exact_query"] == "battery cell thermal management"  # NOT-terms dropped for Crossref
    assert oa["retrieved_count"] == 5 and oa["pagination"]["pages_fetched"] == 2
    assert oa["pagination"]["total_available"] == 5 and oa["partial_coverage"] is False
    assert cr["retrieved_count"] == 3
    assert cr["duplicate_count"] == 1  # fx.0001 already found by OpenAlex -> DOI merge
    assert cr["exclusion_count"] == 1  # "Erratum" title
    assert oa["started_at"] and oa["completed_at"]

    with session_factory()() as db:
        papers = list(db.scalars(select(Paper).where(Paper.project_id == pid)))
        assert len(papers) == 7  # 5 OpenAlex + 2 new Crossref
        merged = next(p for p in papers if p.doi == "10.5555/fx.0001")
        sources = set(db.scalars(select(SourceObservation.source).where(SourceObservation.paper_id == merged.id)))
        assert sources == {"openalex", "crossref"}
        assert merged.conflicts["venue"][0] == {"source": "crossref", "value": "Fixture J. Energy Storage"}
        assert merged.venue == "Fixture Journal of Energy Storage"  # first value kept, conflict preserved
        # preprint (fx.0003) and published version (fx.0004) are linked, not merged
        rel = db.scalar(select(PaperRelation))
        pre, pub = db.get(Paper, rel.paper_id), db.get(Paper, rel.related_paper_id)
        assert (pre.doi, pub.doi, rel.relation) == ("10.5555/fx.0003", "10.5555/fx.0004", "preprint_of")
        assert db.scalar(select(func.count()).select_from(DedupCandidate)) == 0
        by_doi = {p.doi: p for p in papers}
        assert by_doi["10.5555/fx.0001"].access_status == "permitted_available"
        assert by_doi["10.5555/fx.0002"].access_status == "unavailable"
        assert by_doi["10.5555/fx.0006"].access_status == "access_restricted"  # bronze: no licence
        assert by_doi["10.5555/fx.0004"].access_status == "access_restricted"  # TDM licence is not open
        assert by_doi["10.5555/fx.0007"].excluded is True
        no_doi = by_doi[None]
        assert no_doi.access_status == "permitted_available"  # repository OA copy
        assert no_doi.missing_reasons["doi"] == "not_provided_by_source"
        assert all(not p.in_corpus for p in papers)  # discovery only until collected

    r = client.get(f"/api/v1/projects/{pid}/papers", headers=owner).json()
    assert r["total"] == 6  # excluded record hidden by default
    r = client.get(f"/api/v1/projects/{pid}/papers?include_excluded=true&record_type=discovery", headers=owner)
    assert r.json()["total"] == 7


def test_one_failing_connector_does_not_block_others(client, owner, project, providers):
    providers.openalex_mode = "429"
    s = _search(client, owner, project["id"])
    runs = {r["source"]: r for r in s["runs"]}
    assert runs["openalex"]["status"] == "failed" or runs["openalex"]["status"] == "partial"
    assert runs["openalex"]["partial_coverage"] is True
    assert "rate limited" in runs["openalex"]["errors"][0]
    assert runs["crossref"]["status"] == "completed"
    assert s["jobs"][0]["status"] == "partial"
    st = {c["name"]: c for c in client.get("/api/v1/connectors/status", headers=owner).json()}
    assert st["openalex"]["state"] == "rate_limited"
    assert st["crossref"]["state"] == "available"


def test_retry_resumes_from_checkpoint_without_refetching(client, owner, project, providers):
    providers.openalex_mode = "fail_page2"
    s = _search(client, owner, project["id"], sources=["openalex"])
    job = s["jobs"][0]
    run = s["runs"][0]
    assert job["status"] == "partial" and run["status"] == "partial"
    assert run["retrieved_count"] == 3 and run["pagination"]["cursor"] == "FIXTURE_CURSOR_2"

    providers.openalex_mode = "ok"
    providers.calls.clear()
    r = client.post(f"/api/v1/jobs/{job['id']}/retry", headers=owner)
    assert r.status_code == 202
    assert r.json()["status"] == "succeeded" and r.json()["attempts"] == 2
    # only page 2 was requested on retry
    assert [c.url.params.get("cursor") for c in providers.calls] == ["FIXTURE_CURSOR_2"]
    s = client.get(f"/api/v1/searches/{s['id']}", headers=owner).json()
    assert s["runs"][0]["retrieved_count"] == 5 and s["runs"][0]["status"] == "completed"
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Paper)) == 5
    # a succeeded job cannot be retried
    assert client.post(f"/api/v1/jobs/{job['id']}/retry", headers=owner).status_code == 409


def test_idempotency_key_returns_same_job(client, owner, project, providers):
    a = _search(client, owner, project["id"], idempotency_key="k-1")
    b = _search(client, owner, project["id"], idempotency_key="k-1")
    assert a["id"] == b["id"] and a["jobs"][0]["id"] == b["jobs"][0]["id"]
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Paper)) == 7


def test_cancel_queued_job(client, owner, project, providers):
    s = _search(client, owner, project["id"], run_now=False)
    with session_factory()() as db:
        from app.services.jobs import create_job

        job, _ = create_job(db, project_id=project["id"], kind="search", params={"search_id": s["id"]},
                            user_id=None, idempotency_key=None)
        db.commit()
        jid = job.id
    r = client.post(f"/api/v1/jobs/{jid}/cancel", headers=owner)
    assert r.json()["status"] == "cancelled"
    from app.worker.tasks import execute_job

    execute_job(jid)  # a late delivery of a cancelled job is a no-op
    assert client.get(f"/api/v1/jobs/{jid}", headers=owner).json()["status"] == "cancelled"
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Paper)) == 0


def test_sse_progress_stream(client, owner, project, providers):
    s = _search(client, owner, project["id"])
    jid = s["jobs"][0]["id"]
    token = owner["Authorization"].split()[1]
    with client.stream("GET", f"/api/v1/jobs/{jid}/events?access_token={token}") as r:
        body = "".join(r.iter_text())
    assert "event: job" in body and "event: end" in body and '"status": "succeeded"' in body


def test_disabled_connector_is_skipped(client, owner, project, providers, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "crossref_enabled", False)
    s = _search(client, owner, project["id"])
    runs = {r["source"]: r for r in s["runs"]}
    assert runs["crossref"]["status"] == "skipped"
    assert s["jobs"][0]["status"] == "succeeded"


def test_ai_expansion_rejected(client, owner, project):
    r = client.post(f"/api/v1/projects/{project['id']}/searches", headers=owner,
                    json={**SEARCH, "ai_expansion_enabled": True})
    assert r.status_code == 422
