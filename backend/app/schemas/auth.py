from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


def check_password(v: str) -> str:
    if len(v) < 8:
        raise ValueError("A senha deve ter pelo menos 8 caracteres")
    if len(v) > 256:
        raise ValueError("A senha é longa demais")
    if v.isdigit() or v.isalpha():
        raise ValueError("Combine letras com números ou símbolos")
    return v


class RegisterIn(BaseModel):
    email: EmailStr
    password: str
    display_name: str = Field(min_length=1, max_length=80)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        return v.strip().lower()

    @field_validator("password")
    @classmethod
    def _pw(cls, v: str) -> str:
        return check_password(v)

    @field_validator("display_name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("Informe seu nome")
        return v


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        return v.strip().lower()


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    display_name: str
    created_at: datetime


class AuthOut(UserOut):
    # Only returned to the app client (X-PDBook-Client: app); the browser gets an HttpOnly cookie.
    session_token: str | None = None


class AccountUpdateIn(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=80)
    email: EmailStr | None = None
    current_password: str | None = Field(default=None, max_length=256)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str | None) -> str | None:
        return v.strip().lower() if v else v


class PasswordChangeIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str

    @field_validator("new_password")
    @classmethod
    def _pw(cls, v: str) -> str:
        return check_password(v)


class AccountDeleteIn(BaseModel):
    password: str = Field(min_length=1, max_length=256)
