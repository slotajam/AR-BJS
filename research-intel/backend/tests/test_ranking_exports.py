import csv
import io
import json
import zipfile

import httpx
import pytest

from app.services.exports import safe_cell
from app.services.ranking import bm25_scores, compose
from tests.conftest import SAMPLE_PAGES, make_pdf
from tests.test_pdf_pipeline import PDF_URL, _paper_id
from tests.test_search_jobs import _search


def test_compose_excludes_missing_and_renormalises():
    w = {"lexical": 0.6, "semantic": 0.4, "recency": 0.0}
    score, eff, cov = compose({"lexical": {"value": 0.5}, "semantic": {"value": 1.0}}, w)
    assert score == pytest.approx(0.7) and eff == {"lexical": 0.6, "semantic": 0.4} and cov == 1.0
    score, eff, cov = compose({"lexical": {"value": 0.5}, "semantic": {"value": None}}, w)
    assert score == 0.5 and eff == {"lexical": 1.0, "semantic": 0.0} and cov == pytest.approx(0.6)
    assert compose({"lexical": {"value": None}, "semantic": {"value": None}}, w) == (None, {"lexical": 0.0,
                                                                                         "semantic": 0.0}, 0.0)


def test_bm25_prefers_matching_docs():
    s = bm25_scores([["battery", "cooling"], ["solar", "panel"], ["battery"]], ["battery", "cooling"])
    assert s[0] > s[2] > s[1] == 0


def test_ranking_transparent_reproducible_and_missing_aware(client, owner, project, providers, web):
    pid = project["id"]
    _search(client, owner, pid)
    # add a record with no title/abstract (DOI-only import with lookups failing)
    providers.openalex_mode = "500"
    providers.crossref_mode = "500"
    r = client.post(f"/api/v1/projects/{pid}/imports", headers=owner, json={"format": "doi",
                                                                            "content": "10.5555/nothing.here"})
    assert r.json()["result"]["lookup_failed"] == 1
    providers.openalex_mode = providers.crossref_mode = "ok"
    web.routes[PDF_URL] = httpx.Response(200, content=make_pdf(SAMPLE_PAGES))
    collected = _paper_id(client, owner, pid, "10.5555/fx.0001")
    client.post(f"/api/v1/projects/{pid}/papers/{collected}/collect", headers=owner)

    body = {"query": "liquid cooling battery temperature", "weights": {"lexical": 0.5, "semantic": 0.3,
                                                                       "recency": 0.2}}
    a = client.post(f"/api/v1/projects/{pid}/rankings", headers=owner, json=body).json()
    b = client.post(f"/api/v1/projects/{pid}/rankings", headers=owner, json=body).json()
    assert a["version"] == "rank-v1" and a["id"] != b["id"]
    strip = lambda r: [(s["paper_id"], s["score"], s["rank"], s["coverage"]) for s in r["scores"]]  # noqa: E731
    assert strip(a) == strip(b)  # reproducible
    assert a["params"]["embedding"]["is_semantic"] is False  # hashing proxy is disclosed
    scores = {s["paper_id"]: s for s in a["scores"]}
    top = a["scores"][0]
    assert top["paper_id"] == collected and top["text_basis"] == "full_text" and top["rank"] == 1
    assert set(top["components"]) == {"lexical", "semantic", "recency"}
    assert 0 <= top["score"] <= 1 and sum(top["effective_weights"].values()) == pytest.approx(1.0)
    empty = next(s for s in scores.values() if s["text_basis"] == "none")
    assert empty["score"] is None and empty["rank"] is None and empty["coverage"] == 0.0
    no_year = next(s for s in scores.values() if s["components"]["recency"]["value"] is None
                   and s["text_basis"] != "none")
    assert no_year["coverage"] == pytest.approx(0.8)
    assert no_year["effective_weights"]["recency"] == 0.0

    lib = client.get(f"/api/v1/projects/{pid}/papers?sort=relevance_score", headers=owner).json()
    assert lib["items"][0]["id"] == collected and lib["ranking"]["version"] == "rank-v1"
    assert lib["items"][-1]["relevance_score"] is None  # nulls last

    viz = client.get(f"/api/v1/projects/{pid}/analytics", headers=owner).json()
    assert viz["total"] == 7 and viz["excluded_hidden"] == 1
    assert viz["missing_counts"]["relevance_score"] == 1
    assert viz["missing_counts"]["publication_year"] >= 1
    assert viz["embedding"]["pca_explained_variance"] is not None
    assert viz["dimensions"]["embedding_pc1"]["transform"].startswith("PCA")
    assert {p["record_type"] for p in viz["points"]} == {"collected", "discovery"}

    weights = client.post(f"/api/v1/projects/{pid}/rankings", headers=owner,
                          json={"query": "x", "weights": {"citations": 1}})
    assert weights.status_code == 422  # deferred components are rejected, never estimated


