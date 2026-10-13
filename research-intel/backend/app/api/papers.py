import re

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import Response
from sqlalchemy import and_, asc, desc, func, or_, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.deps import audit, current_user, require_role
from app.models import (
    AccessRecord,
    Chunk,
    DedupCandidate,
    Evidence,
    Paper,
    PaperIdentifier,
    PaperNote,
    PaperRelation,
    Project,
    RankingScore,
    SourceObservation,
    User,
    UserCorrection,
)
from app.models import File as FileModel
from app.schemas import CollectIn, DedupResolveIn, EvidenceIn, ImportIn, JobOut, NoteIn, PaperPatch
from app.services import acquisition, parsing
from app.services.ingest import ingest_record
from app.services.jobs import create_job, enqueue
from app.services.normalize import NormalizedRecord
from app.services.ranking import latest_ranking, query_terms
from app.services.storage import get_storage

router = APIRouter(prefix="/projects/{project_id}", tags=["papers"])

SORTABLE = {
    "title": Paper.title, "publication_year": Paper.publication_year, "doi": Paper.doi, "venue": Paper.venue,
    "access_status": Paper.access_status, "processing_status": Paper.processing_status,
    "created_at": Paper.created_at, "relevance_score": RankingScore.score,
}
CORRECTABLE = {"title", "abstract", "venue", "publication_year", "document_type", "doi", "language"}


def _paper(db: Session, project_id: str, paper_id: str) -> Paper:
    p = db.get(Paper, paper_id)
    if p is None or p.project_id != project_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Paper not found")
    return p


def _sources(db: Session, paper_ids: list[str]) -> dict[str, list[str]]:
    out: dict[str, set] = {}
    if not paper_ids:
        return {}
    for pid, src in db.execute(select(SourceObservation.paper_id, SourceObservation.source)
                               .where(SourceObservation.paper_id.in_(paper_ids)).distinct()):
        out.setdefault(pid, set()).add(src)
    return {k: sorted(v) for k, v in out.items()}


