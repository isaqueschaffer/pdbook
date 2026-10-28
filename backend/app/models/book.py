from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, utcnow

# pending: aguardando na fila · processing: convertendo · ready: modo Livro disponível
# needs_ocr: pouco texto extraível (OCR opcional) · failed: conversão falhou (PDF original continua disponível)
BOOK_STATUSES = ("pending", "processing", "ready", "needs_ocr", "failed")
JOB_KINDS = ("text", "ocr")
JOB_STATUSES = ("queued", "running", "retrying", "succeeded", "failed", "canceled")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


class Book(TimestampMixin, Base):
    __tablename__ = "books"
    __table_args__ = (
        CheckConstraint(_in("status", BOOK_STATUSES), name="status"),
        CheckConstraint("page_count >= 0", name="page_count"),
        Index("ix_books_owner_created", "owner_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    author: Mapped[str | None] = mapped_column(String(300))
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    # Internal storage keys, relative to UPLOAD_DIR / CONVERTED_DIR. Never returned by the API.
    file_key: Mapped[str] = mapped_column(String(100), nullable=False)
    content_key: Mapped[str | None] = mapped_column(String(120))
    file_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    content_bytes: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    page_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    status_message: Mapped[str | None] = mapped_column(String(500))
    ocr_requested: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    ocr_used: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    content_version: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    chapter_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    word_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    warnings: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    last_opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    chapters: Mapped[list[BookChapter]] = relationship(
        back_populates="book", cascade="all, delete-orphan", passive_deletes=True, order_by="BookChapter.index"
    )
    jobs: Mapped[list[ConversionJob]] = relationship(back_populates="book", cascade="all, delete-orphan", passive_deletes=True)


class ConversionJob(Base):
    __tablename__ = "conversion_jobs"
    __table_args__ = (
        CheckConstraint(_in("kind", JOB_KINDS), name="kind"),
        CheckConstraint(_in("status", JOB_STATUSES), name="status"),
        Index("ix_conversion_jobs_book_created", "book_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    book_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("books.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(String(10), default="text", nullable=False)
    status: Mapped[str] = mapped_column(String(12), default="queued", nullable=False)
    rq_job_id: Mapped[str | None] = mapped_column(String(64), unique=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    max_attempts: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    progress: Mapped[int] = mapped_column(Integer, default=0, nullable=False)  # 0-100
    error_message: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    book: Mapped[Book] = relationship(back_populates="jobs")


class BookChapter(Base):
    __tablename__ = "book_chapters"
    __table_args__ = (UniqueConstraint("book_id", "content_version", "index", name="uq_book_chapters_position"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    book_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("books.id", ondelete="CASCADE"), index=True, nullable=False)
    content_version: Mapped[int] = mapped_column(Integer, nullable=False)
    index: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    level: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    start_page: Mapped[int] = mapped_column(Integer, nullable=False)
    end_page: Mapped[int] = mapped_column(Integer, nullable=False)
    block_count: Mapped[int] = mapped_column(Integer, nullable=False)
    word_count: Mapped[int] = mapped_column(Integer, nullable=False)
    # File name inside the content version directory, e.g. "chapters/0003.json".
    content_file: Mapped[str] = mapped_column(String(60), nullable=False)

    book: Mapped[Book] = relationship(back_populates="chapters")
