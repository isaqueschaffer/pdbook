from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import hash_session_token, new_session_token
from app.db.session import get_db
from app.models import Book, User, UserSession

DB = Annotated[Session, Depends(get_db)]

SESSION_REFRESH_INTERVAL = timedelta(hours=1)

# The mobile app (Capacitor) runs on its own origin (https://localhost, capacitor://localhost), where
# third-party cookies are unreliable. It identifies itself with this header and then authenticates
# with "Authorization: Bearer <token>" instead of the session cookie. Same tokens, same table.
APP_CLIENT_HEADER = "x-pdbook-client"
APP_CLIENT_VALUE = "app"


def is_app_client(request: Request) -> bool:
    return request.headers.get(APP_CLIENT_HEADER) == APP_CLIENT_VALUE


def request_token(request: Request) -> str | None:
    auth = request.headers.get("authorization") or ""
    if auth[:7].lower() == "bearer ":
        return auth[7:].strip() or None
    return request.cookies.get(get_settings().session_cookie_name)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def set_session_cookie(response: Response, token: str) -> None:
    s = get_settings()
    response.set_cookie(
        s.session_cookie_name,
        token,
        max_age=s.session_ttl_days * 86400,
        httponly=True,
        secure=s.secure_cookies,
        samesite="lax",
        path="/api",
    )


def clear_session_cookie(response: Response) -> None:
    s = get_settings()
    response.delete_cookie(s.session_cookie_name, path="/api", httponly=True, secure=s.secure_cookies, samesite="lax")


def start_session(db: Session, user: User, request: Request, response: Response) -> str:
    token = new_session_token()
    now = datetime.now(timezone.utc)
    db.add(
        UserSession(
            user_id=user.id,
            token_hash=hash_session_token(token),
            user_agent=(request.headers.get("user-agent") or "")[:200] or None,
            created_at=now,
            last_seen_at=now,
            expires_at=now + timedelta(days=get_settings().session_ttl_days),
        )
    )
    user.last_login_at = now
    db.commit()
    if not is_app_client(request):
        set_session_cookie(response, token)
    return token


def current_session(request: Request, db: DB) -> UserSession:
    token = request_token(request)
    if not token or len(token) > 200:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sessão expirada. Entre novamente.")
    sess = db.scalar(select(UserSession).where(UserSession.token_hash == hash_session_token(token)))
    now = datetime.now(timezone.utc)
    if sess is None or _aware(sess.expires_at) <= now:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sessão expirada. Entre novamente.")
    # Sliding expiration, written at most once an hour to spare the database.
    if now - _aware(sess.last_seen_at) > SESSION_REFRESH_INTERVAL:
        sess.last_seen_at = now
        sess.expires_at = now + timedelta(days=get_settings().session_ttl_days)
        db.commit()
    return sess


def current_user(sess: Annotated[UserSession, Depends(current_session)], db: DB) -> User:
    user = db.get(User, sess.user_id)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sessão expirada. Entre novamente.")
    return user


CurrentUser = Annotated[User, Depends(current_user)]


def owned_book(book_id: uuid.UUID, user: CurrentUser, db: DB) -> Book:
    book = db.get(Book, book_id)
    # Same 404 whether the book does not exist or belongs to someone else: ids are not enumerable.
    if book is None or book.owner_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Livro não encontrado")
    return book


OwnedBook = Annotated[Book, Depends(owned_book)]
