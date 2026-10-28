"""RQ queues. Text conversions and OCR use separate queues so OCR (the heavy one) can be pinned to a
single worker process: OCR never runs for two documents at the same time."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from redis.exceptions import RedisError
from rq import Queue, Retry
from rq.exceptions import InvalidJobOperation, NoSuchJobError
from rq.job import Job, JobStatus
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.redis import get_redis
from app.models import Book, ConversionJob

log = logging.getLogger(__name__)

TEXT_QUEUE = "conversions"
OCR_QUEUE = "ocr"
ACTIVE_JOB_STATUSES = ("queued", "running", "retrying")


class QueueUnavailable(Exception):
    pass


def get_queue(name: str) -> Queue:
    return Queue(name, connection=get_redis())


def enqueue_conversion(db: Session, book: Book, *, ocr: bool) -> ConversionJob:
    settings = get_settings()
    job = ConversionJob(book_id=book.id, kind="ocr" if ocr else "text", max_attempts=settings.job_max_retries + 1)
    db.add(job)
    db.flush()
    job.rq_job_id = str(job.id)
    book.status = "pending"
    book.ocr_requested = ocr
    book.status_message = "Aguardando processamento"
    db.commit()

    retry = Retry(max=settings.job_max_retries, interval=[30, 120, 300][: max(settings.job_max_retries, 1)]) if settings.job_max_retries else None
    try:
        get_queue(OCR_QUEUE if ocr else TEXT_QUEUE).enqueue(
            "app.tasks.run_conversion",
            str(job.id),
            job_id=str(job.id),
            job_timeout=settings.ocr_job_timeout_seconds if ocr else settings.job_timeout_seconds,
            retry=retry,
            result_ttl=3600,
            failure_ttl=7 * 24 * 3600,
            description=f"{job.kind} conversion {book.id}",
        )
    except RedisError as exc:
        job.status = "failed"
        job.error_message = "fila indisponível"
        book.status = "failed"
        book.status_message = "Fila de processamento indisponível. Tente reprocessar em instantes."
        db.commit()
        raise QueueUnavailable from exc
    return job


def latest_job(db: Session, book_id) -> ConversionJob | None:
    return db.scalar(select(ConversionJob).where(ConversionJob.book_id == book_id).order_by(ConversionJob.created_at.desc()).limit(1))


def cancel_jobs(db: Session, book: Book) -> None:
    for job in book.jobs:
        if job.status not in ACTIVE_JOB_STATUSES:
            continue
        job.status = "canceled"
        job.finished_at = datetime.now(timezone.utc)
        if job.rq_job_id:
            try:
                Job.fetch(job.rq_job_id, connection=get_redis()).cancel()
            except (NoSuchJobError, InvalidJobOperation, RedisError):
                pass


def reconcile(db: Session, book: Book) -> None:
    """Detect conversions whose worker died (OOM kill, container restart) and mark them failed,
    so the UI never shows 'processando' forever."""
    if book.status not in ("pending", "processing"):
        return
    job = latest_job(db, book.id)
    if job is None or job.status not in ACTIVE_JOB_STATUSES:
        return
    if job.updated_at and job.updated_at.replace(tzinfo=job.updated_at.tzinfo or timezone.utc) > datetime.now(timezone.utc) - timedelta(minutes=2):
        return
    try:
        rq_status = Job.fetch(job.rq_job_id, connection=get_redis()).get_status() if job.rq_job_id else None
    except NoSuchJobError:
        rq_status = None
    except RedisError:
        return
    if rq_status in (JobStatus.FAILED, JobStatus.STOPPED, JobStatus.CANCELED, None):
        log.warning("conversion job %s lost by the worker (rq status %s)", job.id, rq_status)
        job.status = "failed"
        job.error_message = f"worker lost the job (rq status: {rq_status})"
        job.finished_at = datetime.now(timezone.utc)
        book.status = "failed"
        book.status_message = "A conversão foi interrompida (limite de memória/tempo ou reinício do servidor). Você pode reprocessar o livro."
        db.commit()
