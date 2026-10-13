import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db, session_factory
from app.deps import audit, current_user, require_role
from app.models import Job, Search, SearchRun, User
from app.schemas import JobOut, SearchIn, SearchOut, SearchRunOut
from app.services import query as query_svc
from app.services.jobs import RETRYABLE, TERMINAL, create_job, enqueue, prepare_retry, request_cancel

router = APIRouter(tags=["searches", "jobs"])


def _search_out(db: Session, s: Search) -> SearchOut:
    out = SearchOut.model_validate(s)
    out.runs = [SearchRunOut.model_validate(r) for r in
                db.scalars(select(SearchRun).where(SearchRun.search_id == s.id).order_by(SearchRun.started_at))]
    out.jobs = [JobOut.model_validate(j) for j in db.scalars(
        select(Job).where(Job.kind == "search", Job.params["search_id"].as_string() == s.id)
        .order_by(Job.created_at.desc()))]
    return out


def _start_search_job(db: Session, s: Search, user: User, key: str | None) -> Job:
    job, created = create_job(db, project_id=s.project_id, kind="search", params={"search_id": s.id},
                              user_id=user.id, idempotency_key=key)
    db.commit()
    if created:
        enqueue(job)
    return job


@router.post("/projects/{project_id}/searches", response_model=SearchOut, status_code=201)
def create_search(project_id: str, body: SearchIn, request: Request, user: User = Depends(current_user),
                  db: Session = Depends(get_db)):
    require_role(db, user, project_id, "editor")
    if body.date_from and body.date_to and body.date_from > body.date_to:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "date_from must be before date_to")
    if body.idempotency_key:
        existing = db.scalar(select(Job).where(Job.project_id == project_id, Job.kind == "search",
                                               Job.idempotency_key == body.idempotency_key))
        if existing:
            return _search_out(db, db.get(Search, existing.params["search_id"]))
    data = body.model_dump(exclude={"run_now", "idempotency_key"})
    s = Search(project_id=project_id, created_by=user.id, **data)
    s.expanded_query = query_svc.expand(body.original_query, body.keywords, body.synonyms, body.boolean_query,
                                        body.exclusion_terms)
    db.add(s)
    db.flush()
    audit(db, user_id=user.id, project_id=project_id, action="search.create", entity_type="search", entity_id=s.id,
          details={"original_query": s.original_query, "expanded_query": s.expanded_query, "sources": s.sources},
          request=request)
    db.commit()
    if body.run_now:
        _start_search_job(db, s, user, body.idempotency_key)
    return _search_out(db, s)


@router.get("/projects/{project_id}/searches", response_model=list[SearchOut])
def list_searches(project_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, user, project_id, "viewer")
    return [_search_out(db, s) for s in
            db.scalars(select(Search).where(Search.project_id == project_id).order_by(Search.created_at.desc()))]


def _get_search(db: Session, user: User, search_id: str, role: str) -> Search:
    s = db.get(Search, search_id)
    if s is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Search not found")
    require_role(db, user, s.project_id, role)
    return s


@router.get("/searches/{search_id}", response_model=SearchOut)
def get_search(search_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return _search_out(db, _get_search(db, user, search_id, "viewer"))


@router.post("/searches/{search_id}/run", response_model=JobOut, status_code=202)
def run_search(search_id: str, request: Request, idempotency_key: str | None = None,
               user: User = Depends(current_user), db: Session = Depends(get_db)):
    s = _get_search(db, user, search_id, "editor")
    job = _start_search_job(db, s, user, idempotency_key)
    audit(db, user_id=user.id, project_id=s.project_id, action="search.run", entity_type="job", entity_id=job.id,
          request=request)
    db.commit()
    return job


# ------------------------------------------------------------------ jobs


def _get_job(db: Session, user: User, job_id: str, role: str) -> Job:
    job = db.get(Job, job_id)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found")
    require_role(db, user, job.project_id, role)
    return job


@router.get("/projects/{project_id}/jobs", response_model=list[JobOut])
def list_jobs(project_id: str, limit: int = 50, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, user, project_id, "viewer")
    return list(db.scalars(select(Job).where(Job.project_id == project_id).order_by(Job.created_at.desc())
                           .limit(min(limit, 500))))


@router.get("/jobs/{job_id}", response_model=JobOut)
def get_job(job_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return _get_job(db, user, job_id, "viewer")


@router.get("/jobs/{job_id}/events")
async def job_events(job_id: str, request: Request, user: User = Depends(current_user),
                     db: Session = Depends(get_db)):
    """Server-Sent Events: emits the job whenever it changes, closes when terminal."""
    _get_job(db, user, job_id, "viewer")

    async def stream():
        last = None
        while True:
            if await request.is_disconnected():
                return
            with session_factory()() as s:
                job = s.get(Job, job_id)
                payload = JobOut.model_validate(job).model_dump(mode="json")
            blob = json.dumps(payload, sort_keys=True)
            if blob != last:
                last = blob
                yield f"event: job\ndata: {blob}\n\n"
            if payload["status"] in TERMINAL:
                yield "event: end\ndata: {}\n\n"
                return
            await asyncio.sleep(1.0)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/jobs/{job_id}/cancel", response_model=JobOut)
def cancel_job(job_id: str, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    job = _get_job(db, user, job_id, "editor")
    request_cancel(db, job)
    audit(db, user_id=user.id, project_id=job.project_id, action="job.cancel", entity_type="job", entity_id=job.id,
          request=request)
    db.commit()
    return job


@router.post("/jobs/{job_id}/retry", response_model=JobOut, status_code=202)
def retry_job(job_id: str, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Re-run a failed / partial / cancelled job from its durable checkpoint."""
    job = _get_job(db, user, job_id, "editor")
    if job.status not in RETRYABLE:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Job is {job.status}; only {sorted(RETRYABLE)} can be retried")
    prepare_retry(job)
    if job.kind == "search":
        for run in db.scalars(select(SearchRun).where(SearchRun.job_id == job.id,
                                                      SearchRun.status.in_(["failed", "partial", "cancelled"]))):
            run.status = "queued"  # keeps its cursor -> resumes where it stopped
    audit(db, user_id=user.id, project_id=job.project_id, action="job.retry", entity_type="job", entity_id=job.id,
          request=request)
    db.commit()
    enqueue(job)
    db.refresh(job)
    return job
