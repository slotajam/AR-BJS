"""Record ingestion with conservative deduplication and full provenance.

Match order (first hit wins):
  1. normalized DOI
  2. stable provider identifier (openalex, pmid, pmcid, arxiv)
  3. file checksum (upload path, see services/acquisition.py)
  4. conservative title + first-author surname + year, only when it cannot conflict
  5. anything weaker -> new paper + DedupCandidate for manual review

Preprints and published versions are never merged; they are linked with a
``PaperRelation(relation="preprint_of")``.
"""

from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    AccessRecord,
    DedupCandidate,
    Paper,
    PaperAuthor,
    PaperIdentifier,
    PaperRelation,
    SourceObservation,
)
from app.services import access
from app.services.normalize import NormalizedRecord, author_surname, normalize_title

STABLE_SCHEMES = ("openalex", "pmid", "pmcid", "arxiv")
PREPRINT_TYPES = {"preprint", "posted-content"}
DISCOVERY_SOURCES = ("openalex", "crossref")
SCALAR_FIELDS = (
    "title", "abstract", "venue", "publication_year", "publication_date", "document_type", "language",
    "license", "is_retracted", "cited_by_count",
)
FUZZY_REVIEW_THRESHOLD = 0.85


@dataclass
class IngestResult:
    paper: Paper
    created: bool
    basis: str  # new | doi | provider_id | title_author_year


def _token_jaccard(a: str, b: str) -> float:
    sa, sb = set(a.split()), set(b.split())
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def _is_preprint(doc_type: str | None) -> bool:
    return (doc_type or "").lower() in PREPRINT_TYPES


def _first_surname(paper_or_rec) -> str:
    authors = paper_or_rec.authors
    if not authors:
        return ""
    return author_surname(authors[0].display_name)


def _find_by_doi(db: Session, project_id: str, doi: str | None) -> Paper | None:
    if not doi:
        return None
    return db.scalar(select(Paper).where(Paper.project_id == project_id, Paper.doi == doi))


def _find_by_identifier(db: Session, project_id: str, rec: NormalizedRecord) -> Paper | None:
    for scheme in STABLE_SCHEMES:
        val = rec.identifiers.get(scheme)
        if not val:
            continue
        pid = db.scalar(
            select(PaperIdentifier.paper_id).where(
                PaperIdentifier.project_id == project_id,
                PaperIdentifier.scheme == scheme,
                PaperIdentifier.value == val,
            )
        )
        if pid:
            return db.get(Paper, pid)
    return None


def _title_candidates(db: Session, project_id: str, rec: NormalizedRecord) -> list[Paper]:
    if not rec.title or not rec.publication_year:
        return []
    return list(
        db.scalars(
            select(Paper).where(
                Paper.project_id == project_id,
                Paper.publication_year.between(rec.publication_year - 2, rec.publication_year + 2),
                func.length(Paper.title) > 0,
            )
        )
    )


def _merge_into(paper: Paper, rec: NormalizedRecord) -> None:
    conflicts = dict(paper.conflicts or {})
    missing = dict(paper.missing_reasons or {})
    for f in SCALAR_FIELDS:
        new = getattr(rec, f)
        if new is None or new == "":
            continue
        cur = getattr(paper, f)
        if cur is None or cur == "":
            setattr(paper, f, new)
            missing.pop(f, None)
        elif (normalize_title(str(cur)) if f in ("title", "venue") else cur) != (
            normalize_title(str(new)) if f in ("title", "venue") else new
        ):
            entries = conflicts.setdefault(f, [])
            if not any(e["value"] == new and e["source"] == rec.source for e in entries):
                entries.append({"source": rec.source, "value": new})
    if not paper.doi and rec.doi:
        paper.doi = rec.doi
        missing.pop("doi", None)
    if rec.keywords:
        paper.keywords = sorted(set(paper.keywords or []) | set(rec.keywords))
    paper.conflicts = conflicts
    paper.missing_reasons = missing


def _add_identifiers(db: Session, paper: Paper, rec: NormalizedRecord) -> None:
    for scheme, value in rec.identifiers.items():
        exists = db.scalar(
            select(PaperIdentifier).where(
                PaperIdentifier.project_id == paper.project_id,
                PaperIdentifier.scheme == scheme,
                PaperIdentifier.value == value,
            )
        )
        if exists is None:
            db.add(PaperIdentifier(project_id=paper.project_id, paper_id=paper.id, scheme=scheme, value=value,
                                   source=rec.source))


