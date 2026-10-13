"""Job runners. Each runner is idempotent and resumes from ``Job.state`` / ``SearchRun.pagination``."""

import logging
import traceback
from datetime import UTC, datetime

from sqlalchemy import delete, select

from app.connectors import registry
from app.connectors.base import ConnectorError, RateLimited, SearchQuery
from app.db import session_factory
from app.models import Chunk, Embedding, Export, File, Job, Paper, Project, Search, SearchRun, SourceObservation
from app.services import acquisition, exports, importers, parsing
from app.services.embeddings import get_embedder, text_hash
from app.services.ingest import ingest_record
from app.services.jobs import JobCancelled, JobContext
from app.services.normalize import NormalizedRecord
from app.services.storage import get_storage
from app.worker.celery_app import celery

log = logging.getLogger(__name__)
PAGE_SIZE = 100


def now():
    return datetime.now(UTC)


@celery.task(name="rip.run_job", bind=True, max_retries=0)
def run_job(self, job_id: str) -> None:
    execute_job(job_id)


def execute_job(job_id: str) -> None:
    db = session_factory()()
    try:
        job = db.get(Job, job_id)
        if job is None or job.status in ("succeeded", "cancelled"):
            return  # duplicate delivery of a finished job is a no-op
        if job.cancel_requested:
            job.status, job.stage, job.finished_at = "cancelled", "cancelled", now()
            db.commit()
            return
        job.status, job.attempts = "running", (job.attempts or 0) + 1
        job.started_at = job.started_at or now()
        db.commit()
        ctx = JobContext(db, job)
        runner = RUNNERS[job.kind]
        try:
            status = runner(ctx)
            job.status = status or "succeeded"
            job.stage = "done" if job.status == "succeeded" else job.status
            if job.status == "succeeded":
                job.progress = 1.0
        except JobCancelled:
            db.rollback()
            job = db.get(Job, job_id)
            job.status, job.stage = "cancelled", "cancelled"
        except Exception as e:  # noqa: BLE001 - recorded on the job, never swallowed silently
            db.rollback()
            log.exception("job %s failed", job_id)
            job = db.get(Job, job_id)
            job.status, job.stage = "failed", "failed"
            job.error = f"{type(e).__name__}: {e}\n{traceback.format_exc(limit=5)}"
            if job.kind == "export":
                exp = db.get(Export, job.params.get("export_id"))
                if exp:
                    exp.status, exp.error = "failed", f"{type(e).__name__}: {e}"
        job.finished_at = now()
        db.commit()
    finally:
        db.close()


# ---------------------------------------------------------------- search


def _excluded(rec: NormalizedRecord, terms: list[str]) -> str | None:
    hay = f"{rec.title or ''} {rec.abstract or ''}".lower()
    for t in terms:
        if t.strip() and t.lower() in hay:
            return f"exclusion term '{t}' in title/abstract"
    return None


