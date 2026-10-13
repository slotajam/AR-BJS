from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

Role = Literal["owner", "admin", "editor", "viewer"]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ------------------------------------------------------------------ auth

class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=10, max_length=256)
    display_name: str = Field(min_length=1, max_length=200)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserOut(ORM):
    id: str
    email: str
    display_name: str


# ------------------------------------------------------------------ projects

class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    description: str | None = None
    research_question: str | None = None


class ProjectOut(ORM):
    id: str
    name: str
    description: str | None
    research_question: str | None
    is_fixture: bool
    created_at: datetime
    role: Role | None = None


class MemberIn(BaseModel):
    email: EmailStr
    role: Role


class MemberOut(BaseModel):
    user_id: str
    email: str
    display_name: str
    role: Role


# ------------------------------------------------------------------ searches & jobs

class SearchIn(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    original_query: str = Field(min_length=1, max_length=5000)
    keywords: list[str] = Field(default_factory=list, max_length=50)
    synonyms: dict[str, list[str]] = Field(default_factory=dict)
    boolean_query: str | None = Field(default=None, max_length=5000)
    date_from: date | None = None
    date_to: date | None = None
    languages: list[str] = Field(default_factory=list)
    document_types: list[str] = Field(default_factory=list)
    inclusion_criteria: str | None = None
    exclusion_criteria: str | None = None
    exclusion_terms: list[str] = Field(default_factory=list, max_length=50)
    sources: list[str] = Field(default_factory=lambda: ["openalex", "crossref"])
    result_limit: int = Field(default=200, ge=1, le=5000)
    pdf_mode: Literal["metadata_only", "permitted_oa"] = "metadata_only"
    ai_expansion_enabled: bool = False
    run_now: bool = True
    idempotency_key: str | None = Field(default=None, max_length=200)

    @field_validator("ai_expansion_enabled")
    @classmethod
    def _no_ai(cls, v: bool) -> bool:
        if v:
            raise ValueError("AI query expansion is not available in Phase 1; only deterministic expansion")
        return v


class JobOut(ORM):
    id: str
    project_id: str
    kind: str
    status: str
    stage: str
    progress: float
    idempotency_key: str | None
    params: dict
    state: dict
    result: dict
    error: str | None
    attempts: int
    cancel_requested: bool
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    updated_at: datetime


class SearchRunOut(ORM):
    id: str
    job_id: str
    source: str
    exact_query: str
    request_params: dict
    filters: dict
    status: str
    started_at: datetime | None
    completed_at: datetime | None
    pagination: dict
    result_limit: int
    retrieved_count: int
    new_count: int
    duplicate_count: int
    exclusion_count: int
    failure_count: int
    partial_coverage: bool
    errors: list
    connector_version: str


class SearchOut(ORM):
    id: str
    project_id: str
    name: str
    original_query: str
    expanded_query: dict | None
    keywords: list
    synonyms: dict
    boolean_query: str | None
    date_from: date | None
    date_to: date | None
    languages: list
    document_types: list
    inclusion_criteria: str | None
    exclusion_criteria: str | None
    exclusion_terms: list
    sources: list
    result_limit: int
    pdf_mode: str
    ai_expansion_enabled: bool
    created_at: datetime
    runs: list[SearchRunOut] = []
    jobs: list[JobOut] = []


# ------------------------------------------------------------------ papers

class PaperPatch(BaseModel):
    tags: list[str] | None = None
    screening_status: Literal["not_screened", "include", "exclude", "maybe"] | None = None
    excluded: bool | None = None
    exclusion_reason: str | None = None
    corrections: dict[str, object] | None = None  # field -> corrected value (stored separately)
    correction_reason: str | None = None


class NoteIn(BaseModel):
    body: str = Field(min_length=1, max_length=20000)


class EvidenceIn(BaseModel):
    chunk_id: str
    char_start: int = Field(ge=0)
    char_end: int = Field(gt=0)
    note: str | None = None


class CollectIn(BaseModel):
    idempotency_key: str | None = None


class ImportIn(BaseModel):
    format: Literal["doi", "bibtex", "ris", "csv"]
    content: str = Field(min_length=1, max_length=10_000_000)
    idempotency_key: str | None = None


class RankingIn(BaseModel):
    query: str | None = None  # defaults to the project's research question
    weights: dict[str, float] | None = None
    paper_ids: list[str] | None = None


class ExportIn(BaseModel):
    format: Literal["csv", "json"]
    paper_ids: list[str] | None = None
    record_type: Literal["all", "collected", "discovery"] = "all"
    include_excluded: bool = False
    idempotency_key: str | None = None


class DedupResolveIn(BaseModel):
    decision: Literal["distinct", "merged"]
