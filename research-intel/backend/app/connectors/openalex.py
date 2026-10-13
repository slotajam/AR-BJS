"""OpenAlex works connector. Docs: https://docs.openalex.org/api-entities/works"""

import httpx

from app.config import Settings
from app.connectors.base import ConnectorInfo, HttpMixin, Page, SearchQuery
from app.services.normalize import (
    AuthorRec,
    LocationRec,
    NormalizedRecord,
    normalize_doi,
    normalize_orcid,
    year_from_date,
)

BASE = "https://api.openalex.org"

# Generic document type -> OpenAlex `type` filter value.
TYPE_MAP = {
    "article": "article",
    "review": "review",
    "preprint": "preprint",
    "book-chapter": "book-chapter",
    "dataset": "dataset",
    "dissertation": "dissertation",
}

INFO = ConnectorInfo(
    name="openalex",
    display_name="OpenAlex",
    version="openalex-v1",
    documentation_url="https://docs.openalex.org/how-to-use-the-api/api-overview",
    verified_on=None,
    verification_method=(
        "Implemented against the published API documentation and tested with recorded-shape fixtures "
        "(tests/fixtures/openalex_*.json, labelled FIXTURE). Live verification must be run with "
        "`python -m app.cli verify-connectors` from a network that can reach api.openalex.org."
    ),
    authentication="None required; `mailto` joins the polite pool; optional `api_key` parameter if configured.",
    rate_limits="Documented daily request budget and ~10 requests/second; HTTP 429 on excess (Retry-After honoured).",
    pagination="Cursor paging: cursor=* then meta.next_cursor; per_page up to 200.",
    capabilities=("discovery", "identifiers", "metadata", "affiliations", "citation_counts", "access_locations",
                  "boolean_query"),
)


def _abstract_from_inverted(inv: dict | None) -> str | None:
    if not inv:
        return None
    positions: list[tuple[int, str]] = []
    for word, idxs in inv.items():
        positions.extend((i, word) for i in idxs)
    return " ".join(w for _, w in sorted(positions)) or None


def _location(loc: dict | None) -> LocationRec | None:
    if not loc:
        return None
    src = loc.get("source") or {}
    return LocationRec(
        pdf_url=loc.get("pdf_url"),
        landing_page_url=loc.get("landing_page_url"),
        host_type="repository" if src.get("type") == "repository" else ("publisher" if src else None),
        version=loc.get("version"),
        license=loc.get("license"),
        is_oa=loc.get("is_oa"),
        source="openalex",
    )


def parse_work(w: dict) -> NormalizedRecord:
    ids = w.get("ids") or {}
    rec = NormalizedRecord(source="openalex", source_record_id=(w.get("id") or "").rsplit("/", 1)[-1] or None, raw=w)
    rec.doi = normalize_doi(w.get("doi") or ids.get("doi"))
    if rec.source_record_id:
        rec.identifiers["openalex"] = rec.source_record_id
    for scheme in ("pmid", "pmcid", "mag"):
        if ids.get(scheme):
            rec.identifiers[scheme] = str(ids[scheme]).rsplit("/", 1)[-1]
    if rec.doi:
        rec.identifiers["doi"] = rec.doi
    rec.title = w.get("title") or w.get("display_name")
    rec.abstract = _abstract_from_inverted(w.get("abstract_inverted_index"))
    if rec.abstract is None:
        rec.missing_reasons["abstract"] = "not_provided_by_source"
    for a in w.get("authorships") or []:
        au = a.get("author") or {}
        name = au.get("display_name") or a.get("raw_author_name")
        if not name:
            continue
        rec.authors.append(
            AuthorRec(
                display_name=name,
                orcid=normalize_orcid(au.get("orcid")),
                provider_author_id=(au.get("id") or "").rsplit("/", 1)[-1] or None,
                affiliations=[
                    {
                        "name": i.get("display_name"),
                        "ror": i.get("ror"),
                        "country_code": i.get("country_code"),
                        "source": "openalex",
                    }
                    for i in a.get("institutions") or []
                ],
            )
        )
    primary = w.get("primary_location") or {}
    rec.venue = (primary.get("source") or {}).get("display_name")
    rec.publication_date = w.get("publication_date")
    rec.publication_year = w.get("publication_year") or year_from_date(rec.publication_date)
    rec.document_type = w.get("type")
    rec.language = w.get("language")
    rec.keywords = [k.get("display_name") for k in w.get("keywords") or [] if k.get("display_name")]
    best = w.get("best_oa_location") or {}
    rec.license = best.get("license") or primary.get("license")
    rec.is_retracted = w.get("is_retracted")
    rec.cited_by_count = w.get("cited_by_count")
    rec.is_oa = (w.get("open_access") or {}).get("is_oa")
    seen: set[str] = set()
    for loc in [best, primary, *(w.get("locations") or [])]:
        lr = _location(loc)
        key = (lr.pdf_url or lr.landing_page_url or "") if lr else ""
        if lr and key and key not in seen:
            seen.add(key)
            rec.locations.append(lr)
    return rec.finalize("not_provided_by_source")


class OpenAlexConnector(HttpMixin):
    info = INFO

    def __init__(self, settings: Settings, client: httpx.Client | None = None):
        self.settings = settings
        self.client = client or httpx.Client(timeout=settings.http_timeout_seconds, follow_redirects=False)

    def configured(self) -> tuple[bool, str | None]:
        if not self.settings.openalex_enabled:
            return False, "disabled"
        return True, None

    def _common(self) -> dict:
        p: dict = {}
        if self.settings.contact_email:
            p["mailto"] = self.settings.contact_email
        if self.settings.openalex_api_key:
            p["api_key"] = self.settings.openalex_api_key
        return p

    def build_query(self, q: SearchQuery) -> tuple[str, dict]:
        filters = []
        if q.date_from:
            filters.append(f"from_publication_date:{q.date_from.isoformat()}")
        if q.date_to:
            filters.append(f"to_publication_date:{q.date_to.isoformat()}")
        if q.languages:
            filters.append("language:" + "|".join(q.languages))
        types = [TYPE_MAP[t] for t in q.document_types if t in TYPE_MAP]
        if types:
            filters.append("type:" + "|".join(types))
        params = {"search": q.text}
        if filters:
            params["filter"] = ",".join(filters)
        return q.text, params

    def search_page(self, q: SearchQuery, cursor: str | None, per_page: int) -> Page:
        _, params = self.build_query(q)
        params = {**params, "per_page": min(per_page, 200), "cursor": cursor or "*", **self._common()}
        url = f"{BASE}/works"
        resp = self._get(url, params)
        data = resp.json()
        meta = data.get("meta") or {}
        safe_params = {k: v for k, v in params.items() if k != "api_key"}
        return Page(
            records=[parse_work(w) for w in data.get("results") or []],
            next_cursor=meta.get("next_cursor"),
            total_available=meta.get("count"),
            request_url=url,
            request_params=safe_params,
        )

    def get_by_doi(self, doi: str) -> NormalizedRecord | None:
        resp = self._get(f"{BASE}/works/https://doi.org/{doi}", self._common())
        if resp.status_code == 404:
            return None
        return parse_work(resp.json())
