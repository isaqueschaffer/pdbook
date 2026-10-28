from __future__ import annotations

from functools import lru_cache

from redis import Redis

from app.core.config import get_settings


@lru_cache
def get_redis() -> Redis:
    # RQ stores pickled payloads, so responses must stay as bytes (no decode_responses).
    return Redis.from_url(get_settings().redis_url, socket_timeout=10, socket_connect_timeout=5, health_check_interval=30)
