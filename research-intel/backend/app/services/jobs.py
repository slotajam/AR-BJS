"""Durable job records. Celery only carries the job id; all state lives in PostgreSQL
so jobs survive worker restarts and can be retried or resumed from their checkpoint."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import Job

TERMINAL = {"succeeded", "failed", "partial", "cancelled"}
RETRYABLE = {"failed", "partial", "cancelled"}


class JobCancelled(Exception):
    pass


def create_job(db: Session, *, project_id: str, kind: str, params: dict, user_id: str | None,
               idempotency_key: str | None) -> tuple[Job, bool]:
    """Return (job, created). An existing job with the same idempotency key is returned unchanged."""
    if idempotency_key:
        existing = db.scalar(select(Job).where(Job.project_id == project_id, Job.kind == kind,
                                               Job.idempotency_key == idempotency_key))
        if existing:
            return existing, False
    job = Job(project_id=project_id, kind=kind, params=params, created_by=user_id, idempotency_key=idempotency_key,
              status="queued", stage="queued", state={}, result={})
    db.add(job)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(Job).where(Job.project_id == project_id, Job.kind == kind,
                                               Job.idempotency_key == idempotency_key))
        assert existing is not None
        return existing, False
    return job, True


def enqueue(job: Job) -> None:
    from app.worker import tasks

    tasks.run_job.delay(job.id)


class JobContext:
    """Used inside a task to report progress and honour cancellation."""

    def __init__(self, db: Session, job: Job):
        self.db = db
        self.job = job

    def stage(self, stage: str, progress: float | None = None) -> None:
        self.check_cancel()
        self.job.stage = stage
        if progress is not None:
            self.job.progress = max(0.0, min(1.0, progress))
        self.db.commit()

    def checkpoint(self, **state) -> None:
        self.job.state = {**(self.job.state or {}), **state}
        self.db.commit()

    def check_cancel(self) -> None:
        self.db.refresh(self.job, attribute_names=["cancel_requested"])
        if self.job.cancel_requested:
            raise JobCancelled()


def request_cancel(db: Session, job: Job) -> None:
    if job.status in TERMINAL:
        return
    job.cancel_requested = True
    if job.status == "queued":
        job.status, job.stage, job.finished_at = "cancelled", "cancelled", datetime.now(UTC)


def prepare_retry(job: Job) -> None:
    job.status, job.stage, job.error = "queued", "queued", None
    job.cancel_requested = False
    job.finished_at = None


def stale_running_jobs(db: Session, older_than: timedelta = timedelta(minutes=15)) -> list[Job]:
    cutoff = datetime.now(UTC) - older_than
    return list(db.scalars(select(Job).where(Job.status == "running", Job.updated_at < cutoff)))
