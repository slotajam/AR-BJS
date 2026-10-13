"""Reproducible CSV / JSON exports bundled as a ZIP with manifest.json and README.md.

* PDFs are never included in Phase 1 exports (only their checksums and provenance).
* Every CSV cell that a spreadsheet could interpret as a formula is neutralised.
"""

import csv
import io
import json
import zipfile
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    AccessRecord,
    Chunk,
    Evidence,
    File,
    Paper,
    Project,
    RankingScore,
    Search,
    SearchRun,
    SourceObservation,
)
from app.services.ranking import latest_ranking

EXPORT_VERSION = "export-v1"
FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r", "\n", "＝", "＋", "－", "＠")

MISSING_DATA_DEFINITIONS = {
    "null": "Value not supplied by any source. See missing_reasons for the per-field reason.",
    "not_provided_by_source": "The provider's record had no value for this field.",
    "not_deposited_by_publisher": "Crossref: the publisher did not deposit this field.",
    "not_reported_on_crossref_work_record": "Crossref work records do not carry this field.",
    "relevance_score=null": "No ranking component was available (e.g. no title, abstract or full text).",
    "coverage": "Share of configured ranking weight whose component was available for the paper.",
}

CSV_COLUMNS = [
    "paper_id", "record_type", "doi", "title", "authors", "affiliations", "venue", "publication_year",
    "publication_date", "document_type", "language", "access_status", "processing_status", "license",
    "is_retracted", "relevance_score", "rank", "coverage", "text_basis", "lexical", "semantic", "recency",
    "effective_weights", "ranking_version", "ranking_snapshot_at", "sources", "first_retrieved_at",
    "search_run_ids", "exact_queries", "access_basis", "file_sha256", "file_source_url", "file_version",
    "file_license", "redistributable", "evidence_refs", "missing_reasons", "conflicts", "excluded",
    "exclusion_reason", "screening_status", "tags", "is_fixture",
]


def safe_cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    s = str(value)
    if s.startswith(FORMULA_PREFIXES):
        return "'" + s
    return s


def select_papers(db: Session, project_id: str, scope: dict) -> list[Paper]:
    stmt = select(Paper).where(Paper.project_id == project_id)
    if scope.get("paper_ids"):
        stmt = stmt.where(Paper.id.in_(scope["paper_ids"]))
    record_type = scope.get("record_type", "all")
    if record_type == "collected":
        stmt = stmt.where(Paper.in_corpus.is_(True))
    elif record_type == "discovery":
        stmt = stmt.where(Paper.in_corpus.is_(False))
    if not scope.get("include_excluded", False):
        stmt = stmt.where(Paper.excluded.is_(False))
    return list(db.scalars(stmt.order_by(Paper.id)))


