from datetime import date

import httpx
import pytest

from app.config import get_settings
from app.connectors import registry
from app.connectors.base import RateLimited, SearchQuery, parse_retry_after
from app.connectors.crossref import CrossrefConnector, parse_item
from app.connectors.openalex import OpenAlexConnector, parse_work
from app.db import session_factory
from tests.conftest import fixture_json


def test_openalex_parse_preserves_only_supplied_values():
    w = fixture_json("openalex_works_page1.json")["results"]
    r1 = parse_work(w[0])
    assert r1.doi == "10.5555/fx.0001"
    assert r1.identifiers["openalex"] == "W9000000001"
    assert r1.abstract.startswith("Liquid cooling plates reduce")
    assert r1.authors[0].orcid == "0000-0002-1825-0097"
    assert r1.authors[0].affiliations[0]["ror"] == "https://ror.org/00fixture1"
    assert r1.license == "cc-by"
    assert any(loc.pdf_url == "https://repo.example.org/files/fx0001.pdf" for loc in r1.locations)
    r2 = parse_work(w[1])
    assert r2.abstract is None and r2.missing_reasons["abstract"] == "not_provided_by_source"
    assert r2.license is None and "license" in r2.missing_reasons


def test_crossref_parse_strips_jats_and_maps_versions():
    items = fixture_json("crossref_works_page1.json")["message"]["items"]
    r = parse_item(items[0])
    assert r.abstract == "Liquid cooling plates reduce peak battery temperature during fast charging."
    assert r.publication_year == 2023 and r.publication_date == "2023-04-12"
    assert r.locations[0].version == "publishedVersion"
    assert r.locations[0].license.startswith("http://creativecommons.org")
    assert r.missing_reasons["is_retracted"] == "not_reported_on_crossref_work_record"
    r3 = parse_item(items[2])
    assert r3.authors == [] and r3.missing_reasons["authors"] == "not_provided_by_source"


def test_query_building_per_provider():
    s = get_settings()
    q = SearchQuery(text='(battery OR cell) AND "thermal management" NOT review', date_from=date(2020, 1, 1),
                    document_types=["article", "preprint"], languages=["en"])
    exact, params = OpenAlexConnector(s).build_query(q)
    assert exact == q.text
    assert params["filter"] == "from_publication_date:2020-01-01,language:en,type:article|preprint"
    exact, params = CrossrefConnector(s).build_query(q)
    assert exact == "battery cell thermal management"  # Crossref has no boolean syntax
    assert "type:journal-article" in params["filter"] and "type:posted-content" in params["filter"]


def test_retry_after_and_rate_limit():
    assert parse_retry_after("5") == 5.0
    assert parse_retry_after(None) is None
    calls = []

    def handler(req):
        calls.append(req)
        return httpx.Response(429, headers={"Retry-After": "1"})

    c = OpenAlexConnector(get_settings(), client=httpx.Client(transport=httpx.MockTransport(handler)))
    slept = []
    c.sleep = slept.append
    with pytest.raises(RateLimited):
        c.search_page(SearchQuery(text="x"), None, 10)
    assert len(calls) == get_settings().http_max_retries + 1  # bounded retries
    assert 1.0 in slept  # Retry-After honoured


def test_server_errors_retry_then_succeed():
    responses = [httpx.Response(503), httpx.Response(200, json=fixture_json("openalex_works_page2.json"))]
    c = OpenAlexConnector(get_settings(),
                          client=httpx.Client(transport=httpx.MockTransport(lambda r: responses.pop(0))))
    c.sleep = lambda s: None
    page = c.search_page(SearchQuery(text="x"), None, 10)
    assert len(page.records) == 2 and page.next_cursor is None


def test_status_states(monkeypatch, providers):
    with session_factory()() as db:
        states = {s["name"]: s for s in registry.status_report(db)}
        assert states["openalex"]["state"] == "available"
        assert states["openalex"]["documentation_url"].startswith("https://docs.openalex.org")
        assert states["openalex"]["verified_on"] is None  # never claim unverified live checks
        assert states["semantic_scholar"]["state"] == "disabled"
        registry.record_outcome(db, "crossref", error="boom")
        registry.record_outcome(db, "openalex", error="429", retry_after=300, rate_limited=True)
        db.commit()
        assert registry.connector_state(db, "crossref")[0] == "error"
        assert registry.connector_state(db, "openalex")[0] == "rate_limited"
        monkeypatch.setattr(get_settings(), "crossref_enabled", False)
        assert registry.connector_state(db, "crossref")[0] == "disabled"
