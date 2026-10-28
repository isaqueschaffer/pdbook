from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import delete, select

from app.api.deps import DB, CurrentUser, clear_session_cookie, current_session, start_session
from app.core import ratelimit
from app.core.config import get_settings
from app.core.security import hash_password, password_needs_rehash, verify_password
from app.models import User, UserSession
from app.schemas.auth import LoginIn, RegisterIn, UserOut

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def register(payload: RegisterIn, request: Request, response: Response, db: DB) -> User:
    s = get_settings()
    ratelimit.enforce("register", ratelimit.client_ip(request), s.register_rate_limit, s.register_rate_window)
    if db.scalar(select(User.id).where(User.email == payload.email)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Já existe uma conta com este e-mail.")
    user = User(email=payload.email, display_name=payload.display_name, password_hash=hash_password(payload.password))
    db.add(user)
    db.flush()
    start_session(db, user, request, response)
    return user


@router.post("/login", response_model=UserOut)
def login(payload: LoginIn, request: Request, response: Response, db: DB) -> User:
    s = get_settings()
    ratelimit.enforce("login-ip", ratelimit.client_ip(request), s.login_rate_limit * 3, s.login_rate_window)
    ratelimit.enforce("login-account", payload.email, s.login_rate_limit, s.login_rate_window)
    user = db.scalar(select(User).where(User.email == payload.email))
    if not verify_password(payload.password, user.password_hash if user else None) or user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "E-mail ou senha incorretos.")
    if password_needs_rehash(user.password_hash):
        user.password_hash = hash_password(payload.password)
    # Opportunistic cleanup of this user's expired sessions.
    db.execute(delete(UserSession).where(UserSession.user_id == user.id, UserSession.expires_at < datetime.now(timezone.utc)))
    start_session(db, user, request, response)
    return user


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request, response: Response, db: DB) -> Response:
    try:
        sess = current_session(request, db)
        db.delete(sess)
        db.commit()
    except HTTPException:
        pass
    clear_session_cookie(response)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/me", response_model=UserOut)
def me(user: CurrentUser) -> User:
    return user