def run_search(ctx: JobContext) -> str:
    db, job = ctx.db, ctx.job
    search = db.get(Search, job.params["search_id"])
    project = db.get(Project, job.project_id)
    q = SearchQuery(text=search.expanded_query["text"], date_from=search.date_from, date_to=search.date_to,
                    languages=search.languages or [], document_types=search.document_types or [])
    sources = search.sources or registry.names()
    outcomes = []
    for si, source in enumerate(sources):
        run = db.scalar(select(SearchRun).where(SearchRun.job_id == job.id, SearchRun.source == source))
        if run is not None and run.status in ("completed", "skipped"):
            outcomes.append(run.status)
            continue
        try:
            conn = registry.get_connector(source)
        except KeyError:
            conn = None
        if run is None:
            exact, params = conn.build_query(q) if conn else (q.text, {})
            run = SearchRun(search_id=search.id, job_id=job.id, source=source, exact_query=exact,
                            request_params=params, result_limit=search.result_limit,
                            connector_version=conn.info.version if conn else "unknown",
                            filters={"date_from": str(search.date_from) if search.date_from else None,
                                     "date_to": str(search.date_to) if search.date_to else None,
                                     "languages": search.languages, "document_types": search.document_types,
                                     "exclusion_terms": search.exclusion_terms},
                            pagination={"cursor": None, "pages_fetched": 0})
            db.add(run)
            db.commit()
        state, detail = registry.connector_state(db, source) if conn else ("unconfigured", "unknown connector")
        if state in ("disabled", "unconfigured"):
            run.status, run.errors = "skipped", [*(run.errors or []), f"connector {state}: {detail}"]
            run.completed_at = now()
            db.commit()
            outcomes.append("skipped")
            continue
        run.status, run.started_at = "running", run.started_at or now()
        db.commit()
        cursor = (run.pagination or {}).get("cursor")
        try:
            while run.retrieved_count < run.result_limit:
                ctx.stage(f"search:{source}", (si + run.retrieved_count / max(run.result_limit, 1)) / len(sources))
                page = conn.search_page(q, cursor, min(PAGE_SIZE, run.result_limit - run.retrieved_count))
                for rec in page.records[: run.result_limit - run.retrieved_count]:
                    run.retrieved_count += 1
                    try:
                        with db.begin_nested():
                            res = ingest_record(db, job.project_id, rec, origin="search", search_run_id=run.id,
                                                job_id=job.id, exact_query=run.exact_query,
                                                is_fixture=project.is_fixture)
                            if res.created:
                                run.new_count += 1
                                reason = _excluded(rec, search.exclusion_terms or [])
                                if reason:
                                    res.paper.excluded, res.paper.exclusion_reason = True, reason
                                    run.exclusion_count += 1
                            else:
                                run.duplicate_count += 1
                    except Exception as e:  # noqa: BLE001 - per-record failure is counted, not fatal
                        run.failure_count += 1
                        run.errors = [*(run.errors or []), f"record {rec.source_record_id}: {e}"][-50:]
                cursor = page.next_cursor
                run.pagination = {"cursor": cursor, "pages_fetched": (run.pagination or {}).get("pages_fetched", 0) + 1,
                                  "total_available": page.total_available, "per_page": PAGE_SIZE,
                                  "last_request": {"url": page.request_url, "params": page.request_params}}
                db.commit()  # durable checkpoint after every page
                if not cursor or not page.records:
                    break
            registry.record_outcome(db, source)
            total = (run.pagination or {}).get("total_available")
            run.partial_coverage = bool(total and total > run.retrieved_count)
            run.status = "completed"
        except RateLimited as e:
            registry.record_outcome(db, source, error=str(e), retry_after=e.retry_after, rate_limited=True)
            run.status, run.partial_coverage = "partial", True
            run.errors = [*(run.errors or []), f"rate limited: retry after {e.retry_after}s"]
        except (ConnectorError, Exception) as e:  # noqa: BLE001 - one connector must not stop the others
            if isinstance(e, JobCancelled):
                run.status = "cancelled"
                db.commit()
                raise
            db.rollback()
            run = db.get(SearchRun, run.id)
            registry.record_outcome(db, source, error=str(e)[:500])
            run.status = "partial" if run.retrieved_count else "failed"
            run.partial_coverage = True
            run.errors = [*(run.errors or []), f"{type(e).__name__}: {str(e)[:500]}"]
        run.completed_at = now()
        db.commit()
        outcomes.append(run.status)

    job.result = {"runs": [
        {"source": r.source, "status": r.status, "retrieved": r.retrieved_count, "new": r.new_count,
         "duplicates": r.duplicate_count, "excluded": r.exclusion_count, "failures": r.failure_count}
        for r in db.scalars(select(SearchRun).where(SearchRun.job_id == job.id))
    ]}
    if search.pdf_mode == "permitted_oa":
        _enqueue_collection(db, job)
    ran = [o for o in outcomes if o != "skipped"]
    if not ran:
        job.error = "no configured connectors were available"
        return "failed"
    if all(o == "completed" for o in ran):
        return "succeeded"
    if any(o in ("completed", "partial") for o in ran):
        return "partial"
    return "failed"


