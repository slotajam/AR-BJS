"""ORM models. See docs/DATA_DICTIONARY.md for field-level definitions.

Key invariants:
* Discovery records (``Paper`` with ``in_corpus = False``) are metadata-only.
* Only papers with a validated, authorised ``File`` have ``in_corpus = True`` and are
  eligible for full-text chunking, evidence and chunk embeddings.
* Provider values are never overwritten: every provider response is kept as a
  ``SourceObservation``; user edits live in ``UserCorrection``.
"""

import uuid
from datetime import UTC, date, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import TypeDecorator

from app.config import get_settings
from app.db import Base

JSONType = JSON().with_variant(JSONB(), "postgresql")


def uid() -> str:
    return str(uuid.uuid4())


def now() -> datetime:
    return datetime.now(UTC)


class EmbeddingVector(TypeDecorator):
    """pgvector column when enabled on PostgreSQL, JSON float array otherwise."""

    impl = JSON
    cache_ok = True

    def load_dialect_impl(self, dialect):
        s = get_settings()
        if dialect.name == "postgresql" and s.pgvector_enabled:
            from pgvector.sqlalchemy import Vector

            return dialect.type_descriptor(Vector(s.embedding_dim))
        return dialect.type_descriptor(JSONType)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return [float(x) for x in value]


TS = DateTime(timezone=True)


# ---------------------------------------------------------------- identity


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(200))
    password_hash: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(TS, default=now)


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(300))
    description: Mapped[str | None] = mapped_column(Text)
    research_question: Mapped[str | None] = mapped_column(Text)
    is_fixture: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(TS, default=now)
    updated_at: Mapped[datetime] = mapped_column(TS, default=now, onupdate=now)

    memberships: Mapped[list["Membership"]] = relationship(back_populates="project", cascade="all, delete-orphan")


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("project_id", "user_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(20))  # owner | admin | editor | viewer
    created_at: Mapped[datetime] = mapped_column(TS, default=now)

    project: Mapped[Project] = relationship(back_populates="memberships")
    user: Mapped[User] = relationship()


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str | None] = mapped_column(String(36), index=True)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    action: Mapped[str] = mapped_column(String(100))
    entity_type: Mapped[str] = mapped_column(String(50))
    entity_id: Mapped[str | None] = mapped_column(String(36))
    details: Mapped[dict] = mapped_column(JSONType, default=dict)
    ip: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, default=now, index=True)


# ---------------------------------------------------------------- searches & jobs


class Search(Base):
    __tablename__ = "searches"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(300))
    original_query: Mapped[str] = mapped_column(Text)
    keywords: Mapped[list] = mapped_column(JSONType, default=list)
    synonyms: Mapped[dict] = mapped_column(JSONType, default=dict)  # keyword -> [synonyms]
    boolean_query: Mapped[str | None] = mapped_column(Text)
    date_from: Mapped[date | None] = mapped_column(Date)
    date_to: Mapped[date | None] = mapped_column(Date)
    languages: Mapped[list] = mapped_column(JSONType, default=list)
    document_types: Mapped[list] = mapped_column(JSONType, default=list)
    inclusion_criteria: Mapped[str | None] = mapped_column(Text)
    exclusion_criteria: Mapped[str | None] = mapped_column(Text)
    exclusion_terms: Mapped[list] = mapped_column(JSONType, default=list)
    sources: Mapped[list] = mapped_column(JSONType, default=list)
    result_limit: Mapped[int] = mapped_column(Integer, default=200)
    pdf_mode: Mapped[str] = mapped_column(String(30), default="metadata_only")  # metadata_only | permitted_oa
    ai_expansion_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    expanded_query: Mapped[dict | None] = mapped_column(JSONType)  # stored separately from original
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(TS, default=now)


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (UniqueConstraint("project_id", "kind", "idempotency_key", name="uq_job_idem"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(30))  # search | collect | process | import | export
    status: Mapped[str] = mapped_column(String(20), default="queued")
    # queued | running | succeeded | partial | failed | cancelled
    stage: Mapped[str] = mapped_column(String(40), default="queued")
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    idempotency_key: Mapped[str | None] = mapped_column(String(200))
    params: Mapped[dict] = mapped_column(JSONType, default=dict)
    state: Mapped[dict] = mapped_column(JSONType, default=dict)  # durable checkpoint for resume
    result: Mapped[dict] = mapped_column(JSONType, default=dict)
    error: Mapped[str | None] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(TS, default=now)
    started_at: Mapped[datetime | None] = mapped_column(TS)
    finished_at: Mapped[datetime | None] = mapped_column(TS)
    updated_at: Mapped[datetime] = mapped_column(TS, default=now, onupdate=now)


class SearchRun(Base):
    __tablename__ = "search_runs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    search_id: Mapped[str] = mapped_column(ForeignKey("searches.id", ondelete="CASCADE"), index=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"), index=True)
    source: Mapped[str] = mapped_column(String(40))
    exact_query: Mapped[str] = mapped_column(Text)  # exactly what was sent to the provider
    request_params: Mapped[dict] = mapped_column(JSONType, default=dict)
    filters: Mapped[dict] = mapped_column(JSONType, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="queued")
    # queued | running | completed | partial | failed | cancelled | skipped
    started_at: Mapped[datetime | None] = mapped_column(TS)
    completed_at: Mapped[datetime | None] = mapped_column(TS)
    pagination: Mapped[dict] = mapped_column(JSONType, default=dict)  # cursor, pages_fetched, total_available
    result_limit: Mapped[int] = mapped_column(Integer)
    retrieved_count: Mapped[int] = mapped_column(Integer, default=0)
    new_count: Mapped[int] = mapped_column(Integer, default=0)
    duplicate_count: Mapped[int] = mapped_column(Integer, default=0)
    exclusion_count: Mapped[int] = mapped_column(Integer, default=0)
    failure_count: Mapped[int] = mapped_column(Integer, default=0)
    partial_coverage: Mapped[bool] = mapped_column(Boolean, default=False)
    errors: Mapped[list] = mapped_column(JSONType, default=list)
    connector_version: Mapped[str] = mapped_column(String(40))


