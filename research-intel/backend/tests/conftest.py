"""Test harness: real PostgreSQL (schema built by Alembic), eager Celery, mock HTTP.

No test touches the network. Provider responses come from tests/fixtures/*.json,
which are synthetic and labelled FIXTURE.
"""

import json
import os
import tempfile
from pathlib import Path

os.environ.setdefault("RIP_DATABASE_URL", "postgresql+psycopg://rip:rip@localhost:5432/rip_test")
os.environ["RIP_CELERY_EAGER"] = "true"
os.environ["RIP_STORAGE_BACKEND"] = "local"
os.environ["RIP_STORAGE_LOCAL_ROOT"] = tempfile.mkdtemp(prefix="rip-test-storage-")
os.environ["RIP_SECRET_KEY"] = "test-secret-key-not-for-production-use-0123456789"
os.environ["RIP_CONTACT_EMAIL"] = "tests@example.org"
os.environ["RIP_RATE_LIMIT_BACKEND"] = "memory"

import httpx  # noqa: E402
import pymupdf  # noqa: E402
import pytest  # noqa: E402
from alembic.config import Config  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402

from alembic import command  # noqa: E402
from app.connectors import registry  # noqa: E402
from app.connectors.crossref import CrossrefConnector  # noqa: E402
from app.connectors.openalex import OpenAlexConnector  # noqa: E402
from app.services import netsafe  # noqa: E402

FIX = Path(__file__).parent / "fixtures"
BACKEND = Path(__file__).resolve().parent.parent


def fixture_json(name: str) -> dict:
    return json.loads((FIX / name).read_text())


@pytest.fixture(scope="session", autouse=True)
def _schema():
    url = os.environ["RIP_DATABASE_URL"]
    eng = create_engine(url)
    with eng.begin() as c:
        c.execute(text("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"))
    eng.dispose()
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "alembic"))
    command.upgrade(cfg, "head")
    yield


@pytest.fixture(autouse=True)
def _clean_db(_schema):
    from app.services import ratelimit

    ratelimit.reset()
    yield
    eng = create_engine(os.environ["RIP_DATABASE_URL"])
    with eng.begin() as c:
        tables = c.execute(text(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'alembic_version'"
        )).scalars().all()
        c.execute(text("TRUNCATE " + ", ".join(f'"{t}"' for t in tables) + " CASCADE"))
    eng.dispose()


# ------------------------------------------------------------------ mock providers


class ProviderMock:
    """Serves fixture pages keyed by cursor; can be told to fail or rate-limit."""

    def __init__(self):
        self.calls: list[httpx.Request] = []
        self.openalex_mode = "ok"  # ok | 429 | 500 | fail_page2
        self.crossref_mode = "ok"

    def openalex(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        cursor = request.url.params.get("cursor")
        if self.openalex_mode == "429":
            return httpx.Response(429, headers={"Retry-After": "120"})
        if self.openalex_mode == "500":
            return httpx.Response(500)
        if "/works/https://doi.org/" in request.url.path:
            doi = request.url.path.split("doi.org/")[-1].lower()
            for w in fixture_json("openalex_works_page1.json")["results"]:
                if (w.get("doi") or "").lower().endswith(doi):
                    return httpx.Response(200, json=w)
            return httpx.Response(404)
        if cursor == "FIXTURE_CURSOR_2":
            if self.openalex_mode == "fail_page2":
                return httpx.Response(503)
            return httpx.Response(200, json=fixture_json("openalex_works_page2.json"))
        return httpx.Response(200, json=fixture_json("openalex_works_page1.json"))

    def crossref(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        if self.crossref_mode == "500":
            return httpx.Response(500)
        if request.url.path.startswith("/works/10."):
            return httpx.Response(404)
        if request.url.params.get("cursor") == "FIXTURE_CR_CURSOR_2":
            return httpx.Response(200, json=fixture_json("crossref_works_page2.json"))
        return httpx.Response(200, json=fixture_json("crossref_works_page1.json"))


@pytest.fixture
def providers():
    mock = ProviderMock()

    def oa(settings):
        c = OpenAlexConnector(settings, client=httpx.Client(transport=httpx.MockTransport(mock.openalex)))
        c.sleep = lambda s: None
        return c

    def cr(settings):
        c = CrossrefConnector(settings, client=httpx.Client(transport=httpx.MockTransport(mock.crossref)))
        c.sleep = lambda s: None
        return c

    registry.set_factory("openalex", oa)
    registry.set_factory("crossref", cr)
    yield mock
    registry.set_factory("openalex", lambda s: OpenAlexConnector(s))
    registry.set_factory("crossref", lambda s: CrossrefConnector(s))


# ------------------------------------------------------------------ PDFs & web


def make_pdf(pages: list[str], labels: list[str] | None = None) -> bytes:
    doc = pymupdf.open()
    for t in pages:
        page = doc.new_page()
        y = 72
        for para in t.split("\n\n"):
            page.insert_textbox(pymupdf.Rect(72, y, 540, y + 200), para, fontsize=11)
            y += 120
    if labels:
        doc.set_page_labels([{"startpage": 0, "prefix": "", "style": "D", "firstpagenum": int(labels[0])}])
    data = doc.tobytes()
    doc.close()
    return data


SAMPLE_PAGES = [
    "Introduction\n\nBattery thermal management keeps lithium-ion cells within a safe temperature window.",
    "Methods\n\nA liquid cooling plate with serpentine channels was simulated under fast charging.",
    "Results\n\nPeak temperature fell by 8 K and temperature uniformity improved across the module.",
]


class WebMock:
    """Fake internet for PDF fetches. Host -> IP mapping drives SSRF validation."""

    def __init__(self):
        self.dns = {"repo.example.org": ["93.184.216.34"], "publisher.example.com": ["93.184.216.35"],
                    "evil.example.net": ["10.0.0.7"], "rebind.example.net": ["93.184.216.36", "127.0.0.1"]}
        self.routes: dict[str, httpx.Response] = {}
        self.requests: list[str] = []

    def resolve(self, host):
        if host not in self.dns:
            raise netsafe.UnsafeURL(f"DNS resolution failed for {host}")
        return self.dns[host]

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.requests.append(url)
        if url in self.routes:
            r = self.routes[url]
            return httpx.Response(r.status_code, headers=r.headers, content=r.content)
        return httpx.Response(404)


@pytest.fixture
def web(monkeypatch):
    w = WebMock()
    monkeypatch.setattr(netsafe, "RESOLVER", w.resolve)
    monkeypatch.setattr(netsafe, "TRANSPORT", httpx.MockTransport(w.handler))
    return w


# ------------------------------------------------------------------ API clients


@pytest.fixture
def client():
    from app.main import app

    with TestClient(app) as c:
        yield c


def register(client, email: str, name: str = "Test User", password: str = "correct-horse-battery") -> dict:
    r = client.post("/api/v1/auth/register", json={"email": email, "password": password, "display_name": name})
    assert r.status_code == 201, r.text
    r = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
def owner(client):
    return register(client, "owner@example.org", "Owner")


@pytest.fixture
def project(client, owner):
    r = client.post("/api/v1/projects", headers=owner,
                    json={"name": "Thermal", "research_question": "battery thermal management cooling"})
    assert r.status_code == 201, r.text
    return r.json()