@router.get("/papers")
def list_papers(
    project_id: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    sort: str = "relevance_score",
    order: str = Query("desc", pattern="^(asc|desc)$"),
    q: str | None = None,
    record_type: str = Query("all", pattern="^(all|collected|discovery)$"),
    access_status: str | None = None,
    processing_status: str | None = None,
    source: str | None = None,
    year_from: int | None = None,
    year_to: int | None = None,
    include_excluded: bool = False,
    tag: str | None = None,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    require_role(db, user, project_id, "viewer")
    ranking = latest_ranking(db, project_id)
    ranking_id = ranking.id if ranking else None
    stmt = select(Paper, RankingScore).outerjoin(
        RankingScore, and_(RankingScore.paper_id == Paper.id, RankingScore.ranking_id == ranking_id)
    ).where(Paper.project_id == project_id)
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(or_(func.lower(Paper.title).like(like), func.lower(Paper.doi).like(like),
                              func.lower(Paper.venue).like(like)))
    if record_type == "collected":
        stmt = stmt.where(Paper.in_corpus.is_(True))
    elif record_type == "discovery":
        stmt = stmt.where(Paper.in_corpus.is_(False))
    if access_status:
        stmt = stmt.where(Paper.access_status == access_status)
    if processing_status:
        stmt = stmt.where(Paper.processing_status == processing_status)
    if year_from:
        stmt = stmt.where(Paper.publication_year >= year_from)
    if year_to:
        stmt = stmt.where(Paper.publication_year <= year_to)
    if not include_excluded:
        stmt = stmt.where(Paper.excluded.is_(False))
    if source:
        stmt = stmt.where(Paper.id.in_(select(SourceObservation.paper_id).where(SourceObservation.source == source)))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    col = SORTABLE.get(sort, RankingScore.score)
    direction = desc if order == "desc" else asc
    stmt = stmt.order_by(direction(col).nulls_last(), Paper.id)
    rows = db.execute(stmt.offset((page - 1) * page_size).limit(page_size)).all()
    if tag:
        rows = [r for r in rows if tag in (r[0].tags or [])]
    srcs = _sources(db, [p.id for p, _ in rows])
    corrected = set(db.scalars(select(UserCorrection.paper_id).where(
        UserCorrection.paper_id.in_([p.id for p, _ in rows])).distinct())) if rows else set()
    items = []
    for p, sc in rows:
        items.append({
            "id": p.id, "doi": p.doi, "title": p.title,
            "authors": [a.display_name for a in p.authors[:5]], "author_count": len(p.authors),
            "venue": p.venue, "publication_year": p.publication_year, "document_type": p.document_type,
            "access_status": p.access_status, "processing_status": p.processing_status,
            "record_type": "collected" if p.in_corpus else "discovery",
            "relevance_score": sc.score if sc else None, "rank": sc.rank if sc else None,
            "coverage": sc.coverage if sc else None, "text_basis": sc.text_basis if sc else None,
            "sources": srcs.get(p.id, []), "screening_status": p.screening_status, "tags": p.tags,
            "excluded": p.excluded, "is_retracted": p.is_retracted, "is_fixture": p.is_fixture,
            "has_conflicts": bool(p.conflicts), "has_corrections": p.id in corrected,
        })
    return {"items": items, "total": total, "page": page, "page_size": page_size,
            "ranking": {"id": ranking.id, "version": ranking.version, "snapshot_at": ranking.snapshot_at,
                        "query": ranking.query, "weights": ranking.weights} if ranking else None}


@router.get("/papers/{paper_id}")
def get_paper(project_id: str, paper_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, user, project_id, "viewer")
    p = _paper(db, project_id, paper_id)
    f = acquisition.existing_file(db, p)
    ranking = latest_ranking(db, project_id)
    sc = db.scalar(select(RankingScore).where(RankingScore.ranking_id == ranking.id, RankingScore.paper_id == p.id)) \
        if ranking else None
    corrections = list(db.scalars(select(UserCorrection).where(UserCorrection.paper_id == p.id)
                                  .order_by(UserCorrection.created_at)))
    effective = {c.field: c.new_value for c in corrections}
    rels = db.scalars(select(PaperRelation).where(or_(PaperRelation.paper_id == p.id,
                                                      PaperRelation.related_paper_id == p.id)))
    chunk_count = db.scalar(select(func.count()).select_from(Chunk).where(Chunk.paper_id == p.id))
    return {
        "id": p.id, "project_id": p.project_id, "doi": p.doi, "title": p.title, "abstract": p.abstract,
        "venue": p.venue, "publication_year": p.publication_year, "publication_date": p.publication_date,
        "document_type": p.document_type, "language": p.language, "keywords": p.keywords, "license": p.license,
        "is_retracted": p.is_retracted, "cited_by_count": p.cited_by_count, "access_status": p.access_status,
        "processing_status": p.processing_status, "record_type": "collected" if p.in_corpus else "discovery",
        "origin": p.origin, "missing_reasons": p.missing_reasons, "conflicts": p.conflicts, "tags": p.tags,
        "screening_status": p.screening_status, "excluded": p.excluded, "exclusion_reason": p.exclusion_reason,
        "is_fixture": p.is_fixture, "created_at": p.created_at,
        "authors": [{"position": a.position, "display_name": a.display_name, "orcid": a.orcid,
                     "affiliations": a.affiliations, "source": a.source} for a in p.authors],
        "identifiers": [{"scheme": i.scheme, "value": i.value, "source": i.source} for i in p.identifiers],
        "provenance": [{"id": o.id, "source": o.source, "source_record_id": o.source_record_id,
                        "retrieved_at": o.retrieved_at, "search_run_id": o.search_run_id, "job_id": o.job_id,
                        "exact_query": o.exact_query, "dedup_basis": o.dedup_basis, "normalized": o.normalized}
                       for o in db.scalars(select(SourceObservation).where(SourceObservation.paper_id == p.id)
                                           .order_by(SourceObservation.retrieved_at))],
        "access_records": [{"id": a.id, "source": a.source, "url": a.url, "landing_page_url": a.landing_page_url,
                            "host_type": a.host_type, "version": a.version, "license": a.license,
                            "access_basis": a.access_basis, "permitted": a.permitted,
                            "redistributable": a.redistributable, "status": a.status, "error": a.error,
                            "checked_at": a.checked_at}
                           for a in db.scalars(select(AccessRecord).where(AccessRecord.paper_id == p.id))],
        "file": {"id": f.id, "sha256": f.sha256, "size_bytes": f.size_bytes, "page_count": f.page_count,
                 "source_url": f.source_url, "original_filename": f.original_filename,
                 "access_basis": f.access_basis, "license": f.license, "version": f.version,
                 "redistributable": f.redistributable, "downloaded_at": f.downloaded_at,
                 "validation": f.validation} if f else None,
        "chunk_count": chunk_count,
        "unsupported_content": parsing.UNSUPPORTED if p.in_corpus else None,
        "score": {"value": sc.score, "rank": sc.rank, "components": sc.components,
                  "effective_weights": sc.effective_weights, "coverage": sc.coverage, "text_basis": sc.text_basis,
                  "ranking_id": ranking.id, "version": ranking.version, "snapshot_at": ranking.snapshot_at,
                  "query": ranking.query} if sc else None,
        "corrections": [{"field": c.field, "old_value": c.old_value, "new_value": c.new_value, "reason": c.reason,
                         "user_id": c.user_id, "created_at": c.created_at} for c in corrections],
        "effective_values": effective,
        "relations": [{"paper_id": r.paper_id, "related_paper_id": r.related_paper_id, "relation": r.relation,
                       "basis": r.basis} for r in rels],
        "notes": [{"id": n.id, "user_id": n.user_id, "body": n.body, "created_at": n.created_at}
                  for n in db.scalars(select(PaperNote).where(PaperNote.paper_id == p.id)
                                      .order_by(PaperNote.created_at))],
    }


@router.patch("/papers/{paper_id}")
def patch_paper(project_id: str, paper_id: str, body: PaperPatch, request: Request,
                user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, user, project_id, "editor")
    p = _paper(db, project_id, paper_id)
    changes = {}
    for f in ("tags", "screening_status", "excluded", "exclusion_reason"):
        v = getattr(body, f)
        if v is not None:
            changes[f] = {"old": getattr(p, f), "new": v}
            setattr(p, f, v)
    for field, value in (body.corrections or {}).items():
        if field not in CORRECTABLE:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"field {field!r} cannot be corrected")
        prior = db.scalar(select(UserCorrection).where(UserCorrection.paper_id == p.id, UserCorrection.field == field)
                          .order_by(UserCorrection.created_at.desc()))
        old = prior.new_value if prior else getattr(p, field)
        db.add(UserCorrection(paper_id=p.id, user_id=user.id, field=field, old_value=old, new_value=value,
                              reason=body.correction_reason))
        changes[f"correction:{field}"] = {"old": old, "new": value}
    audit(db, user_id=user.id, project_id=project_id, action="paper.update", entity_type="paper", entity_id=p.id,
          details=changes, request=request)
    db.commit()
    return {"ok": True, "changes": changes}