def build_records(db: Session, project_id: str, papers: list[Paper]) -> tuple[list[dict], dict]:
    ranking = latest_ranking(db, project_id)
    scores = {}
    if ranking:
        scores = {s.paper_id: s for s in db.scalars(select(RankingScore).where(RankingScore.ranking_id == ranking.id))}
    records = []
    run_ids: set[str] = set()
    for p in papers:
        obs = list(db.scalars(select(SourceObservation).where(SourceObservation.paper_id == p.id)
                              .order_by(SourceObservation.retrieved_at)))
        f = db.scalar(select(File).where(File.paper_id == p.id))
        acc = list(db.scalars(select(AccessRecord).where(AccessRecord.paper_id == p.id)))
        ev = []
        for e in db.scalars(select(Evidence).where(Evidence.paper_id == p.id).order_by(Evidence.page_index)):
            ch = db.get(Chunk, e.chunk_id)
            ev.append({"page_index": e.page_index, "pdf_page_number": e.page_index + 1,
                       "printed_page": ch.printed_page if ch else None, "char_start": e.char_start,
                       "char_end": e.char_end, "quote": e.quote, "note": e.note,
                       "file_sha256": f.sha256 if f else None})
        sc = scores.get(p.id)
        runs = sorted({o.search_run_id for o in obs if o.search_run_id})
        run_ids.update(runs)
        records.append({
            "paper_id": p.id,
            "record_type": "collected" if p.in_corpus else "discovery",
            "doi": p.doi, "title": p.title,
            "authors": [{"name": a.display_name, "orcid": a.orcid, "position": a.position, "source": a.source}
                        for a in p.authors],
            "affiliations": sorted({af.get("name") for a in p.authors for af in a.affiliations if af.get("name")}),
            "abstract": p.abstract, "venue": p.venue, "publication_year": p.publication_year,
            "publication_date": p.publication_date, "document_type": p.document_type, "language": p.language,
            "keywords": p.keywords, "access_status": p.access_status, "processing_status": p.processing_status,
            "license": p.license, "is_retracted": p.is_retracted,
            "relevance_score": sc.score if sc else None, "rank": sc.rank if sc else None,
            "coverage": sc.coverage if sc else None, "text_basis": sc.text_basis if sc else None,
            "components": sc.components if sc else None,
            "effective_weights": sc.effective_weights if sc else None,
            "ranking_version": ranking.version if ranking else None,
            "ranking_snapshot_at": ranking.snapshot_at.isoformat() if ranking else None,
            "provenance": [{"source": o.source, "source_record_id": o.source_record_id,
                            "retrieved_at": o.retrieved_at.isoformat(), "search_run_id": o.search_run_id,
                            "exact_query": o.exact_query, "dedup_basis": o.dedup_basis} for o in obs],
            "access_records": [{"source": a.source, "url": a.url, "host_type": a.host_type, "version": a.version,
                                "license": a.license, "access_basis": a.access_basis, "permitted": a.permitted,
                                "status": a.status, "checked_at": a.checked_at.isoformat()} for a in acc],
            "file": {"sha256": f.sha256, "size_bytes": f.size_bytes, "page_count": f.page_count,
                     "source_url": f.source_url, "access_basis": f.access_basis, "license": f.license,
                     "version": f.version, "redistributable": f.redistributable,
                     "downloaded_at": f.downloaded_at.isoformat(), "pdf_included_in_export": False} if f else None,
            "evidence": ev,
            "missing_reasons": p.missing_reasons, "conflicts": p.conflicts,
            "excluded": p.excluded, "exclusion_reason": p.exclusion_reason,
            "screening_status": p.screening_status, "tags": p.tags, "is_fixture": p.is_fixture,
        })
    context = {"ranking": ranking, "search_run_ids": sorted(run_ids)}
    return records, context


def to_csv_row(r: dict) -> dict:
    comps = r["components"] or {}
    obs = r["provenance"]
    f = r["file"] or {}
    return {
        "paper_id": r["paper_id"], "record_type": r["record_type"], "doi": r["doi"], "title": r["title"],
        "authors": "; ".join(a["name"] for a in r["authors"]), "affiliations": "; ".join(r["affiliations"]),
        "venue": r["venue"], "publication_year": r["publication_year"], "publication_date": r["publication_date"],
        "document_type": r["document_type"], "language": r["language"], "access_status": r["access_status"],
        "processing_status": r["processing_status"], "license": r["license"], "is_retracted": r["is_retracted"],
        "relevance_score": r["relevance_score"], "rank": r["rank"], "coverage": r["coverage"],
        "text_basis": r["text_basis"],
        "lexical": (comps.get("lexical") or {}).get("value"), "semantic": (comps.get("semantic") or {}).get("value"),
        "recency": (comps.get("recency") or {}).get("value"), "effective_weights": r["effective_weights"],
        "ranking_version": r["ranking_version"], "ranking_snapshot_at": r["ranking_snapshot_at"],
        "sources": "; ".join(sorted({o["source"] for o in obs})),
        "first_retrieved_at": obs[0]["retrieved_at"] if obs else None,
        "search_run_ids": "; ".join(sorted({o["search_run_id"] for o in obs if o["search_run_id"]})),
        "exact_queries": "; ".join(sorted({o["exact_query"] for o in obs if o["exact_query"]})),
        "access_basis": f.get("access_basis"), "file_sha256": f.get("sha256"), "file_source_url": f.get("source_url"),
        "file_version": f.get("version"), "file_license": f.get("license"), "redistributable": f.get("redistributable"),
        "evidence_refs": " | ".join(
            f"PDF p.{e['pdf_page_number']}"
            + (f" (printed {e['printed_page']})" if e["printed_page"] else "")
            + f" [{e['char_start']}:{e['char_end']}] \"{e['quote'][:200]}\""
            for e in r["evidence"]
        ),
        "missing_reasons": r["missing_reasons"], "conflicts": r["conflicts"], "excluded": r["excluded"],
        "exclusion_reason": r["exclusion_reason"], "screening_status": r["screening_status"],
        "tags": "; ".join(r["tags"] or []), "is_fixture": r["is_fixture"],
    }


