"""Background jobs executed by the RQ worker (see worker.py)."""

from __future__ import annotations

import logging
import os
import shutil
import uuid
from datetime import datetime, timezone

from rq.timeouts import JobTimeoutException
from sqlalchemy import delete

from app.converters.ocr import OcrUnavailable
from app.converters.pdf import ConversionError, ConversionOptions, convert_pdf
from app.core.config import get_settings
from app.db.session import get_sessionmaker
from app.models import Book, BookChapter, ConversionJob
from app.services import storage

log = logging.getLogger(__name__)


def _apply_memory_limit() -> None:
    """Cap the address space of the forked RQ work-horse so a pathological PDF raises MemoryError
    instead of pushing the whole VM into swap. Only applied inside the forked horse."""
    limit_mb = get_settings().worker_memory_limit_mb
    if not limit_mb or os.environ.get("BOOKFLOW_FORKING_WORKER") != "1":
        return
    try:
        import resource

        limit = limit_mb * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    except (ImportError, ValueError, OSError):
        log.warning("could not apply memory limit to conversion job")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def run_conversion(job_id: str) -> str:
    settings = get_settings()
    db = get_sessionmaker()()
    try:
        job = db.get(ConversionJob, uuid.UUID(job_id))
        if job is None or job.status == "canceled":
            return "skipped"
        book = db.get(Book, job.book_id)
        if book is None:
            return "skipped"

        _apply_memory_limit()
        job.attempts += 1
        job.status = "running"
        job.progress = 0
        job.started_at = _now()
        book.status = "processing"
        book.status_message = "Reconhecendo texto (OCR)…" if job.kind == "ocr" else "Extraindo texto…"
        db.commit()

        version = book.content_version + 1
        key = storage.content_key(book.id, version)
        final_dir = storage.content_dir(key)
        work_dir = final_dir.with_name(final_dir.name + ".partial")
        shutil.rmtree(work_dir, ignore_errors=True)
        shutil.rmtree(final_dir, ignore_errors=True)

        last = {"pct": 0}

        def progress(pct: int) -> None:
            if pct - last["pct"] >= 10 or pct == 100:
                last["pct"] = pct
                job.progress = pct
                db.commit()

        opts = ConversionOptions(
            max_pages=settings.max_pdf_pages,
            ocr=job.kind == "ocr",
            ocr_languages=settings.ocr_languages,
            ocr_dpi=settings.ocr_dpi,
            ocr_page_timeout=settings.ocr_page_timeout,
            ocr_min_chars_per_page=settings.ocr_min_chars_per_page,
            max_images=settings.max_images_per_book,
            min_image_px=settings.min_image_px,
        )
        try:
            result = convert_pdf(storage.original_path(book.file_key), work_dir, opts, progress)
        except (ConversionError, OcrUnavailable) as exc:
            shutil.rmtree(work_dir, ignore_errors=True)
            _fail(db, job, book, str(exc), str(exc))
            return "failed"
        except (JobTimeoutException, MemoryError) as exc:
            shutil.rmtree(work_dir, ignore_errors=True)
            what = "tempo" if isinstance(exc, JobTimeoutException) else "memória"
            _fail(db, job, book, f"A conversão excedeu o limite de {what} configurado para o servidor.", type(exc).__name__)
            return "failed"
        except Exception as exc:
            shutil.rmtree(work_dir, ignore_errors=True)
            log.exception("conversion %s failed (attempt %s/%s)", job.id, job.attempts, job.max_attempts)
            db.rollback()
            if job.attempts < job.max_attempts:
                job.status = "retrying"
                job.error_message = type(exc).__name__
                book.status = "pending"
                book.status_message = "Falha temporária; uma nova tentativa foi agendada."
                db.commit()
                raise  # RQ schedules the retry
            _fail(db, job, book, "Erro inesperado ao converter o documento.", f"{type(exc).__name__}: {exc}"[:2000])
            return "failed"

        # The book may have been deleted while we were converting.
        db.expire_all()
        book = db.get(Book, job.book_id)
        if book is None:
            shutil.rmtree(work_dir, ignore_errors=True)
            return "skipped"

        os.replace(work_dir, final_dir)
        old_key = book.content_key
        db.execute(delete(BookChapter).where(BookChapter.book_id == book.id))
        for ch in result.chapters:
            db.add(
                BookChapter(
                    book_id=book.id,
                    content_version=version,
                    index=ch.index,
                    title=ch.title,
                    level=ch.level,
                    start_page=ch.start_page,
                    end_page=ch.end_page,
                    block_count=ch.block_count,
                    word_count=ch.word_count,
                    content_file=ch.file,
                )
            )
        book.content_key = key
        book.content_version = version
        book.chapter_count = len(result.chapters)
        book.word_count = result.word_count
        book.warnings = result.warnings
        book.ocr_used = result.ocr_used
        book.content_bytes = storage.dir_size(final_dir)
        if result.needs_ocr:
            book.status = "needs_ocr"
            book.status_message = "O documento parece digitalizado e tem pouco texto extraível. Use o modo PDF ou processe com OCR."
        elif not result.chapters:
            book.status = "needs_ocr" if settings.ocr_enabled else "failed"
            book.status_message = "Nenhum texto foi encontrado no documento."
        else:
            book.status = "ready"
            book.status_message = None
        job.status = "succeeded"
        job.progress = 100
        job.finished_at = _now()
        job.error_message = None
        db.commit()

        if old_key and old_key != key:
            shutil.rmtree(storage.content_dir(old_key), ignore_errors=True)
        log.info("book %s converted: v%s, %s chapters, %s words", book.id, version, len(result.chapters), result.word_count)
        return "ok"
    finally:
        db.close()


def _fail(db, job: ConversionJob, book: Book, user_message: str, detail: str) -> None:
    db.rollback()
    job.status = "failed"
    job.error_message = detail[:2000]
    job.finished_at = _now()
    # A previous successful version stays readable; only flag the book as failed if there is none.
    book.status = "failed" if not book.content_key else ("needs_ocr" if book.chapter_count == 0 else "ready")
    book.status_message = user_message[:500]
    db.commit()
    log.warning("conversion %s failed: %s", job.id, detail[:200])