@router.post("/papers/{paper_id}/notes", status_code=201)
def add_note(project_id: str, paper_id: str, body: NoteIn, request: Request, user: User = Depends(current_user),
             db: Session = Depends(get_db)):
    require_role(db, user, project_id, "editor")
    p = _paper(db, project_id, paper_id)
    n = PaperNote(paper_id=p.id, user_id=user.id, body=body.body)
    db.add(n)
    db.flush()
    audit(db, user_id=user.id, project_id=project_id, action="paper.note", entity_type="paper", entity_id=p.id,
          request=request)
    db.commit()
    return {"id": n.id}


@router.get("/papers/{paper_id}/chunks")
def list_chunks(project_id: str, paper_id: str, page_index: int | None = None, user: User = Depends(current_user),
                db: Session = Depends(get_db)):
    require_role(db, user, project_id, "viewer")
    p = _paper(db, project_id, paper_id)
    stmt = select(Chunk).where(Chunk.paper_id == p.id).order_by(Chunk.chunk_index)
    if page_index is not None:
        stmt = stmt.where(Chunk.page_index == page_index)
    return [{"id": c.id, "chunk_index": c.chunk_index, "page_index": c.page_index, "pdf_page_number": c.page_index + 1,
             "printed_page": c.printed_page, "section_label": c.section_label, "text": c.text,
             "char_start": c.char_start, "char_end": c.char_end, "bboxes": c.bboxes,
             "extraction_version": c.extraction_version} for c in db.scalars(stmt)]