def _enqueue_collection(db, job: Job) -> None:
    from app.services.jobs import create_job, enqueue

    ids = list(db.scalars(
        select(Paper.id)
        .join(SourceObservation, SourceObservation.paper_id == Paper.id)
        .join(SearchRun, SearchRun.id == SourceObservation.search_run_id)
        .where(SearchRun.job_id == job.id, Paper.access_status == "permitted_available",
               Paper.in_corpus.is_(False), Paper.excluded.is_(False))
        .distinct()
    ))
    if not ids:
        return
    cj, created = create_job(db, project_id=job.project_id, kind="collect", params={"paper_ids": ids},
                             user_id=job.created_by, idempotency_key=f"auto-collect:{job.id}")
    db.commit()
    job.result = {**job.result, "collect_job_id": cj.id}
    if created:
        enqueue(cj)


# ---------------------------------------------------------------- collection & processing


def process_paper(db, paper: Paper, file: File) -> None:
    """parsing -> extracting -> embedding -> ready. Re-entrant: clears prior chunks for the file."""
    paper.processing_status = "parsing"
    db.commit()
    data = get_storage().get(file.storage_key)
    result = parsing.parse_pdf(data)
    paper.processing_status = "extracting"
    db.execute(delete(Chunk).where(Chunk.file_id == file.id))
    chunks = []
    for c in result.chunks:
        ch = Chunk(file_id=file.id, paper_id=paper.id, chunk_index=c.chunk_index, page_index=c.page_index,
                   printed_page=c.printed_page, section_label=c.section_label, text=c.text,
                   char_start=c.char_start, char_end=c.char_end, bboxes=c.bboxes,
                   extraction_version=result.extraction_version)
        db.add(ch)
        chunks.append(ch)
    file.validation = {**(file.validation or {}), "extraction": {
        "version": result.extraction_version, "page_count": result.page_count, "chunk_count": len(chunks),
        "pages_without_text": result.pages_without_text, "unsupported": result.unsupported}}
    db.commit()
    paper.processing_status = "embedding"
    db.commit()
    embedder = get_embedder()
    db.execute(delete(Embedding).where(Embedding.paper_id == paper.id, Embedding.kind == "chunk"))
    if chunks:
        vecs = embedder.embed([c.text for c in chunks])
        for c, v in zip(chunks, vecs, strict=True):
            db.add(Embedding(project_id=paper.project_id, paper_id=paper.id, chunk_id=c.id, kind="chunk",
                             provider=embedder.provider, model=embedder.model, dim=int(v.shape[0]),
                             text_sha256=text_hash(c.text), vector=v.tolist()))
    # No text at all (e.g. scanned PDF; OCR is deferred) -> needs human review.
    paper.processing_status = "ready" if chunks else "needs_review"
    db.commit()


def run_collect(ctx: JobContext) -> str:
    db, job = ctx.db, ctx.job
    ids = job.params.get("paper_ids", [])
    done = set((job.state or {}).get("done", []))
    failed: dict = dict((job.state or {}).get("failed", {}))
    for i, pid in enumerate(ids):
        if pid in done:
            continue
        ctx.stage("collecting", i / max(len(ids), 1))
        q = select(Paper).where(Paper.id == pid, Paper.project_id == job.project_id)
        if db.bind.dialect.name == "postgresql":
            q = q.with_for_update()  # serialise concurrent collection of the same paper
        paper = db.scalar(q)
        if paper is None:
            continue
        try:
            existing = acquisition.existing_file(db, paper)
            if existing is None:
                paper.processing_status = "downloading"
                db.commit()
                file = acquisition.collect_from_access_record(db, paper)
                paper.processing_status = "validating"
                paper.in_corpus, paper.access_status = True, "collected"
                db.commit()
            else:
                file = existing
            if paper.processing_status != "ready":
                process_paper(db, paper, file)
            done.add(pid)
            failed.pop(pid, None)
        except acquisition.AcquisitionError as e:
            db.rollback()
            paper = db.get(Paper, pid)
            paper.access_status = e.access_status
            paper.processing_status = "failed"
            failed[pid] = str(e)
            db.commit()
        except JobCancelled:
            raise
        except Exception as e:  # noqa: BLE001
            db.rollback()
            paper = db.get(Paper, pid)
            paper.processing_status = "failed"
            failed[pid] = f"{type(e).__name__}: {e}"
            db.commit()
        ctx.checkpoint(done=sorted(done), failed=failed)
    job.result = {"collected": len(done), "failed": failed}
    if not failed:
        return "succeeded"
    return "partial" if done else "failed"


