"""Operational commands.

    python -m app.cli verify-connectors   # live check of OpenAlex / Crossref; writes a JSON report
    python -m app.cli resume-stale        # re-enqueue jobs orphaned by a crashed worker
    python -m app.cli create-user EMAIL NAME   (password read from RIP_NEW_USER_PASSWORD or prompt)
    python -m app.cli seed-demo OWNER_EMAIL     # labelled FIXTURE sample project (no network)
"""

import getpass
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import func, select

from app.connectors import registry
from app.connectors.base import SearchQuery
from app.db import session_factory
from app.models import Membership, Project, User
from app.security import hash_password

FIXTURES = Path(__file__).resolve().parent.parent / "tests" / "fixtures"


def verify_connectors() -> int:
    """Run one tiny live query + DOI lookup per connector and report what actually happened."""
    report = {"run_at": datetime.now(UTC).isoformat(), "results": []}
    ok_all = True
    with session_factory()() as db:
        for name in registry.names():
            conn = registry.get_connector(name)
            res = {"connector": name, "documentation_url": conn.info.documentation_url}
            try:
                page = conn.search_page(SearchQuery(text="thermal management battery"), None, 3)
                res["search"] = {"ok": True, "records": len(page.records), "total_available": page.total_available,
                                 "has_next_cursor": bool(page.next_cursor), "request_params": page.request_params,
                                 "sample_titles": [r.title for r in page.records]}
                doi = next((r.doi for r in page.records if r.doi), None)
                if doi:
                    rec = conn.get_by_doi(doi)
                    res["doi_lookup"] = {"ok": rec is not None, "doi": doi}
                registry.record_outcome(db, name)
            except Exception as e:  # noqa: BLE001
                ok_all = False
                res["error"] = f"{type(e).__name__}: {e}"
                registry.record_outcome(db, name, error=str(e)[:500])
            report["results"].append(res)
        db.commit()
    out = Path(os.environ.get("RIP_VERIFY_REPORT", "connector-verification.json"))
    out.write_text(json.dumps(report, indent=2, default=str))
    print(json.dumps(report, indent=2, default=str))
    return 0 if ok_all else 1


def create_user(email: str, name: str) -> int:
    pw = os.environ.get("RIP_NEW_USER_PASSWORD") or getpass.getpass("Password: ")
    if len(pw) < 10:
        print("password must be at least 10 characters", file=sys.stderr)
        return 2
    with session_factory()() as db:
        if db.scalar(select(User).where(func.lower(User.email) == email.lower())):
            print("user exists", file=sys.stderr)
            return 1
        db.add(User(email=email.lower(), display_name=name, password_hash=hash_password(pw)))
        db.commit()
    print(f"created {email}")
    return 0


def seed_demo(owner_email: str) -> int:
    """Create a sample project populated from the recorded FIXTURE responses (clearly labelled)."""
    from app.connectors.crossref import parse_item
    from app.connectors.openalex import parse_work
    from app.services.ingest import ingest_record

    with session_factory()() as db:
        owner = db.scalar(select(User).where(func.lower(User.email) == owner_email.lower()))
        if owner is None:
            print("owner not found; run create-user first", file=sys.stderr)
            return 1
        p = Project(name="[FIXTURE] Battery thermal management (sample)", is_fixture=True, created_by=owner.id,
                    research_question="Which thermal management strategies improve lithium-ion battery safety?",
                    description="Sample project built from recorded fixture data. Not live search results.")
        db.add(p)
        db.flush()
        db.add(Membership(project_id=p.id, user_id=owner.id, role="owner"))
        oa = json.loads((FIXTURES / "openalex_works_page1.json").read_text())
        cr = json.loads((FIXTURES / "crossref_works_page1.json").read_text())
        for w in oa["results"]:
            ingest_record(db, p.id, parse_work(w), origin="search", is_fixture=True)
        for it in cr["message"]["items"]:
            ingest_record(db, p.id, parse_item(it), origin="search", is_fixture=True)
        db.commit()
        print(f"created fixture project {p.id}")
    return 0


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    cmd, *args = argv
    if cmd == "verify-connectors":
        return verify_connectors()
    if cmd == "resume-stale":
        from app.worker.tasks import resume_stale

        print(resume_stale())
        return 0
    if cmd == "create-user" and len(args) == 2:
        return create_user(*args)
    if cmd == "seed-demo" and len(args) == 1:
        return seed_demo(args[0])
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
