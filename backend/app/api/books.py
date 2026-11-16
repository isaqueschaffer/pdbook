from __future__ import annotations

import gc
import hashlib
import logging
import os
import re
import shutil
import uuid
from datetime import timezone
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, Response, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import DB, CurrentUser, OwnedBook
from app.converters.pdf import clean_text, read_pdf_info
from app.core import ratelimit
from app.core.config import get_settings
from app.models import Book, ReadingProgress, User
from app.schemas.books import (
    BookOut,
    BookPage,
    BookUpdateIn,
    DashboardOut,
    DeviceBookIn,
    DeviceContentIn,
    JobOut,
    ProgressSummary,
    ReprocessIn,
    SortKey,
    StorageOut,
)
from app.services import queue, storage
from app.services.books import delete_book

log = logging.getLogger(__name__)
router = APIRouter(prefix="/books", tags=["books"])

CHUNK = 1024 * 1024


def _book_out(db: Session, book: Book, user: User, progress: ReadingProgress | None = None, with_job: bool = True) -> BookOut:
    out = BookOut.model_validate(book)
    if progress is None:
        progress = db.scalar(select(ReadingProgress).where(ReadingProgress.user_id == user.id, ReadingProgress.book_id == book.id))
    if progress is not None:
        out.progress = ProgressSummary(percent=progress.percent, chapter_index=progress.chapter_index, updated_at=progress.updated_at)
    if with_job and book.status in ("pending", "processing"):
        job = queue.latest_job(db, book.id)
        if job is not None:
            out.job = JobOut.model_validate(job)
    return out


def _books_out(db: Session, books: list[Book], user: User) -> list[BookOut]:
    ids = [b.id for b in books]
    progress = {p.book_id: p for p in db.scalars(select(ReadingProgress).where(ReadingProgress.user_id == user.id, ReadingProgress.book_id.in_(ids)))} if ids else {}
    out = []
    for b in books:
        queue.reconcile(db, b)
        p = progress.get(b.id)
        out.append(_book_out(db, b, user, p) if p is not None else _book_out_no_progress(db, b))
    return out


def _book_out_no_progress(db: Session, book: Book) -> BookOut:
    out = BookOut.model_validate(book)
    if book.status in ("pending", "processing"):
        job = queue.latest_job(db, book.id)
        if job is not None:
            out.job = JobOut.model_validate(job)
    return out


def _discard(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except PermissionError:
        # Windows only: MuPDF may hold a handle on a file it failed to parse until it is collected.
        gc.collect()
        try:
            path.unlink(missing_ok=True)
        except OSError:
            log.warning("could not remove temporary upload %s", path.name)


def _safe_filename(name: str | None) -> str:
    name = os.path.basename((name or "").replace("\\", "/"))
    name = clean_text(name)[:255]
    return name or "documento.pdf"


def _title_from_filename(name: str) -> str:
    stem = re.sub(r"\.pdf$", "", name, flags=re.I)
    stem = re.sub(r"[_]+", " ", stem)
    return clean_text(stem)[:300] or "Documento sem título"


@router.get("", response_model=BookPage)
def list_books(
    user: CurrentUser,
    db: DB,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=60)] = 24,
    q: Annotated[str | None, Query(max_length=200)] = None,
    status_filter: Annotated[str | None, Query(alias="status", pattern="^(pending|processing|ready|needs_ocr|failed|active)$")] = None,
    sort: SortKey = "recent",
) -> BookPage:
    stmt = select(Book).where(Book.owner_id == user.id)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Book.title.ilike(like), Book.author.ilike(like), Book.original_filename.ilike(like)))
    if status_filter == "active":
        stmt = stmt.where(Book.status.in_(("pending", "processing")))
    elif status_filter:
        stmt = stmt.where(Book.status == status_filter)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    order = {
        "recent": (Book.created_at.desc(),),
        "title": (func.lower(Book.title).asc(),),
        "opened": (Book.last_opened_at.desc().nulls_last(), Book.created_at.desc()),
    }[sort]
    books = db.scalars(stmt.order_by(*order).offset((page - 1) * page_size).limit(page_size)).all()
    return BookPage(items=_books_out(db, list(books), user), total=total, page=page, page_size=page_size)


