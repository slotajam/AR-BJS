"""Request dependencies: authentication and server-side project authorisation."""

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import AuditLog, Membership, User
from app.security import decode_token

bearer = HTTPBearer(auto_error=False)

ROLE_RANK = {"viewer": 0, "editor": 1, "admin": 2, "owner": 3}


def current_user(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> User:
    token = creds.credentials if creds else None
    # EventSource cannot set headers; SSE endpoints accept ?access_token=.
    if token is None and request.url.path.endswith("/events"):
        token = request.query_params.get("access_token")
    user_id = decode_token(token) if token else None
    user = db.get(User, user_id) if user_id else None
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated", headers={"WWW-Authenticate": "Bearer"})
    return user


def require_role(db: Session, user: User, project_id: str, minimum: str) -> Membership:
    """Return the membership or raise. Non-members get 404 so project existence is not leaked."""
    m = db.scalar(select(Membership).where(Membership.project_id == project_id, Membership.user_id == user.id))
    if m is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    if ROLE_RANK[m.role] < ROLE_RANK[minimum]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"Requires {minimum} role")
    return m


def audit(
    db: Session,
    *,
    user_id: str | None,
    project_id: str | None,
    action: str,
    entity_type: str,
    entity_id: str | None = None,
    details: dict | None = None,
    request: Request | None = None,
) -> None:
    db.add(
        AuditLog(
            user_id=user_id,
            project_id=project_id,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            details=details or {},
            ip=request.client.host if request and request.client else None,
        )
    )