def build_manifest(db: Session, project: Project, scope: dict, fmt: str, records: list[dict], context: dict,
                   user_id: str) -> dict:
    searches = list(db.scalars(select(Search).where(Search.project_id == project.id).order_by(Search.created_at)))
    runs = list(db.scalars(select(SearchRun).join(Search).where(Search.project_id == project.id)
                           .order_by(SearchRun.started_at)))
    ranking = context["ranking"]
    return {
        "export_version": EXPORT_VERSION,
        "generated_at": datetime.now(UTC).isoformat(),
        "generated_by_user_id": user_id,
        "format": fmt,
        "project": {"id": project.id, "name": project.name, "research_question": project.research_question,
                    "is_fixture": project.is_fixture},
        "scope": scope,
        "record_count": len(records),
        "record_type_counts": {
            "collected": sum(1 for r in records if r["record_type"] == "collected"),
            "discovery": sum(1 for r in records if r["record_type"] == "discovery"),
        },
        "contains_fixture_records": any(r["is_fixture"] for r in records),
        "searches": [{
            "id": s.id, "name": s.name, "original_query": s.original_query, "expanded_query": s.expanded_query,
            "keywords": s.keywords, "synonyms": s.synonyms, "boolean_query": s.boolean_query,
            "date_from": s.date_from.isoformat() if s.date_from else None,
            "date_to": s.date_to.isoformat() if s.date_to else None,
            "languages": s.languages, "document_types": s.document_types,
            "inclusion_criteria": s.inclusion_criteria, "exclusion_criteria": s.exclusion_criteria,
            "exclusion_terms": s.exclusion_terms, "sources": s.sources, "result_limit": s.result_limit,
        } for s in searches],
        "search_runs": [{
            "id": r.id, "search_id": r.search_id, "source": r.source, "connector_version": r.connector_version,
            "exact_query": r.exact_query, "request_params": r.request_params, "filters": r.filters,
            "status": r.status, "started_at": r.started_at.isoformat() if r.started_at else None,
            "completed_at": r.completed_at.isoformat() if r.completed_at else None,
            "retrieved_count": r.retrieved_count, "new_count": r.new_count, "duplicate_count": r.duplicate_count,
            "exclusion_count": r.exclusion_count, "failure_count": r.failure_count,
            "partial_coverage": r.partial_coverage, "pagination": r.pagination, "errors": r.errors,
        } for r in runs],
        "ranking": {"id": ranking.id, "version": ranking.version, "query": ranking.query, "weights": ranking.weights,
                    "params": ranking.params, "snapshot_at": ranking.snapshot_at.isoformat()} if ranking else None,
        "missing_data_definitions": MISSING_DATA_DEFINITIONS,
        "rights": {
            "pdfs_included": False,
            "policy": "Phase 1 exports never include PDF files. Checksums and access basis are exported so "
                      "files can be re-acquired from their recorded, permitted sources.",
        },
        "csv_safety": "Cells beginning with = + - @ tab or CR are prefixed with an apostrophe.",
        "columns": CSV_COLUMNS if fmt == "csv" else None,
    }


README = """# Research Intelligence Platform export

Files
- data.{ext}       the exported records ({fmt})
- manifest.json    project question, exact queries, sources, retrieval dates, filters,
                   exclusions, ranking version/weights, missing-data definitions

Notes
- record_type = "discovery" means metadata only (no PDF collected).
- record_type = "collected" means a validated PDF was collected on the recorded access basis.
- PDFs are NOT included. Use file_sha256 + file_source_url to verify re-acquired copies.
- Relevance scores (ranking {ranking}) are a discovery heuristic, not a quality judgement.
- Records flagged is_fixture = true are test/demo data, not live results.
"""


def build_bundle(db: Session, project: Project, scope: dict, fmt: str, user_id: str) -> tuple[bytes, dict, int]:
    papers = select_papers(db, project.id, scope)
    records, context = build_records(db, project.id, papers)
    manifest = build_manifest(db, project, scope, fmt, records, context, user_id)
    if fmt == "csv":
        sio = io.StringIO()
        w = csv.DictWriter(sio, fieldnames=CSV_COLUMNS, quoting=csv.QUOTE_ALL)
        w.writeheader()
        for r in records:
            w.writerow({k: safe_cell(v) for k, v in to_csv_row(r).items()})
        data = sio.getvalue().encode("utf-8-sig")
    elif fmt == "json":
        data = json.dumps({"manifest": manifest, "records": records}, ensure_ascii=False, indent=2,
                          default=str).encode()
    else:
        raise ValueError(f"unsupported format {fmt}")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"data.{fmt}", data)
        z.writestr("manifest.json", json.dumps(manifest, indent=2, default=str))
        ranking = context["ranking"]
        z.writestr("README.md", README.format(ext=fmt, fmt=fmt.upper(),
                                              ranking=ranking.version if ranking else "none"))
    return buf.getvalue(), manifest, len(records)
