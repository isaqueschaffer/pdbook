from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from app.models import Book
from app.services import queue, storage

log = logging.getLogger(__name__)


def delete_book(db: Session, book: Book) -> None:
    """Deletion policy: hard delete. Pending jobs are canceled, the database rows (chapters, jobs,
    progress, bookmarks) cascade, then the original PDF and every converted version are removed.
    Files are removed after the commit so a failed transaction never leaves a row without its file;
    leftovers from a crash are swept by `python -m app.cli cleanup-orphans`."""
    book_id, file_key = book.id, book.file_key
    queue.cancel_jobs(db, book)
    db.delete(book)
    db.commit()
    storage.remove_book_files(book_id, file_key)
    log.info("book %s deleted", book_id)
