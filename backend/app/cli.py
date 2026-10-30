"""Maintenance commands.

    python -m app.cli check-config      validate environment variables and print the effective limits
    python -m app.cli cleanup-orphans   remove files that no longer belong to any book (add --dry-run to preview)
    python -m app.cli storage           print storage usage
    python -m app.cli verify-files      report books whose original PDF is missing (e.g. after a restore)
    python -m app.cli reprocess-missing queue books whose converted content is missing (after a restore)
"""

from __future__ import annotations

import argparse
import shutil
import sys
import time
import uuid

from sqlalchemy import select

from app.core.config import get_settings
from app.db.session import get_sessionmaker
from app.models import Book
from app.services import storage


def check_config() -> int:
    s = get_settings()
    print("Configuração válida.")
    print(f"  ambiente: {s.environment}")
    print(f"  upload: até {s.max_upload_mb} MB / {s.max_pdf_pages} páginas")
    print(f"  armazenamento: limite {s.storage_limit_mb} MB, mínimo livre {s.min_free_disk_mb} MB")
    print(f"  worker: {s.worker_concurrency} processo(s), timeout {s.job_timeout_seconds}s, memória {s.worker_memory_limit_mb} MB, tentativas {s.job_max_retries + 1}")
    print(f"  OCR: {'ativado' if s.ocr_enabled else 'desativado'} ({s.ocr_languages}, {s.ocr_dpi} dpi)")
    print(f"  pool Neon: {s.db_pool_size}+{s.db_max_overflow} conexões")
    return 0


def cleanup_orphans(dry_run: bool) -> int:
    s = get_settings()
    db = get_sessionmaker()()
    try:
        books = {b.id: b for b in db.scalars(select(Book)).all()}
    finally:
        db.close()
    removed = 0
    for path in s.upload_dir.glob("*.pdf"):
        try:
            book_id = uuid.UUID(path.stem)
        except ValueError:
            continue
        if book_id not in books:
            print(f"órfão: {path}")
            removed += 1
            if not dry_run:
                path.unlink(missing_ok=True)
    for path in s.converted_dir.iterdir() if s.converted_dir.exists() else []:
        try:
            book_id = uuid.UUID(path.name)
        except ValueError:
            continue
        book = books.get(book_id)
        current = book.content_key.split("/")[1] if book and book.content_key else None
        targets = [path] if book is None else [v for v in path.iterdir() if v.name != current and not v.name.endswith(".partial")]
        for t in targets:
            print(f"órfão: {t}")
            removed += 1
            if not dry_run:
                shutil.rmtree(t, ignore_errors=True)
    day_ago = time.time() - 86400  # never touch uploads that may still be in flight
    for path in s.tmp_dir.iterdir() if s.tmp_dir.exists() else []:
        if path.stat().st_mtime > day_ago:
            continue
        print(f"temporário antigo: {path}")
        if not dry_run:
            shutil.rmtree(path, ignore_errors=True) if path.is_dir() else path.unlink(missing_ok=True)
    print(f"{removed} item(ns) órfão(s){' (simulação)' if dry_run else ' removido(s)'}.")
    return 0


def show_storage() -> int:
    db = get_sessionmaker()()
    try:
        st = storage.storage_status(db)
    finally:
        db.close()
    mb = 1024 * 1024
    print(f"usado pelo PDBook: {st.used_bytes / mb:.1f} MB de {st.limit_bytes / mb:.0f} MB")
    print(f"disco livre: {st.disk_free_bytes / mb:.0f} MB de {st.disk_total_bytes / mb:.0f} MB")
    print("ALERTA: armazenamento próximo do limite" if st.warn else "ok")
    return 1 if st.full else 0


def verify_files() -> int:
    db = get_sessionmaker()()
    missing = 0
    try:
        for b in db.scalars(select(Book)).all():
            if not storage.original_path(b.file_key).is_file():
                print(f"faltando original: livro {b.id}")
                missing += 1
            if b.content_key and not storage.content_file(b.content_key, "manifest.json").is_file():
                print(f"faltando conteúdo convertido: livro {b.id} (reprocessável)")
    finally:
        db.close()
    print(f"{missing} original(is) ausente(s).")
    return 1 if missing else 0


def reprocess_missing() -> int:
    """After restoring a backup without converted content: queue every book whose content is gone."""
    from app.services.queue import QueueUnavailable, enqueue_conversion

    db = get_sessionmaker()()
    queued = 0
    try:
        for b in db.scalars(select(Book)).all():
            has_original = storage.original_path(b.file_key).is_file()
            has_content = bool(b.content_key) and storage.content_file(b.content_key, "manifest.json").is_file()
            if has_original and not has_content and b.status not in ("pending", "processing"):
                try:
                    enqueue_conversion(db, b, ocr=b.ocr_used)
                    queued += 1
                except QueueUnavailable:
                    print("fila indisponível; tente novamente")
                    return 1
    finally:
        db.close()
    print(f"{queued} livro(s) enviados para reprocessamento.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check-config")
    c = sub.add_parser("cleanup-orphans")
    c.add_argument("--dry-run", action="store_true")
    sub.add_parser("storage")
    sub.add_parser("verify-files")
    sub.add_parser("reprocess-missing")
    args = parser.parse_args()
    if args.cmd == "reprocess-missing":
        return reprocess_missing()
    if args.cmd == "check-config":
        return check_config()
    if args.cmd == "cleanup-orphans":
        return cleanup_orphans(args.dry_run)
    if args.cmd == "storage":
        return show_storage()
    return verify_files()


if __name__ == "__main__":
    sys.exit(main())