def test_csv_formula_injection_neutralised():
    for v in ("=HYPERLINK(\"x\")", "+1", "-2", "@SUM(A1)", "\t=1", "＝cmd"):
        assert safe_cell(v).startswith("'")
    assert safe_cell("normal") == "normal" and safe_cell(None) == ""


def _download(client, owner, pid, **body):
    r = client.post(f"/api/v1/projects/{pid}/exports", headers=owner, json=body)
    assert r.status_code == 202, r.text
    e = r.json()
    assert e["status"] == "ready", e
    z = client.get(e["download_url"], headers=owner)
    assert z.status_code == 200
    return zipfile.ZipFile(io.BytesIO(z.content)), e


def test_exports_are_scoped_provenance_rich_and_rights_aware(client, owner, project, providers, web):
    pid = project["id"]
    _search(client, owner, pid)
    web.routes[PDF_URL] = httpx.Response(200, content=make_pdf(SAMPLE_PAGES))
    collected = _paper_id(client, owner, pid, "10.5555/fx.0001")
    client.post(f"/api/v1/projects/{pid}/papers/{collected}/collect", headers=owner)
    client.post(f"/api/v1/projects/{pid}/rankings", headers=owner, json={})
    # inject a formula-looking tag
    client.patch(f"/api/v1/projects/{pid}/papers/{collected}", headers=owner, json={"tags": ["=cmd|' /C calc'!A0"]})

    z, e = _download(client, owner, pid, format="csv")
    assert set(z.namelist()) == {"data.csv", "manifest.json", "README.md"}
    assert not any(n.endswith(".pdf") for n in z.namelist())
    rows = list(csv.DictReader(io.StringIO(z.read("data.csv").decode("utf-8-sig"))))
    assert len(rows) == 6 and e["row_count"] == 6  # excluded record not in default scope
    row = next(r for r in rows if r["paper_id"] == collected)
    assert row["tags"].startswith("'=")
    assert row["record_type"] == "collected" and row["access_basis"] == "oa_license" and len(row["file_sha256"]) == 64
    assert row["sources"] == "crossref; openalex" and row["search_run_ids"] and row["exact_queries"]
    assert row["ranking_version"] == "rank-v1"
    manifest = json.loads(z.read("manifest.json"))
    assert manifest["project"]["research_question"] == "battery thermal management cooling"
    assert manifest["searches"][0]["original_query"] == "battery cooling"
    assert manifest["searches"][0]["expanded_query"]["text"].startswith("(battery OR cell)")
    assert {r["source"] for r in manifest["search_runs"]} == {"openalex", "crossref"}
    assert all(r["exact_query"] and r["started_at"] for r in manifest["search_runs"])
    assert manifest["rights"]["pdfs_included"] is False
    assert "null" in manifest["missing_data_definitions"]
    assert manifest["ranking"]["version"] == "rank-v1"

    z, e = _download(client, owner, pid, format="json", paper_ids=[collected])
    data = json.loads(z.read("data.json"))
    assert [r["paper_id"] for r in data["records"]] == [collected]
    rec = data["records"][0]
    assert rec["file"]["pdf_included_in_export"] is False
    assert {p["source"] for p in rec["provenance"]} == {"openalex", "crossref"}
    assert rec["components"]["lexical"]["value"] is not None

    z, _ = _download(client, owner, pid, format="json", record_type="discovery", include_excluded=True)
    assert len(json.loads(z.read("data.json"))["records"]) == 6


def test_viewer_can_export_but_not_mutate(client, owner, project, providers):
    from tests.conftest import register

    viewer = register(client, "v@example.org")
    client.put(f"/api/v1/projects/{project['id']}/members", headers=owner, json={"email": "v@example.org",
                                                                                  "role": "viewer"})
    _search(client, owner, project["id"])
    z, _ = _download(client, viewer, project["id"], format="csv")
    assert "data.csv" in z.namelist()
    outsider = register(client, "o@example.org")
    exports = client.get(f"/api/v1/projects/{project['id']}/exports", headers=owner).json()
    assert client.get(f"/api/v1/exports/{exports[0]['id']}", headers=outsider).status_code == 404
