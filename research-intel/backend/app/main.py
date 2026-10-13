from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.api import analysis, auth, connectors, papers, projects, searches
from app.config import get_settings
from app.db import get_engine

settings = get_settings()
app = FastAPI(
    title="Research Paper Intelligence Platform",
    version="0.1.0",
    description="Phase 1 MVP: traceable, rights-aware scholarly discovery, collection, evidence and ranking.",
    openapi_url="/api/v1/openapi.json",
    docs_url="/api/v1/docs",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.middleware("http")
async def security_headers(request, call_next):
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    return resp


for r in (auth.router, projects.router, searches.router, papers.router, analysis.router, connectors.router):
    app.include_router(r, prefix="/api/v1")


@app.get("/api/v1/health", tags=["meta"])
def health():
    with get_engine().connect() as c:
        c.execute(text("SELECT 1"))
    return {"status": "ok"}
