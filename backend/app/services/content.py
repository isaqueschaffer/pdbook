"""Read access to converted content on disk."""

from __future__ import annotations

import json
import re
import unicodedata

from app.models import Book
from app.services import storage

IMAGE_NAME = re.compile(r"^img-\d{4}\.(png|jpg)$")


class ContentMissing(Exception):
    pass


def _read_json(book: Book, relative: str) -> dict:
    if not book.content_key:
        raise ContentMissing
    try:
        return json.loads(storage.content_file(book.content_key, relative).read_text(encoding="utf-8"))
    except (OSError, ValueError, storage.StorageError) as exc:
        raise ContentMissing from exc


def manifest(book: Book) -> dict:
    return _read_json(book, "manifest.json")


def chapter(book: Book, file: str) -> dict:
    return _read_json(book, file)


def fold(text: str) -> str:
    """Lower-case and strip accents while keeping a 1:1 character mapping (offsets stay valid)."""
    out = []
    for c in text:
        base = unicodedata.normalize("NFD", c)[0].lower()
        out.append(base[0] if base else c)
    return "".join(out)