def run_process(ctx: JobContext) -> str:
    db, job = ctx.db, ctx.job
    failed = {}
    ids = job.params.get("paper_ids", [])
    for i, pid in enumerate(ids):
        ctx.stage("processing", i / max(len(ids), 1))
        paper = db.get(Paper, pid)
        file = acquisition.existing_file(db, paper) if paper else None
        if not paper or not file:
            failed[pid] = "no collected file"
            continue
        try:
            process_paper(db, paper, file)
        except JobCancelled:
            raise
        except Exception as e:  # noqa: BLE001
            db.rollback()
            paper = db.get(Paper, pid)
            paper.processing_status = "failed"
            failed[pid] = f"{type(e).__name__}: {e}"
            db.commit()
    job.result = {"processed": len(ids) - len(failed), "failed": failed}
    return "succeeded" if not failed else ("partial" if len(failed) < len(ids) else "failed")


# ---------------------------------------------------------------- imports & exports


def _lookup_doi(db, doi: str) -> NormalizedRecord | None:
    for name in registry.names():
        state, _ = registry.connector_state(db, name)
        if state != "available":
            continue
        try:
            rec = registry.get_connector(name).get_by_doi(doi)
            registry.record_outcome(db, name)
            if rec:
                return rec
        except RateLimited as e:
            registry.record_outcome(db, name, error=str(e), retry_after=e.retry_after, rate_limited=True)
        except Exception as e:  # noqa: BLE001
            registry.record_outcome(db, name, error=str(e)[:500])
    return None


def run_import(ctx: JobContext) -> str:
    db, job = ctx.db, ctx.job
    fmt = job.params["format"]
    project = db.get(Project, job.project_id)
    counts = {"records": 0, "new": 0, "duplicates": 0, "lookup_failed": 0, "failed": 0}
    errors = []
    if fmt == "doi":
        dois = importers.parse_doi_list(job.params["content"])
        records = []
        for i, d in enumerate(dois):
            ctx.stage("resolving_dois", i / max(len(dois), 1))
            rec = _lookup_doi(db, d)
            if rec is None:
                counts["lookup_failed"] += 1
                rec = NormalizedRecord(source="import:doi", source_record_id=d, doi=d, identifiers={"doi": d})
                rec.finalize("doi_lookup_failed_or_connectors_unavailable")
            records.append(rec)
    else:
        records = importers.parse_import(fmt, job.params["content"])
    for i, rec in enumerate(records):
        ctx.stage("ingesting", i / max(len(records), 1))
        counts["records"] += 1
        try:
            with db.begin_nested():
                res = ingest_record(db, job.project_id, rec, origin="import", job_id=job.id,
                                    is_fixture=project.is_fixture)
            counts["new" if res.created else "duplicates"] += 1
        except Exception as e:  # noqa: BLE001
            counts["failed"] += 1
            errors.append(f"{rec.source_record_id}: {e}")
        db.commit()
    job.result = {**counts, "errors": errors[:50]}
    if counts["failed"] and counts["failed"] == counts["records"]:
        return "failed"
    return "partial" if counts["failed"] or counts["lookup_failed"] else "succeeded"


def run_export(ctx: JobContext) -> str:
    db, job = ctx.db, ctx.job
    exp = db.get(Export, job.params["export_id"])
    project = db.get(Project, job.project_id)
    ctx.stage("building", 0.2)
    data, manifest, n = exports.build_bundle(db, project, exp.scope, exp.format, exp.created_by)
    key = f"projects/{project.id}/exports/{exp.id}.zip"
    get_storage().put(key, data, "application/zip")
    exp.storage_key, exp.manifest, exp.row_count, exp.status = key, manifest, n, "ready"
    job.result = {"export_id": exp.id, "rows": n}
    return "succeeded"


RUNNERS = {
    "search": run_search,
    "collect": run_collect,
    "process": run_process,
    "import": run_import,
    "export": run_export,
}


def resume_stale() -> list[str]:
    """Re-enqueue jobs left 'running' by a crashed worker (run from cron or `python -m app.cli`)."""
    from app.services.jobs import enqueue, stale_running_jobs

    db = session_factory()()
    try:
        jobs = stale_running_jobs(db)
        for j in jobs:
            enqueue(j)
        return [j.id for j in jobs]
    finally:
        db.close()

