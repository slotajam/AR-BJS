"""Provider-independent normalized record and normalisation helpers.

Only values the provider actually supplied are populated. Absent values stay
``None`` and get an entry in ``missing_reasons`` explaining why.
"""

import html
import re
import unicodedata
from dataclasses import asdict, dataclass, field
from typing import Any

DOI_RE = re.compile(r"10\.\d{4,9}/\S+", re.IGNORECASE)

# Fields tracked for missing-data reporting.
CORE_FIELDS = ("doi", "title", "abstract", "authors", "venue", "publication_year", "document_type", "license")


@dataclass
class AuthorRec:
    display_name: str
    orcid: str | None = None
    provider_author_id: str | None = None
    affiliations: list[dict] = field(default_factory=list)


@dataclass
class LocationRec:
    """A candidate full-text location as reported by a provider (not yet validated)."""

    pdf_url: str | None
    landing_page_url: str | None
    host_type: str | None  # publisher | repository
    version: str | None
    license: str | None
    is_oa: bool | None
    source: str


@dataclass
class NormalizedRecord:
    source: str
    source_record_id: str | None
    doi: str | None = None
    identifiers: dict[str, str] = field(default_factory=dict)  # scheme -> value
    title: str | None = None
    abstract: str | None = None
    authors: list[AuthorRec] = field(default_factory=list)
    venue: str | None = None
    publication_year: int | None = None
    publication_date: str | None = None
    document_type: str | None = None
    language: str | None = None
    keywords: list[str] = field(default_factory=list)
    license: str | None = None
    is_retracted: bool | None = None
    cited_by_count: int | None = None
    is_oa: bool | None = None
    locations: list[LocationRec] = field(default_factory=list)
    missing_reasons: dict[str, str] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)

    def finalize(self, default_reason: str) -> "NormalizedRecord":
        for f in CORE_FIELDS:
            v = getattr(self, f)
            if (v is None or v == [] or v == "") and f not in self.missing_reasons:
                self.missing_reasons[f] = default_reason
        return self

    def to_observation(self) -> dict:
        d = asdict(self)
        d.pop("raw")
        return d


def normalize_doi(value: str | None) -> str | None:
    if not value:
        return None
    v = value.strip()
    v = re.sub(r"^(https?://)?(dx\.)?doi\.org/", "", v, flags=re.IGNORECASE)
    v = re.sub(r"^doi:\s*", "", v, flags=re.IGNORECASE)
    m = DOI_RE.search(v)
    if not m:
        return None
    return m.group(0).rstrip(".,;)").lower()


def normalize_title(title: str | None) -> str:
    if not title:
        return ""
    t = unicodedata.normalize("NFKD", html.unescape(title))
    t = "".join(c for c in t if not unicodedata.combining(c))
    t = re.sub(r"<[^>]+>", " ", t)
    t = re.sub(r"[^\w\s]", " ", t.lower())
    return re.sub(r"\s+", " ", t).strip()


def strip_markup(text: str | None) -> str | None:
    """Crossref abstracts arrive as JATS XML; keep the text only."""
    if not text:
        return None
    t = re.sub(r"<[^>]+>", " ", html.unescape(text))
    t = re.sub(r"\s+", " ", t).strip()
    return t or None


def author_surname(name: str) -> str:
    name = name.strip()
    if "," in name:
        return normalize_title(name.split(",")[0])
    parts = normalize_title(name).split()
    return parts[-1] if parts else ""


def normalize_orcid(value: str | None) -> str | None:
    if not value:
        return None
    m = re.search(r"(\d{4}-\d{4}-\d{4}-\d{3}[\dX])", value)
    return m.group(1) if m else None


def year_from_date(d: str | None) -> int | None:
    if d and re.match(r"^\d{4}", d):
        return int(d[:4])
    return None
