"""Application settings, loaded from environment variables (and an optional .env file).

Every limit that matters for a small VPS is configurable here; see README "Ajuste de limites".
"""

from __future__ import annotations

import sys
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import AliasChoices, Field, ValidationError, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

PLACEHOLDER_SECRETS = {"change-me", "troque-este-valor", "dev-secret"}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    environment: Literal["development", "production", "test"] = "development"
    log_level: str = "INFO"

    # --- Database (Neon PostgreSQL) ---
    database_url: str
    # Direct (non-pooled) Neon URL for Alembic; falls back to DATABASE_URL.
    database_migration_url: str | None = None
    db_pool_size: int = Field(3, ge=1, le=20)
    db_max_overflow: int = Field(2, ge=0, le=20)
    db_pool_recycle: int = 300

    # --- Sessions ---
    session_secret: str = Field(validation_alias=AliasChoices("SESSION_SECRET", "JWT_SECRET"))
    session_ttl_days: int = Field(30, ge=1, le=365)
    session_cookie_name: str = "bookflow_session"
    cookie_secure: bool | None = None  # defaults to True in production

    # --- Redis / RQ ---
    redis_url: str
    worker_concurrency: int = Field(1, ge=1, le=8)
    job_timeout_seconds: int = Field(900, ge=30)
    ocr_job_timeout_seconds: int = Field(3600, ge=60)
    job_max_retries: int = Field(2, ge=0, le=10)
    worker_memory_limit_mb: int = Field(1536, ge=0)  # 0 disables the per-job address-space limit

    # --- Storage ---
    upload_dir: Path = Path("/data/originals")
    converted_dir: Path = Path("/data/converted")
    tmp_dir: Path = Path("/data/tmp")
    storage_limit_mb: int = Field(40_000, ge=100)
    storage_warn_percent: int = Field(85, ge=1, le=100)
    min_free_disk_mb: int = Field(1024, ge=0)
    user_quota_mb: int = Field(0, ge=0)  # 0 = no per-user quota

    # --- Documents ---
    max_upload_mb: int = Field(50, ge=1, le=2048)
    max_pdf_pages: int = Field(250, ge=1, le=10_000)
    max_images_per_book: int = Field(300, ge=0)
    min_image_px: int = Field(120, ge=16)

    # --- OCR ---
    ocr_enabled: bool = True
    ocr_languages: str = "por+eng"
    ocr_dpi: int = Field(200, ge=72, le=400)
    ocr_page_timeout: int = Field(120, ge=10)
    ocr_min_chars_per_page: int = Field(40, ge=0)

    # --- HTTP ---
    frontend_url: str = "http://localhost:5173"
    cors_origins: str = ""
    login_rate_limit: int = 10
    login_rate_window: int = 300
    register_rate_limit: int = 5
    register_rate_window: int = 3600
    upload_rate_limit: int = 30
    upload_rate_window: int = 3600

    @field_validator("session_secret")
    @classmethod
    def _strong_secret(cls, v: str) -> str:
        if len(v) < 32 or v.lower() in PLACEHOLDER_SECRETS:
            raise ValueError("deve ter pelo menos 32 caracteres aleatórios (gere com: openssl rand -hex 32)")
        return v

    @field_validator("database_url", "database_migration_url")
    @classmethod
    def _sqlalchemy_driver(cls, v: str | None) -> str | None:
        # Neon hands out postgresql:// URLs; SQLAlchemy needs the psycopg (v3) driver name.
        if v and v.startswith("postgres://"):
            v = "postgresql://" + v[len("postgres://"):]
        if v and v.startswith("postgresql://"):
            v = "postgresql+psycopg://" + v[len("postgresql://"):]
        return v

    @model_validator(mode="after")
    def _production_checks(self) -> "Settings":
        if self.environment == "production" and self.database_url.startswith("sqlite"):
            raise ValueError("DATABASE_URL: SQLite não é suportado em produção; use a URL do Neon")
        return self

    @property
    def secure_cookies(self) -> bool:
        return self.cookie_secure if self.cookie_secure is not None else self.environment == "production"

    @property
    def allowed_origins(self) -> list[str]:
        origins = [o.strip().rstrip("/") for o in self.cors_origins.split(",") if o.strip()]
        if self.frontend_url:
            origins.append(self.frontend_url.rstrip("/"))
        return sorted(set(origins))

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def migration_url(self) -> str:
        return self.database_migration_url or self.database_url


def _explain(exc: ValidationError) -> str:
    lines = ["Configuração inválida. Verifique as variáveis de ambiente (veja .env.example):"]
    for err in exc.errors():
        name = str(err["loc"][0]).upper() if err["loc"] else "?"
        msg = "obrigatória e não definida" if err["type"] == "missing" else err["msg"]
        lines.append(f"  - {name}: {msg}")
    return "\n".join(lines)


@lru_cache
def get_settings() -> Settings:
    try:
        return Settings()  # type: ignore[call-arg]
    except ValidationError as exc:
        print(_explain(exc), file=sys.stderr)
        raise SystemExit(2) from None