def _snippet(text: str, terms: list[str], width: int = 220) -> tuple[str, int, int, list[str]] | None:
    low = text.lower()
    hits = [t for t in terms if re.search(rf"\b{re.escape(t)}", low)]
    if not hits:
        return None
    first = min(re.search(rf"\b{re.escape(t)}", low).start() for t in hits)
    start = max(0, first - width // 3)
    end = min(len(text), start + width)
    return text[start:end], start, end, hits


@router.get("/papers/{paper_id}/evidence")
def get_evidence(project_id: str, paper_id: str, query: str | None = None, limit: int = Query(20, le=200),
                 user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Saved evidence plus lexical term matches. Every item is page-linked to a collected PDF chunk.
    Discovery-only papers have no full text, so no evidence is returned for them."""
    require_role(db, user, project_id, "viewer")
    p = _paper(db, project_id, paper_id)
    if not p.in_corpus:
        return {"paper_id": p.id, "record_type": "discovery", "saved": [], "matches": [],
                "note": "No collected PDF: evidence requires a validated, authorised full text."}
    f = acquisition.existing_file(db, p)
    saved = []
    for e in db.scalars(select(Evidence).where(Evidence.paper_id == p.id).order_by(Evidence.page_index)):
        ch = db.get(Chunk, e.chunk_id)
        saved.append({"id": e.id, "chunk_id": e.chunk_id, "page_index": e.page_index,
                      "pdf_page_number": e.page_index + 1, "printed_page": ch.printed_page if ch else None,
                      "section_label": ch.section_label if ch else None, "char_start": e.char_start,
                      "char_end": e.char_end, "quote": e.quote, "note": e.note, "user_id": e.user_id,
                      "created_at": e.created_at, "file_sha256": f.sha256 if f else None})
    if query is None:
        r = latest_ranking(db, project_id)
        query = r.query if r else (db.get(Project, project_id).research_question or "")
    terms = query_terms(query)
    matches = []
    for c in db.scalars(select(Chunk).where(Chunk.paper_id == p.id).order_by(Chunk.chunk_index)):
        sn = _snippet(c.text, terms)
        if sn:
            text, s, e, hits = sn
            matches.append({"kind": "lexical_term_match", "chunk_id": c.id, "page_index": c.page_index,
                            "pdf_page_number": c.page_index + 1, "printed_page": c.printed_page,
                            "section_label": c.section_label, "snippet": text,
                            "char_start": c.char_start + s, "char_end": c.char_start + e,
                            "matched_terms": hits, "bboxes": c.bboxes})
        if len(matches) >= limit:
            break
    return {"paper_id": p.id, "record_type": "collected", "query": query, "query_terms": terms, "saved": saved,
            "matches": matches, "file_sha256": f.sha256 if f else None,
            "note": "Matches are lexical term hits located in extracted text; they are not AI-generated claims."}


@router.post("/papers/{paper_id}/evidence", status_code=201)
def add_evidence(project_id: str, paper_id: str, body: EvidenceIn, request: Request,
                 user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, user, project_id, "editor")
    p = _paper(db, project_id, paper_id)
    ch = db.get(Chunk, body.chunk_id)
    if ch is None or ch.paper_id != p.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Chunk not found for this paper")
    # offsets are page-text offsets; they must fall inside the chunk
    if not (ch.char_start <= body.char_start < body.char_end <= ch.char_end):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                            f"offsets must lie within chunk range [{ch.char_start}, {ch.char_end}]")
    quote = ch.text[body.char_start - ch.char_start: body.char_end - ch.char_start]
    e = Evidence(paper_id=p.id, chunk_id=ch.id, user_id=user.id, quote=quote, page_index=ch.page_index,
                 char_start=body.char_start, char_end=body.char_end, note=body.note)
    db.add(e)
    db.flush()
    audit(db, user_id=user.id, project_id=project_id, action="evidence.create", entity_type="evidence",
          entity_id=e.id, details={"paper_id": p.id, "page_index": ch.page_index}, request=request)
    db.commit()
    return {"id": e.id, "quote": quote, "page_index": e.page_index}


@router.get("/papers/{paper_id}/pdf")
def get_pdf(project_id: str, paper_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Stream the private PDF to an authorised project member for in-app viewing only."""
    require_role(db, user, project_id, "viewer")
    p = _paper(db, project_id, paper_id)
    f = acquisition.existing_file(db, p)
    if f is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No collected PDF")
    return Response(get_storage().get(f.storage_key), media_type="application/pdf",
                    headers={"Content-Disposition": "inline", "Cache-Control": "private, no-store",
                             "X-Content-Type-Options": "nosniff"})


@router.get("/papers/{paper_id}/pages/{page_index}")
def render_page(project_id: str, paper_id: str, page_index: int, zoom: float = Query(1.5, ge=0.5, le=3.0),
                user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Render one PDF page to PNG so the viewer works without a browser PDF plugin and can overlay
    chunk bounding boxes. X-Page-Width/Height give the page size in PDF points."""
    import pymupdf

    require_role(db, user, project_id, "viewer")
    p = _paper(db, project_id, paper_id)
    f = acquisition.existing_file(db, p)
    if f is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No collected PDF")
    doc = pymupdf.open(stream=get_storage().get(f.storage_key), filetype="pdf")
    try:
        if not 0 <= page_index < doc.page_count:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Page out of range")
        page = doc.load_page(page_index)
        png = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False).tobytes("png")
        w, h = page.rect.width, page.rect.height
    finally:
        doc.close()
    return Response(png, media_type="image/png",
                    headers={"Cache-Control": "private, max-age=300", "X-Page-Width": f"{w:.2f}",
                             "X-Page-Height": f"{h:.2f}",
                             "Access-Control-Expose-Headers": "X-Page-Width, X-Page-Height"})


@router.post("/papers/{paper_id}/collect", response_model=JobOut, status_code=202)
def collect_paper(project_id: str, paper_id: str, request: Request, body: CollectIn | None = None,
                  user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, user, project_id, "editor")
    p = _paper(db, project_id, paper_id)
    key = (body.idempotency_key if body else None) or f"collect:{p.id}"
    job, created = create_job(db, project_id=project_id, kind="collect", params={"paper_ids": [p.id]},
                              user_id=user.id, idempotency_key=key)
    if not created and job.status in ("failed", "partial", "cancelled") and not p.in_corpus:
        from app.services.jobs import prepare_retry

        prepare_retry(job)
        created = True
    if created:
        p.processing_status = "queued"
    audit(db, user_id=user.id, project_id=project_id, action="paper.collect", entity_type="job", entity_id=job.id,
          details={"paper_id": p.id}, request=request)
    db.commit()
    if created:
        enqueue(job)
        db.refresh(job)
    return job


UPLOAD_CHUNK = 1024 * 1024


@router.post("/uploads", status_code=201)
async def upload_pdf(
    project_id: str,
    request: Request,
    file: UploadFile = File(...),
    access_basis: str = Form(...),
    rights_attested: bool = Form(...),
    paper_id: str | None = Form(None),
    license: str | None = Form(None),
    version: str | None = Form(None),
    title: str | None = Form(None),
    doi: str | None = Form(None),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    require_role(db, user, project_id, "editor")
    if not rights_attested:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                            "You must attest that you have the right to upload and analyse this PDF")
    if access_basis not in acquisition.UPLOAD_BASES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                            f"access_basis must be one of {sorted(acquisition.UPLOAD_BASES)}")
    limit = get_settings().pdf_max_bytes
    buf = bytearray()
    while chunk := await file.read(UPLOAD_CHUNK):
        buf.extend(chunk)
        if len(buf) > limit:
            raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, f"PDF exceeds {limit} bytes")
    data = bytes(buf)
    from app.services.pdf_validate import validate_pdf

    v = validate_pdf(data, max_bytes=limit)
    if not v.ok:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"Invalid PDF: {v.error}")
    dup = db.scalar(select(FileModel).where(FileModel.project_id == project_id, FileModel.sha256 == v.sha256))
    if dup:
        return {"paper_id": dup.paper_id, "file_id": dup.id, "duplicate": True, "dedup_basis": "file_checksum",
                "job_id": None}
    project = db.get(Project, project_id)
    if paper_id:
        paper = _paper(db, project_id, paper_id)
        if paper.in_corpus:
            raise HTTPException(status.HTTP_409_CONFLICT, "Paper already has a collected PDF")
    else:
        rec = NormalizedRecord(source="upload", source_record_id=v.sha256, title=title or file.filename)
        from app.services.normalize import normalize_doi

        rec.doi = normalize_doi(doi)
        if rec.doi:
            rec.identifiers["doi"] = rec.doi
        rec.finalize("not_supplied_with_upload")
        paper = ingest_record(db, project_id, rec, origin="upload", is_fixture=project.is_fixture).paper
        if paper.in_corpus:
            raise HTTPException(status.HTTP_409_CONFLICT, "Matched paper already has a collected PDF")
    try:
        f = acquisition.store_upload(db, paper, data, filename=file.filename, access_basis=access_basis,
                                     license=license, version=version, user_id=user.id)
    except acquisition.AcquisitionError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    paper.in_corpus, paper.access_status, paper.processing_status = True, "user_uploaded", "queued"
    job, _ = create_job(db, project_id=project_id, kind="process", params={"paper_ids": [paper.id]},
                        user_id=user.id, idempotency_key=f"process:{f.sha256}")
    audit(db, user_id=user.id, project_id=project_id, action="paper.upload", entity_type="file", entity_id=f.id,
          details={"paper_id": paper.id, "sha256": f.sha256, "access_basis": access_basis, "license": license},
          request=request)
    db.commit()
    enqueue(job)
    return {"paper_id": paper.id, "file_id": f.id, "duplicate": False, "sha256": f.sha256, "job_id": job.id,
            "page_count": f.page_count}


@router.post("/imports", response_model=JobOut, status_code=202)
def import_records(project_id: str, body: ImportIn, request: Request, user: User = Depends(current_user),
                   db: Session = Depends(get_db)):
    require_role(db, user, project_id, "editor")
    job, created = create_job(db, project_id=project_id, kind="import",
                              params={"format": body.format, "content": body.content},
                              user_id=user.id, idempotency_key=body.idempotency_key)
    audit(db, user_id=user.id, project_id=project_id, action="import.create", entity_type="job", entity_id=job.id,
          details={"format": body.format, "bytes": len(body.content)}, request=request)
    db.commit()
    if created:
        enqueue(job)
        db.refresh(job)
    return job


@router.get("/dedup-candidates")
def list_dedup(project_id: str, status_filter: str = Query("pending", alias="status"),
               user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, user, project_id, "viewer")
    rows = db.scalars(select(DedupCandidate).where(DedupCandidate.project_id == project_id,
                                                   DedupCandidate.status == status_filter))
    out = []
    for c in rows:
        a, b = db.get(Paper, c.paper_a_id), db.get(Paper, c.paper_b_id)
        out.append({"id": c.id, "score": c.score, "reason": c.reason, "status": c.status,
                    "a": {"id": a.id, "title": a.title, "doi": a.doi, "year": a.publication_year},
                    "b": {"id": b.id, "title": b.title, "doi": b.doi, "year": b.publication_year}})
    return out


@router.post("/dedup-candidates/{candidate_id}/resolve")
def resolve_dedup(project_id: str, candidate_id: str, body: DedupResolveIn, request: Request,
                  user: User = Depends(current_user), db: Session = Depends(get_db)):
    """'merged' re-attaches B's observations, identifiers and access records to A (each keeps its own
    provenance) and deletes B. Refused when both papers have collected PDFs."""
    require_role(db, user, project_id, "editor")
    c = db.get(DedupCandidate, candidate_id)
    if c is None or c.project_id != project_id or c.status != "pending":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Pending candidate not found")
    if body.decision == "merged":
        a, b = db.get(Paper, c.paper_a_id), db.get(Paper, c.paper_b_id)
        if a.in_corpus and b.in_corpus:
            raise HTTPException(status.HTTP_409_CONFLICT, "Both papers have collected PDFs; resolve manually")
        if b.in_corpus:
            a, b = b, a
        for model in (SourceObservation, AccessRecord, PaperNote, Evidence, UserCorrection):
            for row in db.scalars(select(model).where(model.paper_id == b.id)):
                row.paper_id = a.id
        for ident in db.scalars(select(PaperIdentifier).where(PaperIdentifier.paper_id == b.id)):
            ident.paper_id = a.id
        conflicts = dict(a.conflicts or {})
        for f in ("title", "venue", "publication_year", "doi", "abstract"):
            va, vb = getattr(a, f), getattr(b, f)
            if va is None and vb is not None:
                setattr(a, f, vb)
            elif vb is not None and vb != va:
                conflicts.setdefault(f, []).append({"source": f"merged:{b.id}", "value": vb})
        a.conflicts = conflicts
        db.flush()
        for other in db.scalars(select(DedupCandidate).where(or_(DedupCandidate.paper_a_id == b.id,
                                                                 DedupCandidate.paper_b_id == b.id),
                                                             DedupCandidate.id != c.id)):
            db.delete(other)
        c.status, c.resolved_by = "merged", user.id
        c.paper_a_id = a.id
        c.paper_b_id = a.id
        db.flush()
        db.expire(b)  # drop stale collections so re-attached rows are not cascade-deleted
        db.delete(b)
    else:
        c.status, c.resolved_by = "distinct", user.id
    audit(db, user_id=user.id, project_id=project_id, action="dedup.resolve", entity_type="dedup_candidate",
          entity_id=c.id, details={"decision": body.decision}, request=request)
    db.commit()
    return {"ok": True, "status": c.status}

