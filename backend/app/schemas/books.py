from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ProgressSummary(BaseModel):
    percent: float
    chapter_index: int
    updated_at: datetime


class JobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    kind: str
    status: str
    progress: int
    attempts: int
    max_attempts: int
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class BookOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    author: str | None
    original_filename: str
    file_size: int
    page_count: int
    status: str
    status_message: str | None
    ocr_requested: bool
    ocr_used: bool
    content_version: int
    chapter_count: int
    word_count: int
    warnings: list[str]
    created_at: datetime
    updated_at: datetime
    last_opened_at: datetime | None
    progress: ProgressSummary | None = None
    job: JobOut | None = None


class BookPage(BaseModel):
    items: list[BookOut]
    total: int
    page: int
    page_size: int


class BookUpdateIn(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    author: str | None = Field(default=None, max_length=300)


class ReprocessIn(BaseModel):
    ocr: bool = False


class StorageOut(BaseModel):
    used_bytes: int
    limit_bytes: int
    disk_free_bytes: int
    warn: bool
    full: bool
    user_used_bytes: int | None
    user_limit_bytes: int | None


class DashboardOut(BaseModel):
    total_books: int
    ready_books: int
    processing_books: int
    words_read_estimate: int
    continue_reading: list[BookOut]
    recent: list[BookOut]
    storage: StorageOut


class PublicConfig(BaseModel):
    max_upload_mb: int
    max_pdf_pages: int
    ocr_enabled: bool


SortKey = Literal["recent", "title", "opened"]
