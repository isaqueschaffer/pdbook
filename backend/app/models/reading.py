from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, utcnow

BOOKMARK_KINDS = ("bookmark", "highlight", "note")
HIGHLIGHT_COLORS = ("yellow", "green", "blue", "pink")
THEMES = ("light", "dark", "sepia")
FONT_FAMILIES = ("serif", "sans")


class ReadingProgress(Base):
    """Last reading position. Positions are (chapter index, block index, offset inside the block)
    for a given content version; the PDF page is kept too so a position survives a reconversion."""

    __tablename__ = "reading_progress"
    __table_args__ = (
        UniqueConstraint("user_id", "book_id", name="uq_reading_progress_user_book"),
        CheckConstraint("block_offset >= 0 AND block_offset <= 1", name="offset_range"),
        CheckConstraint("percent >= 0 AND percent <= 100", name="percent_range"),
        Index("ix_reading_progress_user_updated", "user_id", "updated_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    book_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("books.id", ondelete="CASCADE"), index=True, nullable=False)
    content_version: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    chapter_index: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    block_index: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    block_offset: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    page: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    percent: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    mode: Mapped[str] = mapped_column(String(8), default="book", nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)


class Bookmark(TimestampMixin, Base):
    """Bookmarks, highlights and notes. A highlight spans from (block_index, start_offset)
    to (end_block_index, end_offset), offsets being character positions in the block text."""

    __tablename__ = "bookmarks"
    __table_args__ = (
        CheckConstraint("kind IN ('bookmark', 'highlight', 'note')", name="kind"),
        CheckConstraint("color IS NULL OR color IN ('yellow', 'green', 'blue', 'pink')", name="color"),
        Index("ix_bookmarks_user_book", "user_id", "book_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    book_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("books.id", ondelete="CASCADE"), index=True, nullable=False)
    kind: Mapped[str] = mapped_column(String(10), nullable=False)
    content_version: Mapped[int] = mapped_column(Integer, nullable=False)
    chapter_index: Mapped[int] = mapped_column(Integer, nullable=False)
    block_index: Mapped[int] = mapped_column(Integer, nullable=False)
    start_offset: Mapped[int | None] = mapped_column(Integer)
    end_block_index: Mapped[int | None] = mapped_column(Integer)
    end_offset: Mapped[int | None] = mapped_column(Integer)
    page: Mapped[int | None] = mapped_column(Integer)
    quote: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)
    color: Mapped[str | None] = mapped_column(String(10))


class ReaderPreferences(Base):
    __tablename__ = "reader_preferences"
    __table_args__ = (
        CheckConstraint("theme IN ('light', 'dark', 'sepia')", name="theme"),
        CheckConstraint("font_family IN ('serif', 'sans')", name="font_family"),
        CheckConstraint("font_size BETWEEN 12 AND 40", name="font_size"),
        CheckConstraint("line_height BETWEEN 1.0 AND 2.6", name="line_height"),
        CheckConstraint("paragraph_spacing BETWEEN 0 AND 3", name="paragraph_spacing"),
        CheckConstraint("margin BETWEEN 0 AND 120", name="margin"),
        CheckConstraint("max_width BETWEEN 420 AND 1200", name="max_width"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    font_family: Mapped[str] = mapped_column(String(10), default="serif", nullable=False)
    font_size: Mapped[int] = mapped_column(Integer, default=19, nullable=False)
    line_height: Mapped[float] = mapped_column(Float, default=1.7, nullable=False)
    paragraph_spacing: Mapped[float] = mapped_column(Float, default=1.0, nullable=False)
    margin: Mapped[int] = mapped_column(Integer, default=32, nullable=False)
    max_width: Mapped[int] = mapped_column(Integer, default=680, nullable=False)
    theme: Mapped[str] = mapped_column(String(10), default="light", nullable=False)
    justify: Mapped[bool] = mapped_column(default=False, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    DEFAULTS = {
        "font_family": "serif",
        "font_size": 19,
        "line_height": 1.7,
        "paragraph_spacing": 1.0,
        "margin": 32,
        "max_width": 680,
        "theme": "light",
        "justify": False,
    }
