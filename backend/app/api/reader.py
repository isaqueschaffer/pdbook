from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import FileResponse
from sqlalchemy import select

from app.api.deps import DB, CurrentUser, OwnedBook
from app.models import Book, BookChapter, Bookmark, ReadingProgress
from app.schemas.reader import (
    BookmarkIn,
    BookmarkOut,
    BookmarkUpdateIn,
    ChapterContentOut,
    ChapterOut,
    ProgressIn,
    ProgressOut,
    SearchHit,
    SearchOut,
    TocOut,
)
from app.services import content, storage

router = APIRouter(prefix="/books/{book_id}", tags=["reader"])

MAX_SEARCH_HITS = 200


def _require_content(book: Book) -> None:
    if not book.content_key or book.chapter_count == 0:
        raise HTTPException(status.HTTP_409_CONFLICT, "O modo Livro ainda não está disponível para este documento.")


def _chapters(db: DB, book: Book) -> list[BookChapter]:
    return list(
        db.scalars(
            select(BookChapter).where(BookChapter.book_id == book.id, BookChapter.content_version == book.content_version).order_by(BookChapter.index)
        )
    )


@router.get("/chapters", response_model=TocOut)
def toc(book: OwnedBook, db: DB) -> TocOut:
    _require_content(book)
    try:
        sections = {c["index"]: c.get("sections", []) for c in content.manifest(book).get("chapters", [])}
    except content.ContentMissing:
        sections = {}
    chapters = [
        ChapterOut(
            index=c.index,
            title=c.title,
            level=c.level,
            start_page=c.start_page,
            end_page=c.end_page,
            block_count=c.block_count,
            word_count=c.word_count,
            sections=sections.get(c.index, []),
        )
        for c in _chapters(db, book)
    ]
    return TocOut(content_version=book.content_version, total_words=book.word_count, chapters=chapters)


@router.get("/chapters/{index}", response_model=ChapterContentOut)
def chapter_content(index: int, book: OwnedBook, db: DB) -> ChapterContentOut:
    _require_content(book)
    ch = db.scalar(
        select(BookChapter).where(BookChapter.book_id == book.id, BookChapter.content_version == book.content_version, BookChapter.index == index)
    )
    if ch is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Capítulo não encontrado")
    try:
        data = content.chapter(book, ch.content_file)
    except content.ContentMissing:
        raise HTTPException(status.HTTP_410_GONE, "O conteúdo convertido não está disponível. Reprocesse o livro.") from None
    return ChapterContentOut(index=ch.index, title=ch.title, content_version=book.content_version, blocks=data["blocks"])


@router.get("/images/{name}")
def chapter_image(name: str, book: OwnedBook) -> FileResponse:
    if not content.IMAGE_NAME.match(name) or not book.content_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Imagem não encontrada")
    path = storage.content_file(book.content_key, f"images/{name}")
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Imagem não encontrada")
    return FileResponse(
        path,
        media_type="image/png" if name.endswith(".png") else "image/jpeg",
        headers={"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff"},
    )


@router.get("/search", response_model=SearchOut)
def search(book: OwnedBook, db: DB, q: Annotated[str, Query(min_length=2, max_length=100)]) -> SearchOut:
    _require_content(book)
    needle = content.fold(" ".join(q.split()))
    hits: list[SearchHit] = []
    total = 0
    for ch in _chapters(db, book):
        try:
            blocks = content.chapter(book, ch.content_file)["blocks"]
        except content.ContentMissing:
            continue
        for bi, block in enumerate(blocks):
            text = block.get("text") or ""
            hay = content.fold(text)
            start = hay.find(needle)
            while start != -1:
                total += 1
                if len(hits) < MAX_SEARCH_HITS:
                    a, b = max(0, start - 70), min(len(text), start + len(needle) + 70)
                    snippet = ("…" if a else "") + text[a:b] + ("…" if b < len(text) else "")
                    hits.append(
                        SearchHit(
                            chapter_index=ch.index,
                            chapter_title=ch.title,
                            block_index=bi,
                            page=block.get("page", 1),
                            snippet=snippet,
                            match_start=start - a + (1 if a else 0),
                            match_length=len(needle),
                        )
                    )
                start = hay.find(needle, start + len(needle))
    return SearchOut(query=q, total=total, truncated=total > len(hits), hits=hits)


