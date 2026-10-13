"""Connector registry and runtime status (available / unconfigured / disabled / rate_limited / error)."""

from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.connectors.base import Connector
from app.connectors.crossref import CrossrefConnector
from app.connectors.openalex import OpenAlexConnector
from app.models import ConnectorState

DEFERRED = {
    "semantic_scholar": "Deferred to Phase 2",
    "unpaywall": "Deferred to Phase 2",
    "arxiv": "Deferred to Phase 2",
    "pubmed": "Deferred to Phase 2",
    "google_scholar": "Not supported: no official API; automated scraping is not permitted",
}

_FACTORIES: dict[str, Callable[[Settings], Connector]] = {
    "openalex": lambda s: OpenAlexConnector(s),
    "crossref": lambda s: CrossrefConnector(s),
}

# Error state is shown for this long after the most recent failure unless a success follows.
ERROR_WINDOW = timedelta(minutes=30)


def set_factory(name: str, factory: Callable[[Settings], Connector]) -> None:
    """Override a connector constructor (tests inject mock HTTP transports here)."""
    _FACTORIES[name] = factory


def get_connector(name: str) -> Connector:
    if name not in _FACTORIES:
        raise KeyError(name)
    return _FACTORIES[name](get_settings())


def names() -> list[str]:
    return list(_FACTORIES)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt


def connector_state(db: Session, name: str) -> tuple[str, str | None]:
    conn = get_connector(name)
    ok, reason = conn.configured()
    if not ok:
        return ("disabled" if reason == "disabled" else "unconfigured"), reason
    st = db.get(ConnectorState, name)
    now = datetime.now(UTC)
    if st:
        if _aware(st.rate_limited_until) and _aware(st.rate_limited_until) > now:
            return "rate_limited", f"until {st.rate_limited_until.isoformat()}"
        err_at, ok_at = _aware(st.last_error_at), _aware(st.last_success_at)
        if err_at and (ok_at is None or err_at > ok_at) and now - err_at < ERROR_WINDOW:
            return "error", st.last_error
    return "available", None


def record_outcome(db: Session, name: str, *, error: str | None = None, retry_after: float | None = None,
                   rate_limited: bool = False) -> None:
    st = db.get(ConnectorState, name) or ConnectorState(name=name)
    now = datetime.now(UTC)
    st.last_checked_at = now
    if rate_limited:
        st.rate_limited_until = now + timedelta(seconds=retry_after or 60)
        st.last_error, st.last_error_at = error or "rate limited", now
    elif error:
        st.last_error, st.last_error_at = error, now
    else:
        st.last_success_at = now
        st.rate_limited_until = None
    db.merge(st)


def status_report(db: Session) -> list[dict]:
    out = []
    for name in names():
        conn = get_connector(name)
        state, detail = connector_state(db, name)
        st = db.get(ConnectorState, name)
        i = conn.info
        out.append(
            {
                "name": i.name,
                "display_name": i.display_name,
                "state": state,
                "detail": detail,
                "version": i.version,
                "documentation_url": i.documentation_url,
                "verified_on": i.verified_on,
                "verification_method": i.verification_method,
                "authentication": i.authentication,
                "rate_limits": i.rate_limits,
                "pagination": i.pagination,
                "capabilities": list(i.capabilities),
                "last_success_at": st.last_success_at if st else None,
                "last_error": st.last_error if st else None,
                "last_error_at": st.last_error_at if st else None,
                "rate_limited_until": st.rate_limited_until if st else None,
            }
        )
    for name, reason in DEFERRED.items():
        out.append({"name": name, "display_name": name, "state": "disabled", "detail": reason,
                    "capabilities": [], "verified_on": None})
    return out
