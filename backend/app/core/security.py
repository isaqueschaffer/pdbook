"""Password hashing (Argon2id) and opaque session tokens.

Session tokens are random 256-bit values handed to the browser in an HttpOnly cookie.
Only an HMAC of the token is stored, so a database leak does not expose usable sessions.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from app.core.config import get_settings

# Moderate parameters: ~50 ms on an Ampere A1 core, 32 MiB per hash.
_hasher = PasswordHasher(time_cost=2, memory_cost=32 * 1024, parallelism=1)

# Used to keep login timing similar whether or not the e-mail exists.
_DUMMY_HASH = _hasher.hash("pdbook-timing-equaliser")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def password_needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def hash_session_token(token: str) -> str:
    key = get_settings().session_secret.encode()
    return hmac.new(key, token.encode(), hashlib.sha256).hexdigest()