def _add_authors(db: Session, paper: Paper, rec: NormalizedRecord) -> None:
    if paper.authors or not rec.authors:
        return
    for i, a in enumerate(rec.authors):
        paper.authors.append(
            PaperAuthor(position=i, display_name=a.display_name, orcid=a.orcid,
                        provider_author_id=a.provider_author_id, affiliations=a.affiliations, source=rec.source)
        )
    paper.missing_reasons = {k: v for k, v in (paper.missing_reasons or {}).items() if k != "authors"}


def _add_access_records(db: Session, paper: Paper, rec: NormalizedRecord) -> None:
    """Record every reported location with its access evaluation, then derive the paper status.
    Only discovery providers' reports change the status; imports without locations leave it unchecked."""
    if not rec.locations and rec.source not in DISCOVERY_SOURCES:
        return
    existing = {(a.url, a.source) for a in db.scalars(select(AccessRecord).where(AccessRecord.paper_id == paper.id))}
    for loc in rec.locations:
        ev = access.evaluate(loc)
        if (ev["url"], ev["source"]) not in existing:
            db.add(AccessRecord(paper_id=paper.id, **ev))
            existing.add((ev["url"], ev["source"]))
    db.flush()
    if paper.in_corpus or paper.access_status in ("collected", "user_uploaded"):
        return
    statuses = db.scalars(select(AccessRecord.status).where(AccessRecord.paper_id == paper.id))
    records = [{"status": st} for st in statuses]
    paper.access_status = access.paper_access_status(records)


def ingest_record(
    db: Session,
    project_id: str,
    rec: NormalizedRecord,
    *,
    origin: str,
    search_run_id: str | None = None,
    job_id: str | None = None,
    exact_query: str | None = None,
    is_fixture: bool = False,
) -> IngestResult:
    paper = _find_by_doi(db, project_id, rec.doi)
    basis = "doi" if paper else None
    if paper is None:
        paper = _find_by_identifier(db, project_id, rec)
        basis = "provider_id" if paper else None

    review: list[tuple[Paper, float, str]] = []
    preprint_links: list[tuple[Paper, str]] = []
    if paper is None and rec.title:
        nt = normalize_title(rec.title)
        surname = _first_surname(rec)
        for cand in _title_candidates(db, project_id, rec):
            ct = normalize_title(cand.title)
            if _is_preprint(cand.document_type) != _is_preprint(rec.document_type) and ct == nt:
                preprint_links.append((cand, "identical normalized title; one record is a preprint"))
                continue
            dois_conflict = bool(cand.doi and rec.doi and cand.doi != rec.doi)
            exact = (
                ct == nt
                and surname
                and _first_surname(cand) == surname
                and cand.publication_year == rec.publication_year
                and not dois_conflict
            )
            if exact and paper is None:
                paper, basis = cand, "title_author_year"
                continue
            sim = _token_jaccard(ct, nt)
            if sim >= FUZZY_REVIEW_THRESHOLD:
                review.append((cand, sim, f"title similarity {sim:.2f}; doi_conflict={dois_conflict}"))

    created = paper is None
    if created:
        paper = Paper(
            project_id=project_id,
            doi=rec.doi,
            origin=origin,
            is_fixture=is_fixture,
            access_status="not_checked",
            missing_reasons=dict(rec.missing_reasons),
            conflicts={},
            keywords=list(rec.keywords),
        )
        for f in SCALAR_FIELDS:
            setattr(paper, f, getattr(rec, f))
        db.add(paper)
        db.flush()
        basis = "new"
    else:
        _merge_into(paper, rec)

    _add_identifiers(db, paper, rec)
    _add_authors(db, paper, rec)
    db.add(
        SourceObservation(
            paper_id=paper.id,
            search_run_id=search_run_id,
            job_id=job_id,
            source=rec.source,
            source_record_id=rec.source_record_id,
            exact_query=exact_query,
            normalized=rec.to_observation(),
            raw=rec.raw,
            dedup_basis=basis,
        )
    )
    _add_access_records(db, paper, rec)

    if created:
        for cand, sim, reason in review:
            db.add(DedupCandidate(project_id=project_id, paper_a_id=cand.id, paper_b_id=paper.id, score=sim,
                                  reason=reason))
        for cand, reason in preprint_links:
            pre, pub = (paper, cand) if _is_preprint(rec.document_type) else (cand, paper)
            db.add(PaperRelation(project_id=project_id, paper_id=pre.id, related_paper_id=pub.id,
                                 relation="preprint_of", basis=reason))
    db.flush()
    return IngestResult(paper=paper, created=created, basis=basis or "new")