# ---------------------------------------------------------------- papers


class Paper(Base):
    __tablename__ = "papers"
    __table_args__ = (
        Index("uq_paper_project_doi", "project_id", "doi", unique=True, postgresql_where=text("doi IS NOT NULL")),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    doi: Mapped[str | None] = mapped_column(String(300))
    title: Mapped[str | None] = mapped_column(Text)
    abstract: Mapped[str | None] = mapped_column(Text)
    publication_year: Mapped[int | None] = mapped_column(Integer)
    publication_date: Mapped[str | None] = mapped_column(String(10))  # ISO, may be partial (YYYY or YYYY-MM)
    venue: Mapped[str | None] = mapped_column(Text)
    document_type: Mapped[str | None] = mapped_column(String(60))
    language: Mapped[str | None] = mapped_column(String(20))
    keywords: Mapped[list] = mapped_column(JSONType, default=list)
    license: Mapped[str | None] = mapped_column(String(200))
    is_retracted: Mapped[bool | None] = mapped_column(Boolean)
    cited_by_count: Mapped[int | None] = mapped_column(Integer)  # provider-reported, informational only
    access_status: Mapped[str] = mapped_column(String(30), default="not_checked")
    processing_status: Mapped[str | None] = mapped_column(String(20))  # only set once collection starts
    in_corpus: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    origin: Mapped[str] = mapped_column(String(20))  # search | import | upload
    missing_reasons: Mapped[dict] = mapped_column(JSONType, default=dict)  # field -> reason
    conflicts: Mapped[dict] = mapped_column(JSONType, default=dict)  # field -> [{source, value}]
    tags: Mapped[list] = mapped_column(JSONType, default=list)
    screening_status: Mapped[str] = mapped_column(String(20), default="not_screened")  # placeholder
    excluded: Mapped[bool] = mapped_column(Boolean, default=False)
    exclusion_reason: Mapped[str | None] = mapped_column(Text)
    is_fixture: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(TS, default=now)
    updated_at: Mapped[datetime] = mapped_column(TS, default=now, onupdate=now)

    authors: Mapped[list["PaperAuthor"]] = relationship(
        order_by="PaperAuthor.position", cascade="all, delete-orphan"
    )
    identifiers: Mapped[list["PaperIdentifier"]] = relationship(cascade="all, delete-orphan")


class PaperIdentifier(Base):
    __tablename__ = "paper_identifiers"
    __table_args__ = (UniqueConstraint("project_id", "scheme", "value", name="uq_identifier"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), index=True)
    scheme: Mapped[str] = mapped_column(String(30))  # doi | openalex | pmid | pmcid | arxiv | mag
    value: Mapped[str] = mapped_column(String(300))
    source: Mapped[str] = mapped_column(String(40))


class PaperAuthor(Base):
    __tablename__ = "paper_authors"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer)
    display_name: Mapped[str] = mapped_column(Text)
    orcid: Mapped[str | None] = mapped_column(String(40))
    provider_author_id: Mapped[str | None] = mapped_column(String(100))
    affiliations: Mapped[list] = mapped_column(JSONType, default=list)  # [{name, ror, country_code, source}]
    source: Mapped[str] = mapped_column(String(40))


