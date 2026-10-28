"""Persistent file storage on the VPS block volume.

Layout (all names are system-generated, never derived from user input):
    UPLOAD_DIR/<book uuid>.pdf                    original PDFs
    CONVERTED_DIR/<book uuid>/v<N>/manifest.json  converted content, one directory per version
    CONVERTED_DIR/<book uuid>/v<N>/chapters/NNNN.json
    CONVERTED_DIR/<book uuid>/v<N>/images/<name>
    TMP_DIR/                                      uploads in flight and scratch files
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings

log = logging.getLogger(__name__)

_SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")


class StorageError(Exception):
    """Raised with a message that is safe to show to the user."""


def ensure_dirs() -> None:
    s = get_settings()
    for d in (s.upload_dir, s.converted_dir, s.tmp_dir):
        d.mkdir(parents=True, exist_ok=True)


def _inside(base: Path, *parts: str) -> Path:
    """Join parts under base and refuse anything that escapes it (path traversal)."""
    for part in parts:
        for piece in part.split("/"):
            if not _SAFE_NAME.match(piece):
                raise StorageError("Caminho inválido")
    base = base.resolve()
    path = base.joinpath(*parts).resolve()
    if base != path and base not in path.parents:
        raise StorageError("Caminho inválido")
    return path


def original_key(book_id: uuid.UUID) -> str:
    return f"{book_id}.pdf"


def original_path(file_key: str) -> Path:
    return _inside(get_settings().upload_dir, file_key)


def content_key(book_id: uuid.UUID, version: int) -> str:
    return f"{book_id}/v{version}"


def content_dir(key: str) -> Path:
    return _inside(get_settings().converted_dir, key)


def content_file(key: str, relative: str) -> Path:
    return _inside(get_settings().converted_dir, key, relative)


def book_converted_root(book_id: uuid.UUID) -> Path:
    return _inside(get_settings().converted_dir, str(book_id))


def new_tmp_path(suffix: str = "") -> Path:
    s = get_settings()
    s.tmp_dir.mkdir(parents=True, exist_ok=True)
    return s.tmp_dir / f"{uuid.uuid4().hex}{suffix}"


def dir_size(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def remove_book_files(book_id: uuid.UUID, file_key: str | None) -> None:
    """Delete original + every converted version. Missing files are not an error."""
    if file_key:
        try:
            original_path(file_key).unlink(missing_ok=True)
        except OSError:
            log.exception("could not delete original for book %s", book_id)
    root = book_converted_root(book_id)
    shutil.rmtree(root, ignore_errors=True)


@dataclass
class StorageStatus:
    used_bytes: int
    limit_bytes: int
    disk_free_bytes: int
    disk_total_bytes: int
    warn: bool
    full: bool
    user_used_bytes: int | None = None
    user_limit_bytes: int | None = None


def storage_status(db: Session, user_id: uuid.UUID | None = None) -> StorageStatus:
    from app.models import Book

    s = get_settings()
    used = db.scalar(select(func.coalesce(func.sum(Book.file_size + Book.content_bytes), 0))) or 0
    s.upload_dir.mkdir(parents=True, exist_ok=True)
    disk = shutil.disk_usage(s.upload_dir)
    limit = s.storage_limit_mb * 1024 * 1024
    min_free = s.min_free_disk_mb * 1024 * 1024
    status = StorageStatus(
        used_bytes=int(used),
        limit_bytes=limit,
        disk_free_bytes=disk.free,
        disk_total_bytes=disk.total,
        warn=used >= limit * s.storage_warn_percent / 100 or disk.free < min_free * 2,
        full=used >= limit or disk.free < min_free,
    )
    if user_id is not None:
        status.user_used_bytes = int(
            db.scalar(select(func.coalesce(func.sum(Book.file_size + Book.content_bytes), 0)).where(Book.owner_id == user_id)) or 0
        )
        status.user_limit_bytes = s.user_quota_mb * 1024 * 1024 or None
    return status


def check_space_for(db: Session, user_id: uuid.UUID, incoming_bytes: int) -> None:
    st = storage_status(db, user_id)
    s = get_settings()
    # Converted content is roughly the size of the text plus extracted images; reserve the same again.
    needed = incoming_bytes * 2
    if st.full or st.used_bytes + needed > st.limit_bytes:
        raise StorageError("O armazenamento do servidor atingiu o limite configurado. Exclua livros ou peça ao administrador para ampliar o espaço.")
    if st.disk_free_bytes - needed < s.min_free_disk_mb * 1024 * 1024:
        raise StorageError("Espaço em disco insuficiente no servidor para receber este arquivo.")
    if st.user_limit_bytes and (st.user_used_bytes or 0) + needed > st.user_limit_bytes:
        raise StorageError("Sua cota de armazenamento foi atingida. Exclua livros para liberar espaço.")
