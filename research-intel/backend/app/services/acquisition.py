"""PDF acquisition from permitted locations and direct uploads.

A successful acquisition creates exactly one ``File`` per (project, checksum) and
moves the paper into the collected corpus. Re-running is a no-op.
"""

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import AccessRecord, File, Paper
from app.services import netsafe
from app.services.pdf_validate import validate_pdf
from app.services.storage import get_storage

UPLOAD_BASES = {
    "user_upload_open_license": "The uploader states the PDF is available under an open licence.",
    "user_upload_own_work": "The uploader is an author/rights holder of the PDF.",
    "user_upload_licensed_access": "The uploader obtained the PDF through access they are licensed to use "
                                   "for private research (not redistributable).",
}


class AcquisitionError(Exception):
    def __init__(self, message: str, *, access_status: str, retryable: bool = False,
                 retry_after: float | None = None):
        super().__init__(message)
        self.access_status = access_status
        self.retryable = retryable
        self.retry_after = retry_after


def storage_key(project_id: str, sha256: str) -> str:
    return f"projects/{project_id}/pdfs/{sha256}.pdf"


def existing_file(db: Session, paper: Paper) -> File | None:
    return db.scalar(select(File).where(File.paper_id == paper.id).order_by(File.downloaded_at))


def _store(db: Session, paper: Paper, data: bytes, validation, **file_fields) -> File:
    dup = db.scalar(select(File).where(File.project_id == paper.project_id, File.sha256 == validation.sha256))
    if dup:
        return dup
    key = storage_key(paper.project_id, validation.sha256)
    get_storage().put(key, data, "application/pdf")
    f = File(
        project_id=paper.project_id,
        paper_id=paper.id,
        storage_key=key,
        sha256=validation.sha256,
        size_bytes=validation.size_bytes,
        page_count=validation.page_count,
        validation=validation.as_dict(),
        downloaded_at=datetime.now(UTC),
        **file_fields,
    )
    db.add(f)
    db.flush()
    return f


def collect_from_access_record(db: Session, paper: Paper) -> File:
    """Fetch the first permitted location. Raises AcquisitionError with the resulting access state."""
    f = existing_file(db, paper)
    if f:
        return f
    records = list(
        db.scalars(
            select(AccessRecord)
            .where(AccessRecord.paper_id == paper.id, AccessRecord.permitted.is_(True))
            .order_by(AccessRecord.redistributable.desc(), AccessRecord.checked_at)
        )
    )
    if not records:
        status = paper.access_status if paper.access_status in ("access_restricted", "unavailable") else "unavailable"
        raise AcquisitionError("no permitted PDF location recorded", access_status=status)
    s = get_settings()
    last: AcquisitionError | None = None
    for rec in records:
        rec.checked_at = datetime.now(UTC)
        try:
            res = netsafe.safe_get(rec.url)
        except netsafe.UnsafeURL as e:
            rec.status, rec.error = "fetch_failed", f"blocked unsafe URL: {e}"
            last = AcquisitionError(rec.error, access_status="fetch_failed")
            continue
        except netsafe.FetchError as e:
            rec.status, rec.error = "fetch_failed", str(e)
            last = AcquisitionError(str(e), access_status="fetch_failed", retryable=e.retryable,
                                    retry_after=e.retry_after)
            continue
        v = validate_pdf(res.body, max_bytes=s.pdf_max_bytes, declared_content_type=res.content_type)
        if not v.ok:
            rec.status, rec.error = "invalid_pdf", v.error
            last = AcquisitionError(v.error or "invalid PDF", access_status="invalid_pdf")
            continue
        rec.status, rec.error = "collected", None
        return _store(
            db, paper, res.body, v,
            access_record_id=rec.id,
            source_url=res.final_url,
            access_basis=rec.access_basis or "none",
            license=rec.license,
            version=rec.version,
            redistributable=rec.redistributable,
        )
    assert last is not None
    # Report every attempt; an invalid PDF is more informative than a later network failure.
    errors = "; ".join(f"{r.url}: {r.status} ({r.error})" for r in records)
    status = "invalid_pdf" if any(r.status == "invalid_pdf" for r in records) else last.access_status
    raise AcquisitionError(errors, access_status=status, retryable=last.retryable, retry_after=last.retry_after)


def store_upload(db: Session, paper: Paper, data: bytes, *, filename: str | None, access_basis: str,
                 license: str | None, version: str | None, user_id: str) -> File:
    if access_basis not in UPLOAD_BASES:
        raise AcquisitionError(f"unknown access basis {access_basis!r}", access_status="invalid_pdf")
    v = validate_pdf(data, max_bytes=get_settings().pdf_max_bytes)
    if not v.ok:
        raise AcquisitionError(v.error or "invalid PDF", access_status="invalid_pdf")
    rec = AccessRecord(
        paper_id=paper.id, source="upload", url=None, host_type="user", version=version, license=license,
        access_basis=access_basis, permitted=True,
        redistributable=access_basis == "user_upload_open_license" and bool(license),
        status="user_uploaded",
    )
    db.add(rec)
    db.flush()
    return _store(
        db, paper, data, v,
        access_record_id=rec.id,
        original_filename=filename,
        access_basis=access_basis,
        license=license,
        version=version,
        redistributable=rec.redistributable,
        uploaded_by=user_id,
    )