# --- Reading progress ---


@router.get("/progress", response_model=ProgressOut | None)
def get_progress(book: OwnedBook, user: CurrentUser, db: DB) -> ReadingProgress | None:
    return db.scalar(select(ReadingProgress).where(ReadingProgress.user_id == user.id, ReadingProgress.book_id == book.id))


@router.put("/progress", response_model=ProgressOut)
def put_progress(payload: ProgressIn, book: OwnedBook, user: CurrentUser, db: DB) -> ReadingProgress:
    prog = db.scalar(select(ReadingProgress).where(ReadingProgress.user_id == user.id, ReadingProgress.book_id == book.id))
    if prog is None:
        prog = ReadingProgress(user_id=user.id, book_id=book.id)
        db.add(prog)
    data = payload.model_dump()
    data["page"] = min(data["page"], max(book.page_count, 1))
    for k, v in data.items():
        setattr(prog, k, v)
    prog.updated_at = datetime.now(timezone.utc)
    book.last_opened_at = prog.updated_at
    db.commit()
    return prog


# --- Bookmarks, highlights, notes ---


@router.get("/bookmarks", response_model=list[BookmarkOut])
def list_bookmarks(book: OwnedBook, user: CurrentUser, db: DB) -> list[Bookmark]:
    return list(
        db.scalars(
            select(Bookmark)
            .where(Bookmark.user_id == user.id, Bookmark.book_id == book.id)
            .order_by(Bookmark.chapter_index, Bookmark.block_index, Bookmark.start_offset, Bookmark.created_at)
        )
    )


@router.post("/bookmarks", response_model=BookmarkOut, status_code=status.HTTP_201_CREATED)
def create_bookmark(payload: BookmarkIn, book: OwnedBook, user: CurrentUser, db: DB) -> Bookmark:
    if payload.chapter_index >= max(book.chapter_count, 1) and book.chapter_count:
        raise HTTPException(422, "Capítulo inválido")
    bm = Bookmark(user_id=user.id, book_id=book.id, **payload.model_dump())
    if bm.kind == "highlight" and not bm.color:
        bm.color = "yellow"
    db.add(bm)
    db.commit()
    return bm


def _owned_bookmark(db: DB, book: Book, user_id: uuid.UUID, bookmark_id: uuid.UUID) -> Bookmark:
    bm = db.get(Bookmark, bookmark_id)
    if bm is None or bm.user_id != user_id or bm.book_id != book.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Marcador não encontrado")
    return bm


@router.patch("/bookmarks/{bookmark_id}", response_model=BookmarkOut)
def update_bookmark(bookmark_id: uuid.UUID, payload: BookmarkUpdateIn, book: OwnedBook, user: CurrentUser, db: DB) -> Bookmark:
    bm = _owned_bookmark(db, book, user.id, bookmark_id)
    if "note" in payload.model_fields_set:
        bm.note = (payload.note or "").strip() or None
        if bm.kind == "highlight" and bm.note:
            bm.kind = "note"
        elif bm.kind == "note" and not bm.note:
            bm.kind = "highlight" if bm.start_offset is not None else "bookmark"
    if payload.color is not None:
        bm.color = payload.color
    db.commit()
    return bm


@router.delete("/bookmarks/{bookmark_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_bookmark(bookmark_id: uuid.UUID, book: OwnedBook, user: CurrentUser, db: DB) -> None:
    bm = _owned_bookmark(db, book, user.id, bookmark_id)
    db.delete(bm)
    db.commit()
