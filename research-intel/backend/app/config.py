"""Application settings. All secrets come from the environment; nothing is hard-coded."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="RIP_", env_file=".env", extra="ignore")

    env: str = "development"
    database_url: str = "postgresql+psycopg://rip:rip@localhost:5432/rip"
    redis_url: str = "redis://localhost:6379/0"

    # Auth. secret_key has no default in production: startup refuses the dev value.
    secret_key: str = "dev-only-change-me"
    access_token_minutes: int = 60
    allow_registration: bool = True
    # Failed-login throttling (per email; per IP gets 5x the budget)
    rate_limit_backend: str = "redis"  # redis | memory
    login_max_failures: int = 10
    login_window_seconds: int = 900

    # Celery: eager mode runs tasks inline (tests / single-process dev only).
    celery_eager: bool = False

    # Storage
    storage_backend: str = "local"  # local | s3
    storage_local_root: str = "./data/storage"
    s3_endpoint_url: str | None = None
    s3_bucket: str = "rip-private"
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_region: str = "us-east-1"

    # Connectors
    contact_email: str | None = None  # used for OpenAlex / Crossref polite pools
    openalex_enabled: bool = True
    openalex_api_key: str | None = None
    crossref_enabled: bool = True
    crossref_plus_token: str | None = None
    http_timeout_seconds: float = 20.0
    http_max_retries: int = 3

    # PDF acquisition
    pdf_max_bytes: int = 50 * 1024 * 1024
    pdf_max_redirects: int = 5
    # Hosts allowed even if they resolve to private ranges (tests / local MinIO only).
    ssrf_allow_hosts: list[str] = Field(default_factory=list)

    # Embeddings
    embedding_provider: str = "hashing"  # hashing | sentence-transformers
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    embedding_dim: int = 384
    pgvector_enabled: bool = False

    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    if s.env == "production" and s.secret_key == "dev-only-change-me":
        raise RuntimeError("RIP_SECRET_KEY must be set in production")
    return s