class SourceObservation(Base):
    """One provider's view of one paper at one retrieval time. Never mutated."""

    __tablename__ = "source_observations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), index=True)
    search_run_id: Mapped[str | None] = mapped_column(ForeignKey("search_runs.id", ondelete="SET NULL"))
    job_id: Mapped[str | None] = mapped_column(String(36))
    source: Mapped[str] = mapped_column(String(40))  # openalex | crossref | import:bibtex | upload ...
    source_record_id: Mapped[str | None] = mapped_column(String(300))
    exact_query: Mapped[str | None] = mapped_column(Text)
    retrieved_at: Mapped[datetime] = mapped_column(TS, default=now)
    normalized: Mapped[dict] = mapped_column(JSONType, default=dict)
    raw: Mapped[dict] = mapped_column(JSONType, default=dict)
    dedup_basis: Mapped[str | None] = mapped_column(String(40))  # how it was matched to the paper


class PaperRelation(Base):
    __tablename__ = "paper_relations"
    __table_args__ = (UniqueConstraint("paper_id", "related_paper_id", "relation"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"))
    related_paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"))
    relation: Mapped[str] = mapped_column(String(30))  # preprint_of
    basis: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(TS, default=now)


class DedupCandidate(Base):
    __tablename__ = "dedup_candidates"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    paper_a_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"))
    paper_b_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"))
    score: Mapped[float] = mapped_column(Float)
    reason: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending | merged | distinct
    resolved_by: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(TS, default=now)


class UserCorrection(Base):
    __tablename__ = "user_corrections"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    field: Mapped[str] = mapped_column(String(60))
    old_value: Mapped[dict | list | str | int | None] = mapped_column(JSONType)
    new_value: Mapped[dict | list | str | int | None] = mapped_column(JSONType)
    reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(TS, default=now)


class PaperNote(Base):
    __tablename__ = "paper_notes"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(TS, default=now)


# ---------------------------------------------------------------- access & files


class AccessRecord(Base):
    """A candidate full-text location and the basis on which it may be fetched."""

    __tablename__ = "access_records"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), index=True)
    source: Mapped[str] = mapped_column(String(40))  # openalex | crossref | upload
    url: Mapped[str | None] = mapped_column(Text)
    landing_page_url: Mapped[str | None] = mapped_column(Text)
    host_type: Mapped[str | None] = mapped_column(String(30))  # publisher | repository | user
    version: Mapped[str | None] = mapped_column(String(40))  # publishedVersion | acceptedVersion | submittedVersion
    license: Mapped[str | None] = mapped_column(String(200))
    access_basis: Mapped[str | None] = mapped_column(String(60))
    # oa_license | oa_repository | user_upload_attested | none
    permitted: Mapped[bool] = mapped_column(Boolean, default=False)
    redistributable: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(30), default="not_checked")
    error: Mapped[str | None] = mapped_column(Text)
    checked_at: Mapped[datetime] = mapped_column(TS, default=now)


class File(Base):
    __tablename__ = "files"
    __table_args__ = (UniqueConstraint("project_id", "sha256", name="uq_file_checksum"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), index=True)
    access_record_id: Mapped[str | None] = mapped_column(ForeignKey("access_records.id", ondelete="SET NULL"))
    storage_key: Mapped[str] = mapped_column(Text)
    sha256: Mapped[str] = mapped_column(String(64))
    size_bytes: Mapped[int] = mapped_column(Integer)
    page_count: Mapped[int | None] = mapped_column(Integer)
    content_type: Mapped[str] = mapped_column(String(100), default="application/pdf")
    original_filename: Mapped[str | None] = mapped_column(Text)
    source_url: Mapped[str | None] = mapped_column(Text)
    access_basis: Mapped[str] = mapped_column(String(60))
    license: Mapped[str | None] = mapped_column(String(200))
    version: Mapped[str | None] = mapped_column(String(40))
    redistributable: Mapped[bool] = mapped_column(Boolean, default=False)
    validation: Mapped[dict] = mapped_column(JSONType, default=dict)
    uploaded_by: Mapped[str | None] = mapped_column(String(36))
    downloaded_at: Mapped[datetime] = mapped_column(TS, default=now)


