from sqlalchemy import func, select

from app.db import session_factory
from app.models import DedupCandidate, Paper, SourceObservation
from app.services.importers import bibtex_records, csv_records, parse_doi_list, ris_records
from app.services.query import expand
from tests.test_search_jobs import _search

BIB = r"""
@article{fixture2023,
  title = {[FIXTURE] Liquid cooling plate design for lithium-ion battery thermal {M}anagement},
  author = {Fixture, Ada and Example, Ben},
  journal = "Fixture Journal of Energy Storage",
  year = 2023,
  doi = {https://doi.org/10.5555/FX.0001},
  keywords = {cooling; batteries}
}
@comment{ignored}
@inproceedings{fixture_noDOI,
  title = {[FIXTURE] A heat pipe approach for battery cooling},
  author = {Placeholder, Dara},
  booktitle = {Fixture Conference},
  year = {2019}
}
"""

RIS = """TY  - JOUR
TI  - [FIXTURE] Phase change materials for passive battery thermal regulation
AU  - Sample, Chai
PY  - 2021
DO  - 10.5555/fx.0002
JO  - Fixture Applied Thermal Letters
ER  -
TY  - UNPB
TI  - [FIXTURE] Grid-scale cooling notes
AU  - Mock, Eve
PY  - 2018///
ER  -
"""

CSV = """﻿DOI,Title,Authors,Year,Journal
10.5555/fx.0009,"=HYPERLINK(""x"")",Ann One; Bob Two,2022,Fixture J
,[FIXTURE] Liquid cooling plate design for lithium-ion battery thermal management,Ada Fixture,2023,Other venue
,,,,
"""


def test_parsers():
    assert parse_doi_list("doi:10.5555/A.1, https://doi.org/10.5555/a.1\n10.5555/b.2 junk") == ["10.5555/a.1",
                                                                                                "10.5555/b.2"]
    b = bibtex_records(BIB)
    assert len(b) == 2 and b[0].doi == "10.5555/fx.0001" and b[0].publication_year == 2023
    assert [a.display_name for a in b[0].authors] == ["Fixture, Ada", "Example, Ben"]
    assert b[0].title.endswith("thermal Management") and b[0].keywords == ["cooling", "batteries"]
    assert b[1].doi is None and b[1].missing_reasons["doi"] == "not_in_import_file"
    assert b[1].document_type == "proceedings"
    r = ris_records(RIS)
    assert [x.doi for x in r] == ["10.5555/fx.0002", None] and r[1].publication_year == 2018
    assert r[1].document_type == "preprint"
    c = csv_records(CSV)
    assert len(c) == 2 and c[0].authors[1].display_name == "Bob Two"


def test_deterministic_expansion():
    e = expand("q", ["heat pipe", "battery"], {"battery": ["cell", "BATTERY"]}, None, ["review"])
    assert e["text"] == '"heat pipe" AND (battery OR cell) NOT review'
    assert expand("q", [], {}, "a OR b", [])["basis"] == "user_boolean_query"
    assert expand("plain words", [], {}, None, [])["text"] == "plain words"


def test_import_dedups_against_search_results(client, owner, project, providers):
    pid = project["id"]
    _search(client, owner, pid)
    with session_factory()() as db:
        before = db.scalar(select(func.count()).select_from(Paper))
    r = client.post(f"/api/v1/projects/{pid}/imports", headers=owner, json={"format": "bibtex", "content": BIB})
    assert r.json()["status"] == "succeeded"
    assert r.json()["result"]["duplicates"] == 1 and r.json()["result"]["new"] == 1
    r = client.post(f"/api/v1/projects/{pid}/imports", headers=owner, json={"format": "ris", "content": RIS})
    assert r.json()["result"]["duplicates"] == 1
    r = client.post(f"/api/v1/projects/{pid}/imports", headers=owner, json={"format": "csv", "content": CSV})
    res = r.json()["result"]
    # row 2 has no DOI but identical title/first author/year -> conservative title match
    assert res["new"] == 1 and res["duplicates"] == 1
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Paper)) == before + 3
        p = db.scalar(select(Paper).where(Paper.doi == "10.5555/fx.0001"))
        obs = list(db.scalars(select(SourceObservation).where(SourceObservation.paper_id == p.id)))
        assert {o.source for o in obs} == {"openalex", "crossref", "import:bibtex", "import:csv"}
        assert {o.dedup_basis for o in obs if o.source == "import:csv"} == {"title_author_year"}
        assert p.conflicts["venue"]  # import venue differs; preserved, not overwritten


def test_doi_import_uses_connectors_and_ambiguous_titles_go_to_review(client, owner, project, providers):
    pid = project["id"]
    r = client.post(f"/api/v1/projects/{pid}/imports", headers=owner,
                    json={"format": "doi", "content": "10.5555/fx.0001\n10.5555/unknown.1"})
    res = r.json()
    assert res["status"] == "partial" and res["result"]["lookup_failed"] == 1 and res["result"]["new"] == 2
    with session_factory()() as db:
        p = db.scalar(select(Paper).where(Paper.doi == "10.5555/fx.0001"))
        assert p.title.startswith("[FIXTURE] Liquid cooling") and p.access_status == "permitted_available"
        stub = db.scalar(select(Paper).where(Paper.doi == "10.5555/unknown.1"))
        assert stub.title is None
        assert stub.missing_reasons["title"] == "doi_lookup_failed_or_connectors_unavailable"
    near = ("TY  - JOUR\nTI  - [FIXTURE] Liquid cooling plate design for lithium-ion battery thermal management "
            "systems\nAU  - Someone, Else\nPY  - 2023\nER  -\n")
    client.post(f"/api/v1/projects/{pid}/imports", headers=owner, json={"format": "ris", "content": near})
    cands = client.get(f"/api/v1/projects/{pid}/dedup-candidates", headers=owner).json()
    assert len(cands) == 1 and cands[0]["score"] >= 0.85
    r = client.post(f"/api/v1/projects/{pid}/dedup-candidates/{cands[0]['id']}/resolve", headers=owner,
                    json={"decision": "merged"})
    assert r.json()["status"] == "merged"
    with session_factory()() as db:
        p = db.scalar(select(Paper).where(Paper.doi == "10.5555/fx.0001"))
        assert {o.source for o in db.scalars(select(SourceObservation).where(SourceObservation.paper_id == p.id))} \
            == {"openalex", "import:ris"}
        assert db.scalar(select(DedupCandidate)).status == "merged"


def test_bad_import_format_fails_cleanly(client, owner, project):
    r = client.post(f"/api/v1/projects/{project['id']}/imports", headers=owner,
                    json={"format": "csv", "content": "foo,bar\n1,2\n"})
    assert r.json()["status"] == "failed" and "doi" in r.json()["error"]
