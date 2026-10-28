from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from redis.exceptions import RedisError
from rq import Worker
from sqlalchemy import text

from app.core.config import get_settings
from app.core.redis import get_redis
from app.db.session import get_engine
from app.schemas.books import PublicConfig

router = APIRouter(tags=["system"])


@router.get("/health")
def health() -> dict:
    """Liveness: the process is up. Used by the container health check."""
    return {"status": "ok"}


@router.get("/health/ready")
def ready() -> JSONResponse:
    """Readiness: database, Redis and worker reachable. Does not leak connection details."""
    checks: dict[str, str] = {}
    try:
        with get_engine().connect() as conn:
            conn.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception:  # noqa: BLE001
        checks["database"] = "error"
    try:
        redis = get_redis()
        redis.ping()
        checks["redis"] = "ok"
        checks["workers"] = str(Worker.count(connection=redis))
    except RedisError:
        checks["redis"] = "error"
        checks["workers"] = "unknown"
    healthy = checks["database"] == "ok" and checks["redis"] == "ok"
    return JSONResponse({"status": "ok" if healthy else "degraded", "checks": checks}, status_code=200 if healthy else 503)


@router.get("/config", response_model=PublicConfig)
def public_config() -> PublicConfig:
    s = get_settings()
    return PublicConfig(max_upload_mb=s.max_upload_mb, max_pdf_pages=s.max_pdf_pages, ocr_enabled=s.ocr_enabled)
