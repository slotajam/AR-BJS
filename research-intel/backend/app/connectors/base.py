"""Connector contract, shared HTTP behaviour (timeouts, bounded retries, backoff,
Retry-After) and the verification metadata every connector must declare."""

import random
import time
from dataclasses import dataclass, field
from datetime import date
from email.utils import parsedate_to_datetime
from typing import Protocol

import httpx

from app.config import Settings
from app.services.normalize import NormalizedRecord


@dataclass(frozen=True)
class ConnectorInfo:
    name: str
    display_name: str
    version: str
    documentation_url: str
    # Date the declared behaviour was last checked against the *live* service, or None.
    verified_on: str | None
    verification_method: str
    authentication: str
    rate_limits: str
    pagination: str
    capabilities: tuple[str, ...]


@dataclass
class SearchQuery:
    text: str  # provider-ready query string (already expanded deterministically)
    date_from: date | None = None
    date_to: date | None = None
    languages: list[str] = field(default_factory=list)
    document_types: list[str] = field(default_factory=list)


@dataclass
class Page:
    records: list[NormalizedRecord]
    next_cursor: str | None
    total_available: int | None
    request_url: str
    request_params: dict


class RateLimited(Exception):
    def __init__(self, retry_after: float | None):
        super().__init__(f"rate limited (retry after {retry_after}s)")
        self.retry_after = retry_after


class ConnectorError(Exception):
    pass


class Connector(Protocol):
    info: ConnectorInfo

    def configured(self) -> tuple[bool, str | None]: ...

    def build_query(self, q: SearchQuery) -> tuple[str, dict]: ...

    def search_page(self, q: SearchQuery, cursor: str | None, per_page: int) -> Page: ...

    def get_by_doi(self, doi: str) -> NormalizedRecord | None: ...


def parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        try:
            return max(0.0, parsedate_to_datetime(value).timestamp() - time.time())
        except (TypeError, ValueError):
            return None


class HttpMixin:
    """Polite HTTP client with bounded retries. Retries 429/5xx/transport errors only."""

    settings: Settings
    client: httpx.Client
    min_interval: float = 0.11  # client-side throttle between requests
    _last_request: float = 0.0
    sleep = staticmethod(time.sleep)

    def _user_agent(self) -> str:
        contact = self.settings.contact_email
        return f"ResearchIntelPlatform/0.1 (mailto:{contact})" if contact else "ResearchIntelPlatform/0.1"

    def _get(self, url: str, params: dict) -> httpx.Response:
        attempts = self.settings.http_max_retries + 1
        last_exc: Exception | None = None
        for attempt in range(attempts):
            wait = self.min_interval - (time.monotonic() - self._last_request)
            if wait > 0:
                self.sleep(wait)
            self._last_request = time.monotonic()
            try:
                resp = self.client.get(url, params=params, headers={"User-Agent": self._user_agent()})
            except httpx.TransportError as e:
                last_exc = e
                self.sleep(min(30.0, (2**attempt) + random.random()))
                continue
            if resp.status_code == 429:
                ra = parse_retry_after(resp.headers.get("Retry-After"))
                if attempt == attempts - 1 or (ra is not None and ra > 60):
                    raise RateLimited(ra)
                self.sleep(ra if ra is not None else min(30.0, 2**attempt))
                continue
            if resp.status_code >= 500:
                last_exc = ConnectorError(f"HTTP {resp.status_code} from {url}")
                self.sleep(min(30.0, (2**attempt) + random.random()))
                continue
            if resp.status_code == 404:
                return resp
            if resp.status_code >= 400:
                raise ConnectorError(f"HTTP {resp.status_code} from {url}: {resp.text[:300]}")
            return resp
        raise ConnectorError(f"giving up after {attempts} attempts: {last_exc}")
