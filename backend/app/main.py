from __future__ import annotations

import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import account, auth, books, reader, system
from app.core.config import get_settings
from app.core.logging import setup_logging
from app.services.storage import ensure_dirs

log = logging.getLogger("pdbook")

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
CSRF_HEADER = "x-requested-with"
CSRF_VALUE = "PDBook"


@asynccontextmanager
async def lifespan(_: FastAPI):
    ensure_dirs()
    log.info("PDBook API started (%s)", get_settings().environment)
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    setup_logging(settings.log_level)
    docs = settings.environment != "production"
    app = FastAPI(
        title="PDBook API",
        version="1.0.0",
        lifespan=lifespan,
        docs_url="/api/docs" if docs else None,
        redoc_url=None,
        openapi_url="/api/openapi.json" if docs else None,
    )

    if settings.allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.allowed_origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=["Content-Type", "X-Requested-With"],
        )

    @app.middleware("http")
    async def guard(request: Request, call_next):
        started = time.perf_counter()
        request_id = uuid.uuid4().hex[:12]
        path = request.url.path
        if request.method in UNSAFE_METHODS and path.startswith("/api/"):
            # CSRF: browsers cannot attach custom headers to cross-site requests without a CORS
            # preflight, which only our own origin passes. Cookies are also SameSite=Lax.
            if request.headers.get(CSRF_HEADER) != CSRF_VALUE:
                return JSONResponse({"detail": "Requisição recusada."}, status_code=403)
            length = request.headers.get("content-length")
            limit = settings.max_upload_bytes + 1024 * 1024 if path == "/api/books" else 1024 * 1024
            if length and length.isdigit() and int(length) > limit:
                return JSONResponse({"detail": f"O arquivo excede o limite de {settings.max_upload_mb} MB."}, status_code=413)
        try:
            response = await call_next(request)
        except Exception:
            log.exception("unhandled error [%s] %s %s", request_id, request.method, path)
            response = JSONResponse({"detail": "Erro interno. Tente novamente.", "request_id": request_id}, status_code=500)
        response.headers["X-Request-ID"] = request_id
        if path.startswith("/api/") and "Cache-Control" not in response.headers:
            response.headers["Cache-Control"] = "no-store"
        # Path only: query strings may carry search terms.
        log.info("%s %s %s %.0fms [%s]", request.method, path, response.status_code, (time.perf_counter() - started) * 1000, request_id)
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        errors = []
        for err in exc.errors():
            field = ".".join(str(p) for p in err.get("loc", [])[1:]) or None
            msg = str(err.get("msg", "Valor inválido")).removeprefix("Value error, ")
            errors.append({"field": field, "message": msg})
        detail = errors[0]["message"] if errors else "Dados inválidos"
        return JSONResponse({"detail": detail, "errors": errors}, status_code=422)

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException) -> JSONResponse:
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code, headers=exc.headers)

    for router in (system.router, auth.router, account.router, books.router, reader.router):
        app.include_router(router, prefix="/api")
    return app


app = create_app()
