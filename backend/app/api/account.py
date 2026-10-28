from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import delete, select

from app.api.deps import DB, CurrentUser, clear_session_cookie, current_session
from app.core import ratelimit
from app.core.config import get_settings
from app.core.security import hash_password, verify_password
from app.models import Book, ReaderPreferences, User, UserSession
from app.schemas.auth import AccountDeleteIn, AccountUpdateIn, PasswordChangeIn, UserOut
from app.schemas.books import StorageOut
from app.schemas.reader import PreferencesIn, PreferencesOut
from app.services import storage
from app.services.books import delete_book

router = APIRouter(tags=["account"])


def _check_password(request: Request, user: User, password: str | None) -> None:
    s = get_settings()
    ratelimit.enforce("reauth", str(user.id), s.login_rate_limit, s.login_rate_window)
    if not password or not verify_password(password, user.password_hash):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Senha atual incorreta.")


@router.patch("/account", response_model=UserOut)
def update_account(payload: AccountUpdateIn, request: Request, user: CurrentUser, db: DB) -> User:
    if payload.display_name is not None:
        user.display_name = " ".join(payload.display_name.split())
    if payload.email and payload.email != user.email:
        _check_password(request, user, payload.current_password)
        if db.scalar(select(User.id).where(User.email == payload.email)):
            raise HTTPException(status.HTTP_409_CONFLICT, "Já existe uma conta com este e-mail.")
        user.email = payload.email
    db.commit()
    return user


@router.post("/account/password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    payload: PasswordChangeIn, request: Request, user: CurrentUser, db: DB, sess: Annotated[UserSession, Depends(current_session)]
) -> None:
    _check_password(request, user, payload.current_password)
    user.password_hash = hash_password(payload.new_password)
    # Changing the password signs out every other device.
    db.execute(delete(UserSession).where(UserSession.user_id == user.id, UserSession.id != sess.id))
    db.commit()


@router.post("/account/logout-all", status_code=status.HTTP_204_NO_CONTENT)
def logout_all(user: CurrentUser, db: DB, response: Response) -> Response:
    db.execute(delete(UserSession).where(UserSession.user_id == user.id))
    db.commit()
    clear_session_cookie(response)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.delete("/account", status_code=status.HTTP_204_NO_CONTENT)
def delete_account(payload: AccountDeleteIn, request: Request, user: CurrentUser, db: DB, response: Response) -> Response:
    _check_password(request, user, payload.password)
    for book in db.scalars(select(Book).where(Book.owner_id == user.id)).all():
        delete_book(db, book)
    db.delete(user)
    db.commit()
    clear_session_cookie(response)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/account/storage", response_model=StorageOut)
def account_storage(user: CurrentUser, db: DB) -> StorageOut:
    st = storage.storage_status(db, user.id)
    return StorageOut(**{k: getattr(st, k) for k in StorageOut.model_fields})


# --- Reader preferences ---


def _prefs(db: DB, user: User) -> ReaderPreferences:
    prefs = db.get(ReaderPreferences, user.id)
    if prefs is None:
        prefs = ReaderPreferences(user_id=user.id, **ReaderPreferences.DEFAULTS)
        db.add(prefs)
        db.commit()
    return prefs


@router.get("/preferences", response_model=PreferencesOut)
def get_preferences(user: CurrentUser, db: DB) -> ReaderPreferences:
    return _prefs(db, user)


@router.put("/preferences", response_model=PreferencesOut)
def put_preferences(payload: PreferencesIn, user: CurrentUser, db: DB) -> ReaderPreferences:
    prefs = _prefs(db, user)
    for k, v in payload.model_dump().items():
        setattr(prefs, k, v)
    db.commit()
    return prefs


@router.post("/preferences/reset", response_model=PreferencesOut)
def reset_preferences(user: CurrentUser, db: DB) -> ReaderPreferences:
    prefs = _prefs(db, user)
    for k, v in ReaderPreferences.DEFAULTS.items():
        setattr(prefs, k, v)
    db.commit()
    return prefs
