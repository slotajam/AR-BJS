"""Crossref REST API works connector. Docs: https://api.crossref.org/swagger-ui/index.html"""

import re

import httpx

from app.config import Settings
from app.connectors.base import ConnectorInfo, HttpMixin, Page, SearchQuery
from app.services.normalize import (
    AuthorRec,
    LocationRec,
    NormalizedRecord,
    normalize_doi,
    normalize_orcid,
    strip_markup,
)

BASE = "https://api.crossref.org"

TYPE_MAP = {
    "article": "journal-article",
    "preprint": "posted-content",
    "proceedings": "proceedings-article",
    "book-chapter": "book-chapter",
    "dataset": "dataset",
    "dissertation": "dissertation",
}

# Crossref content-version -> OpenAlex-style version vocabulary.
VERSION_MAP = {"vor": "publishedVersion", "am": "acceptedVersion", "tdm": None, "unspecified": None}

INFO = ConnectorInfo(
    name="crossref",
    display_name="Crossref",
    version="crossref-v1",
    documentation_url="https://www.crossref.org/documentation/retrieve-metadata/rest-api/",
    verified_on=None,
    verification_method=(
        "Implemented against the published REST API documentation and tested with recorded-shape fixtures "
        "(tests/fixtures/crossref_*.json, labelled FIXTURE). Live verification must be run with "
        "`python -m app.cli verify-connectors` from a network that can reach api.crossref.org."
    ),
    authentication="None required; `mailto` selects the polite pool; optional Metadata Plus token header.",
    rate_limits="Documented per-pool rate and concurrency limits returned in X-Rate-Limit-* headers; 429 on excess.",
    pagination="Deep paging via cursor=* then message.next-cursor; rows up to 1000.",
    capabilities=("discovery", "identifiers", "metadata", "affiliations", "citation_counts", "access_locations"),
)

BOOLEAN_TOKENS = re.compile(r"\b(AND|OR|NOT)\b|[()\"]")


def _date_parts(item: dict) -> tuple[int | None, str | None]:
    for key in ("published", "issued", "published-print", "published-online", "posted"):
        parts = ((item.get(key) or {}).get("date-parts") or [[None]])[0]
        if parts and parts[0]:
            y = int(parts[0])
            iso = "-".join(f"{int(p):02d}" if i else str(p) for i, p in enumerate(parts[:3]))
            return y, iso
    return None, None


def _is_cc(url: str | None) -> bool:
    return bool(url) and "creativecommons.org" in url.lower()


def parse_item(item: dict) -> NormalizedRecord:
    doi = normalize_doi(item.get("DOI"))
    rec = NormalizedRecord(source="crossref", source_record_id=doi, raw=item)
    rec.doi = doi
    if doi:
        rec.identifiers["doi"] = doi
    titles = item.get("title") or []
    rec.title = strip_markup(titles[0]) if titles else None
    rec.abstract = strip_markup(item.get("abstract"))
    if rec.abstract is None:
        rec.missing_reasons["abstract"] = "not_deposited_by_publisher"
    for a in item.get("author") or []:
        name = " ".join(p for p in (a.get("given"), a.get("family")) if p) or a.get("name")
        if not name:
            continue
        rec.authors.append(
            AuthorRec(
                display_name=name,
                orcid=normalize_orcid(a.get("ORCID")),
                affiliations=[
                    {"name": af.get("name"), "ror": None, "country_code": None, "source": "crossref"}
                    for af in a.get("affiliation") or []
                    if af.get("name")
                ],
            )
        )
    containers = item.get("container-title") or []
    rec.venue = containers[0] if containers else None
    rec.publication_year, rec.publication_date = _date_parts(item)
    rec.document_type = item.get("type")
    rec.language = item.get("language")
    rec.keywords = list(item.get("subject") or [])
    licenses = item.get("license") or []
    vor = [lic for lic in licenses if lic.get("content-version") == "vor"]
    rec.license = (vor or licenses or [{}])[0].get("URL")
    rec.missing_reasons["is_retracted"] = "not_reported_on_crossref_work_record"
    rec.cited_by_count = item.get("is-referenced-by-count")
    lic_by_version = {lic.get("content-version"): lic.get("URL") for lic in licenses}
    for link in item.get("link") or []:
        if link.get("content-type") not in ("application/pdf", "unspecified"):
            continue
        cv = link.get("content-version") or "unspecified"
        lic = lic_by_version.get(cv)
        rec.locations.append(
            LocationRec(
                pdf_url=link.get("URL") if link.get("content-type") == "application/pdf" else None,
                landing_page_url=(item.get("resource") or {}).get("primary", {}).get("URL"),
                host_type="publisher",
                version=VERSION_MAP.get(cv),
                license=lic,
                is_oa=True if _is_cc(lic) else None,
                source="crossref",
            )
        )
    return rec.finalize("not_provided_by_source")


class CrossrefConnector(HttpMixin):
    info = INFO
    min_interval = 0.2

    def __init__(self, settings: Settings, client: httpx.Client | None = None):
        self.settings = settings
        headers = {}
        if settings.crossref_plus_token:
            headers["Crossref-Plus-API-Token"] = f"Bearer {settings.crossref_plus_token}"
        self.client = client or httpx.Client(
            timeout=settings.http_timeout_seconds, follow_redirects=False, headers=headers
        )

    def configured(self) -> tuple[bool, str | None]:
        if not self.settings.crossref_enabled:
            return False, "disabled"
        return True, None

    def build_query(self, q: SearchQuery) -> tuple[str, dict]:
        # Crossref has no boolean syntax: operators are removed and NOT-terms dropped.
        text = re.sub(r"\bNOT\s+(\"[^\"]*\"|\S+)", " ", q.text)
        text = re.sub(r"\s+", " ", BOOLEAN_TOKENS.sub(" ", text)).strip()
        filters = []
        if q.date_from:
            filters.append(f"from-pub-date:{q.date_from.isoformat()}")
        if q.date_to:
            filters.append(f"until-pub-date:{q.date_to.isoformat()}")
        for t in q.document_types:
            if t in TYPE_MAP:
                filters.append(f"type:{TYPE_MAP[t]}")
        params = {"query": text}
        if filters:
            params["filter"] = ",".join(filters)
        return text, params

    def search_page(self, q: SearchQuery, cursor: str | None, per_page: int) -> Page:
        _, params = self.build_query(q)
        params = {**params, "rows": min(per_page, 1000), "cursor": cursor or "*"}
        if self.settings.contact_email:
            params["mailto"] = self.settings.contact_email
        url = f"{BASE}/works"
        resp = self._get(url, params)
        msg = resp.json().get("message") or {}
        items = msg.get("items") or []
        records = [parse_item(i) for i in items]
        if q.languages:  # Crossref has no language filter; apply client-side only where language is known
            records = [r for r in records if r.language is None or r.language in q.languages]
        return Page(
            records=records,
            next_cursor=msg.get("next-cursor") if items else None,
            total_available=msg.get("total-results"),
            request_url=url,
            request_params=params,
        )

    def get_by_doi(self, doi: str) -> NormalizedRecord | None:
        params = {"mailto": self.settings.contact_email} if self.settings.contact_email else {}
        resp = self._get(f"{BASE}/works/{doi}", params)
        if resp.status_code == 404:
            return None
        return parse_item(resp.json().get("message") or {})
