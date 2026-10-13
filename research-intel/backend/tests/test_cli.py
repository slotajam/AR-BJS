from sqlalchemy import select

from app import cli
from app.db import session_factory
from app.models import Paper, Project


def test_create_user_and_seed_fixture_project(monkeypatch, capsys):
    monkeypatch.setenv("RIP_NEW_USER_PASSWORD", "short")
    assert cli.main(["create-user", "c@example.org", "C"]) == 2
    monkeypatch.setenv("RIP_NEW_USER_PASSWORD", "long-enough-password")
    assert cli.main(["create-user", "c@example.org", "C"]) == 0
    assert cli.main(["create-user", "c@example.org", "C"]) == 1
    assert cli.main(["seed-demo", "missing@example.org"]) == 1
    assert cli.main(["seed-demo", "c@example.org"]) == 0
    with session_factory()() as db:
        p = db.scalar(select(Project))
        assert p.is_fixture and p.name.startswith("[FIXTURE]")
        papers = list(db.scalars(select(Paper)))
        assert papers and all(x.is_fixture for x in papers)
    assert cli.main([]) == 2


def test_verify_connectors_reports_failures_honestly(providers, tmp_path, monkeypatch):
    monkeypatch.setenv("RIP_VERIFY_REPORT", str(tmp_path / "report.json"))
    assert cli.main(["verify-connectors"]) == 0  # mocked providers answer
    providers.crossref_mode = "500"
    assert cli.main(["verify-connectors"]) == 1
    assert "error" in (tmp_path / "report.json").read_text()
