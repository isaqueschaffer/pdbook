from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class SectionOut(BaseModel):
    block: int
    title: str
    level: int


class ChapterOut(BaseModel):
    index: int
    title: str
    level: int
    start_page: int
    end_page: int
    block_count: int
    word_count: int
    sections: list[SectionOut] = []


class TocOut(BaseModel):
    content_version: int
    total_words: int
    chapters: list[ChapterOut]


class BlockOut(BaseModel):
    type: Literal["heading", "paragraph", "list_item", "image"]
    page: int
    text: str | None = None
    level: int | None = None
    image: str | None = None
    width: int | None = None
    height: int | None = None


class ChapterContentOut(BaseModel):
    index: int
    title: str
    content_version: int
    blocks: list[BlockOut]


class SearchHit(BaseModel):
    chapter_index: int
    chapter_title: str
    block_index: int
    page: int
    snippet: str
    match_start: int
    match_length: int


class SearchOut(BaseModel):
    query: str
    total: int
    truncated: bool
    hits: list[SearchHit]


class ProgressIn(BaseModel):
    content_version: int = Field(ge=0)
    chapter_index: int = Field(ge=0)
    block_index: int = Field(ge=0)
    block_offset: float = Field(ge=0, le=1)
    page: int = Field(ge=1)
    percent: float = Field(ge=0, le=100)
    mode: Literal["book", "pdf"] = "book"


class ProgressOut(ProgressIn):
    model_config = ConfigDict(from_attributes=True)

    updated_at: datetime


Color = Literal["yellow", "green", "blue", "pink"]


class BookmarkIn(BaseModel):
    kind: Literal["bookmark", "highlight", "note"]
    content_version: int = Field(ge=1)
    chapter_index: int = Field(ge=0)
    block_index: int = Field(ge=0)
    start_offset: int | None = Field(default=None, ge=0)
    end_block_index: int | None = Field(default=None, ge=0)
    end_offset: int | None = Field(default=None, ge=0)
    page: int | None = Field(default=None, ge=1)
    quote: str | None = Field(default=None, max_length=5000)
    note: str | None = Field(default=None, max_length=10_000)
    color: Color | None = None

    @model_validator(mode="after")
    def _check(self) -> "BookmarkIn":
        if self.kind in ("highlight", "note") and self.start_offset is not None:
            end_block = self.end_block_index if self.end_block_index is not None else self.block_index
            if end_block < self.block_index:
                raise ValueError("Trecho inválido")
            if end_block == self.block_index and (self.end_offset is None or self.end_offset <= self.start_offset):
                raise ValueError("Trecho inválido")
        if self.kind == "note" and not (self.note or "").strip():
            raise ValueError("A anotação não pode ficar vazia")
        if self.kind == "highlight" and self.start_offset is None:
            raise ValueError("Selecione um trecho para destacar")
        return self


class BookmarkUpdateIn(BaseModel):
    note: str | None = Field(default=None, max_length=10_000)
    color: Color | None = None


class BookmarkOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    kind: str
    content_version: int
    chapter_index: int
    block_index: int
    start_offset: int | None
    end_block_index: int | None
    end_offset: int | None
    page: int | None
    quote: str | None
    note: str | None
    color: str | None
    created_at: datetime
    updated_at: datetime


class PreferencesIn(BaseModel):
    font_family: Literal["serif", "sans"]
    font_size: int = Field(ge=12, le=40)
    line_height: float = Field(ge=1.0, le=2.6)
    paragraph_spacing: float = Field(ge=0, le=3)
    margin: int = Field(ge=0, le=120)
    max_width: int = Field(ge=420, le=1200)
    theme: Literal["light", "dark", "sepia"]
    justify: bool = False


class PreferencesOut(PreferencesIn):
    model_config = ConfigDict(from_attributes=True)
