"""Password hashing (Argon2id) and signed, expiring access tokens (HS256 JWT).

For production deployments behind an OIDC identity provider, replace
``decode_token`` with provider token verification; the rest of the app only
depends on ``current_user``.
"""

from datetime import UTC, datetime, timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

from app.config import get_settings

_ph = PasswordHasher()
ALGORITHM = "HS256"


def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _ph.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


def create_access_token(user_id: str) -> str:
    s = get_settings()
    now = datetime.now(UTC)
    payload = {"sub": user_id, "iat": now, "exp": now + timedelta(minutes=s.access_token_minutes), "typ": "access"}
    return jwt.encode(payload, s.secret_key, algorithm=ALGORITHM)


def create_stream_ticket(user_id: str, job_id: str, seconds: int = 60) -> str:
    """Short-lived token usable only to open the SSE stream of one job (EventSource can't send headers,
    so this goes in the URL instead of the long-lived access token)."""
    now = datetime.now(UTC)
    payload = {"sub": user_id, "job": job_id, "iat": now, "exp": now + timedelta(seconds=seconds), "typ": "sse"}
    return jwt.encode(payload, get_settings().secret_key, algorithm=ALGORITHM)


def decode_stream_ticket(ticket: str, job_id: str) -> str | None:
    try:
        payload = jwt.decode(ticket, get_settings().secret_key, algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        return None
    if payload.get("typ") != "sse" or payload.get("job") != job_id:
        return None
    return payload.get("sub")


def decode_token(token: str) -> str | None:
    try:
        payload = jwt.decode(token, get_settings().secret_key, algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        return None
    if payload.get("typ") != "access":
        return None
    return payload.get("sub")
