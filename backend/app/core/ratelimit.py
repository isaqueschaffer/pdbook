"""Fixed-window rate limiting backed by Redis (shared by all API processes)."""

from __future__ import annotations

import hashlib
import logging

from fastapi import HTTPException, Request, status
from redis.exceptions import RedisError

from app.core.redis import get_redis

log = logging.getLogger(__name__)


def client_ip(request: Request) -> str:
    # uvicorn runs with --proxy-headers behind Caddy, so request.client is the real address.
    return request.client.host if request.client else "unknown"


def enforce(bucket: str, identity: str, limit: int, window: int) -> None:
    if limit <= 0:
        return
    digest = hashlib.sha256(identity.encode()).hexdigest()[:24]
    key = f"pdbook:rl:{bucket}:{digest}"
    try:
        redis = get_redis()
        count = redis.incr(key)
        if count == 1:
            redis.expire(key, window)
        if count > limit:
            ttl = redis.ttl(key)
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
                headers={"Retry-After": str(max(int(ttl), 1))},
            )
    except RedisError:
        # Fail open: Redis being briefly unavailable must not lock everyone out.
        log.warning("rate limiter unavailable (redis error)")