@router.post("", response_model=BookOut, status_code=status.HTTP_201_CREATED)
def upload_book(
    request: Request,
    user: CurrentUser,
    db: DB,
    file: Annotated[UploadFile, File()],
    ocr: Annotated[bool, Form()] = False,
    title: Annotated[str | None, Form(max_length=300)] = None,
) -> BookOut:
    s = get_settings()
    ratelimit.enforce("upload", str(user.id), s.upload_rate_limit, s.upload_rate_window)
    if ocr and not s.ocr_enabled:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "O OCR está desativado neste servidor.")
    filename = _safe_filename(file.filename)

    tmp = storage.new_tmp_path(".pdf")
    sha = hashlib.sha256()
    size = 0
    try:
        with tmp.open("wb") as out:
            first = True
            while chunk := file.file.read(CHUNK):
                if first:
                    if not chunk.lstrip(b"\x00\t\r\n ")[:5] == b"%PDF-":
                        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "O arquivo enviado não é um PDF válido.")
                    first = False
                size += len(chunk)
                if size > s.max_upload_bytes:
                    raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, f"O arquivo excede o limite de {s.max_upload_mb} MB.")
                sha.update(chunk)
                out.write(chunk)
        if size == 0:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "O arquivo está vazio.")

        try:
            pages, meta_title, meta_author, encrypted = read_pdf_info(tmp)
        except Exception:  # noqa: BLE001 - any parser failure means an unusable file
            raise HTTPException(422, "Não foi possível ler o PDF. O arquivo pode estar corrompido.") from None
        if encrypted:
            raise HTTPException(422, "PDFs protegidos por senha não são suportados.")
        if pages == 0:
            raise HTTPException(422, "O PDF não possui páginas.")
        if pages > s.max_pdf_pages:
            raise HTTPException(422, f"O PDF tem {pages} páginas; o limite é {s.max_pdf_pages}.")

        digest = sha.hexdigest()
        existing = db.scalar(select(Book.id).where(Book.owner_id == user.id, Book.sha256 == digest))
        if existing:
            raise HTTPException(status.HTTP_409_CONFLICT, {"message": "Você já importou este documento.", "book_id": str(existing)})

        try:
            storage.check_space_for(db, user.id, size)
        except storage.StorageError as exc:
            raise HTTPException(status.HTTP_507_INSUFFICIENT_STORAGE, str(exc)) from None

        book_id = uuid.uuid4()
        key = storage.original_key(book_id)
        dest = storage.original_path(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.replace(tmp, dest)
        except OSError:
            shutil.move(str(tmp), dest)

        book = Book(
            id=book_id,
            owner_id=user.id,
            title=(clean_text(title or "")[:300] or meta_title or _title_from_filename(filename))[:300],
            author=meta_author[:300] if meta_author else None,
            original_filename=filename,
            file_key=key,
            file_size=size,
            sha256=digest,
            page_count=pages,
            status="pending",
        )
        db.add(book)
        try:
            db.commit()
        except Exception:
            db.rollback()
            dest.unlink(missing_ok=True)
            raise
    finally:
        file.file.close()
        _discard(tmp)

    try:
        queue.enqueue_conversion(db, book, ocr=ocr)
    except queue.QueueUnavailable:
        log.error("queue unavailable while enqueuing book %s", book.id)
    log.info("book %s uploaded (%s pages, %s bytes)", book.id, pages, size)
    return _book_out(db, book, user)


def _apply_device_content(book: Book, content: DeviceContentIn) -> None:
    book.status = content.status
    book.status_message = clean_text(content.status_message or "")[:500] or None
    book.content_version = content.content_version
    book.chapter_count = content.chapter_count
    book.word_count = content.word_count
    book.ocr_requested = content.ocr_requested
    book.ocr_used = content.ocr_used
    book.warnings = [clean_text(w)[:500] for w in content.warnings if clean_text(w)]


@router.post("/device", response_model=BookOut, status_code=status.HTTP_201_CREATED)
def register_device_book(payload: DeviceBookIn, response: Response, user: CurrentUser, db: DB) -> BookOut:
    """Register a book whose PDF stays on the device (app). Idempotent: the same file (SHA-256)
    already in the account returns the existing book, so a second device that imports the same PDF
    joins its progress and annotations instead of creating a duplicate."""
    s = get_settings()
    ratelimit.enforce("upload", str(user.id), s.upload_rate_limit, s.upload_rate_window)
    existing = db.scalar(select(Book).where(Book.owner_id == user.id, Book.sha256 == payload.sha256))
    if existing is not None:
        response.status_code = status.HTTP_200_OK
        return _book_out(db, existing, user)
    if payload.id is not None and db.get(Book, payload.id) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Identificador de livro já utilizado.")
    filename = _safe_filename(payload.original_filename)
    book = Book(
        id=payload.id or uuid.uuid4(),
        owner_id=user.id,
        title=clean_text(payload.title)[:300] or _title_from_filename(filename),
        author=clean_text(payload.author or "")[:300] or None,
        original_filename=filename,
        file_key="",
        file_size=payload.file_size,
        sha256=payload.sha256,
        storage_mode="device",
        page_count=payload.page_count,
    )
    _apply_device_content(book, payload.content)
    db.add(book)
    db.commit()
    log.info("device book %s registered (%s pages)", book.id, book.page_count)
    return _book_out(db, book, user)


@router.get("/dashboard", response_model=DashboardOut)
def dashboard(user: CurrentUser, db: DB) -> DashboardOut:
    counts = dict(db.execute(select(Book.status, func.count()).where(Book.owner_id == user.id).group_by(Book.status)).all())
    recent_progress = db.scalars(
        select(ReadingProgress).where(ReadingProgress.user_id == user.id, ReadingProgress.percent < 99.5).order_by(ReadingProgress.updated_at.desc()).limit(4)
    ).all()
    cont = []
    for p in recent_progress:
        b = db.get(Book, p.book_id)
        if b is not None and b.owner_id == user.id:
            cont.append(_book_out(db, b, user, p))
    recent = db.scalars(select(Book).where(Book.owner_id == user.id).order_by(Book.created_at.desc()).limit(6)).all()
    words_read = 0
    for p in db.scalars(select(ReadingProgress).where(ReadingProgress.user_id == user.id)).all():
        b = db.get(Book, p.book_id)
        if b:
            words_read += int(b.word_count * p.percent / 100)
    st = storage.storage_status(db, user.id)
    return DashboardOut(
        total_books=sum(counts.values()),
        ready_books=counts.get("ready", 0),
        processing_books=counts.get("pending", 0) + counts.get("processing", 0),
        words_read_estimate=words_read,
        continue_reading=cont,
        recent=_books_out(db, list(recent), user),
        storage=StorageOut(**{k: getattr(st, k) for k in StorageOut.model_fields}),
    )


@router.get("/{book_id}", response_model=BookOut)
def get_book(book: OwnedBook, user: CurrentUser, db: DB) -> BookOut:
    queue.reconcile(db, book)
    return _book_out(db, book, user)


@router.patch("/{book_id}", response_model=BookOut)
def update_book(payload: BookUpdateIn, book: OwnedBook, user: CurrentUser, db: DB) -> BookOut:
    if payload.title is not None:
        title = clean_text(payload.title)
        if not title:
            raise HTTPException(422, "O título não pode ficar vazio.")
        book.title = title
    if "author" in payload.model_fields_set:
        book.author = clean_text(payload.author or "") or None
    db.commit()
    return _book_out(db, book, user)


@router.put("/{book_id}/device-content", response_model=BookOut)
def update_device_content(payload: DeviceContentIn, book: OwnedBook, user: CurrentUser, db: DB) -> BookOut:
    if book.storage_mode != "device":
        raise HTTPException(status.HTTP_409_CONFLICT, "Este livro é convertido pelo servidor.")
    _apply_device_content(book, payload)
    db.commit()
    return _book_out(db, book, user)


@router.delete("/{book_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_book(book: OwnedBook, db: DB) -> None:
    delete_book(db, book)


@router.post("/{book_id}/reprocess", response_model=BookOut)
def reprocess(payload: ReprocessIn, book: OwnedBook, user: CurrentUser, db: DB) -> BookOut:
    s = get_settings()
    if book.storage_mode == "device":
        raise HTTPException(status.HTTP_409_CONFLICT, "Este livro é convertido no aparelho onde foi importado. Reprocesse-o pelo app.")
    if payload.ocr and not s.ocr_enabled:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "O OCR está desativado neste servidor.")
    active = queue.latest_job(db, book.id)
    if active is not None and active.status in queue.ACTIVE_JOB_STATUSES:
        raise HTTPException(status.HTTP_409_CONFLICT, "Este livro já está sendo processado.")
    try:
        queue.enqueue_conversion(db, book, ocr=payload.ocr)
    except queue.QueueUnavailable:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Fila de processamento indisponível. Tente novamente em instantes.") from None
    return _book_out(db, book, user)


@router.get("/{book_id}/file")
def book_file(book: OwnedBook) -> FileResponse:
    if book.storage_mode == "device":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "O PDF deste livro fica guardado no aparelho onde foi importado.")
    path = storage.original_path(book.file_key)
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Arquivo original não encontrado.")
    modified = book.updated_at.replace(tzinfo=book.updated_at.tzinfo or timezone.utc)
    return FileResponse(
        path,
        media_type="application/pdf",
        headers={
            "Cache-Control": "private, max-age=3600",
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff",
            "Last-Modified": modified.strftime("%a, %d %b %Y %H:%M:%S GMT"),
        },
    )
