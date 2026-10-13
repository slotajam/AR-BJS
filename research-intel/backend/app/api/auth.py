from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.deps import audit, current_user
from app.models import User
from app.schemas import LoginIn, RegisterIn, TokenOut, UserOut
from app.security import create_access_token, hash_password, verify_password
from app.services import ratelimit

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=UserOut, status_code=201)
def register(body: RegisterIn, request: Request, db: Session = Depends(get_db)):
    if not get_settings().allow_registration:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Registration is disabled")
    email = body.email.lower()
    if db.scalar(select(User).where(func.lower(User.email) == email)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Email already registered")
    user = User(email=email, display_name=body.display_name, password_hash=hash_password(body.password))
    db.add(user)
    db.flush()
    audit(db, user_id=user.id, project_id=None, action="user.register", entity_type="user", entity_id=user.id,
          request=request)
    db.commit()
    return user


@router.post("/login", response_model=TokenOut)
def login(body: LoginIn, request: Request, db: Session = Depends(get_db)):
    email = body.email.lower()
    ip = request.client.host if request.client else None
    if ratelimit.login_blocked(email, ip):
        audit(db, user_id=None, project_id=None, action="user.login_throttled", entity_type="user",
              details={"email": email}, request=request)
        db.commit()
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many failed sign-in attempts; try again later",
                            headers={"Retry-After": str(get_settings().login_window_seconds)})
    user = db.scalar(select(User).where(func.lower(User.email) == email))
    if user is None or not user.is_active or not verify_password(body.password, user.password_hash):
        ratelimit.record_failure(email, ip)
        audit(db, user_id=user.id if user else None, project_id=None, action="user.login_failed",
              entity_type="user", details={"email": email}, request=request)
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
    ratelimit.record_success(email)
    audit(db, user_id=user.id, project_id=None, action="user.login", entity_type="user", entity_id=user.id,
          request=request)
    db.commit()
    return TokenOut(access_token=create_access_token(user.id))


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(current_user)):
    return user