class Chunk(Base):
    __tablename__ = "chunks"
    __table_args__ = (UniqueConstraint("file_id", "chunk_index"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    file_id: Mapped[str] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"), index=True)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), index=True)
    chunk_index: Mapped[int] = mapped_column(Integer)
    page_index: Mapped[int] = mapped_column(Integer)  # 0-based PDF page index
    printed_page: Mapped[str | None] = mapped_column(String(20))  # page label if the PDF defines one
    section_label: Mapped[str | None] = mapped_column(Text)
    text: Mapped[str] = mapped_column(Text)
    char_start: Mapped[int] = mapped_column(Integer)  # offsets within the page's extracted text
    char_end: Mapped[int] = mapped_column(Integer)
    bboxes: Mapped[list] = mapped_column(JSONType, default=list)  # [[x0,y0,x1,y1], ...] PDF points
    extraction_version: Mapped[str] = mapped_column(String(40))


class Embedding(Base):
    __tablename__ = "embeddings"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), index=True)
    chunk_id: Mapped[str | None] = mapped_column(ForeignKey("chunks.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(20))  # title_abstract | chunk
    provider: Mapped[str] = mapped_column(String(40))
    model: Mapped[str] = mapped_column(String(200))
    dim: Mapped[int] = mapped_column(Integer)
    text_sha256: Mapped[str] = mapped_column(String(64))
    vector: Mapped[list] = mapped_column(EmbeddingVector())
    created_at: Mapped[datetime] = mapped_column(TS, default=now)


class Evidence(Base):
    """User-saved, page-linked quote from a collected PDF. No AI-generated claims in Phase 1."""

    __tablename__ = "evidence"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), index=True)
    chunk_id: Mapped[str] = mapped_column(ForeignKey("chunks.id", ondelete="CASCADE"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    quote: Mapped[str] = mapped_column(Text)
    page_index: Mapped[int] = mapped_column(Integer)
    char_start: Mapped[int] = mapped_column(Integer)
    char_end: Mapped[int] = mapped_column(Integer)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(TS, default=now)


# ---------------------------------------------------------------- rankings & exports


class Ranking(Base):
    __tablename__ = "rankings"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    version: Mapped[str] = mapped_column(String(40))
    query: Mapped[str] = mapped_column(Text)
    weights: Mapped[dict] = mapped_column(JSONType)
    params: Mapped[dict] = mapped_column(JSONType, default=dict)
    paper_count: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    snapshot_at: Mapped[datetime] = mapped_column(TS, default=now)


class RankingScore(Base):
    __tablename__ = "ranking_scores"
    __table_args__ = (UniqueConstraint("ranking_id", "paper_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    ranking_id: Mapped[str] = mapped_column(ForeignKey("rankings.id", ondelete="CASCADE"), index=True)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), index=True)
    score: Mapped[float | None] = mapped_column(Float)
    rank: Mapped[int | None] = mapped_column(Integer)
    components: Mapped[dict] = mapped_column(JSONType)
    effective_weights: Mapped[dict] = mapped_column(JSONType)
    coverage: Mapped[float] = mapped_column(Float)
    text_basis: Mapped[str] = mapped_column(String(20))  # title_abstract | full_text | none


class Export(Base):
    __tablename__ = "exports"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    job_id: Mapped[str | None] = mapped_column(String(36))
    format: Mapped[str] = mapped_column(String(10))  # csv | json
    scope: Mapped[dict] = mapped_column(JSONType)
    status: Mapped[str] = mapped_column(String(20), default="queued")
    storage_key: Mapped[str | None] = mapped_column(Text)
    row_count: Mapped[int | None] = mapped_column(Integer)
    manifest: Mapped[dict] = mapped_column(JSONType, default=dict)
    error: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(TS, default=now)


class ConnectorState(Base):
    __tablename__ = "connector_state"
    name: Mapped[str] = mapped_column(String(40), primary_key=True)
    last_checked_at: Mapped[datetime | None] = mapped_column(TS)
    last_success_at: Mapped[datetime | None] = mapped_column(TS)
    last_error: Mapped[str | None] = mapped_column(Text)
    last_error_at: Mapped[datetime | None] = mapped_column(TS)
    rate_limited_until: Mapped[datetime | None] = mapped_column(TS)
