from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import app
from tests.conftest import CSRF, register, run_worker
from tests.pdf_factory import make_many_pages_pdf, make_scanned_pdf, make_text_pdf


def upload(client, path: Path, **data):
    with path.open("rb") as fh:
        return client.post("/api/books", files={"file": (path.name, fh, "application/pdf")}, data=data)


@pytest.fixture
def ready_book(client, user, tmp_path) -> dict:
    r = upload(client, make_text_pdf(tmp_path / "livro.pdf"))
    assert r.status_code == 201, r.text
    run_worker()
    book = client.get(f"/api/books/{r.json()['id']}").json()
    assert book["status"] == "ready", book
    return book


def test_upload_creates_pending_book_and_stores_original(client, user, tmp_path):
    r = upload(client, make_text_pdf(tmp_path / "meu_livro.pdf"))
    assert r.status_code == 201
    book = r.json()
    assert book["status"] == "pending"
    assert book["title"] == "Livro de Teste"  # from PDF metadata
    assert book["author"] == "Equipe BookFlow"
    assert book["page_count"] >= 3
    assert book["job"]["status"] == "queued"
    for leaked in ("file_key", "content_key", "sha256"):
        assert leaked not in book
    stored = list(get_settings().upload_dir.glob("*.pdf"))
    assert [p.stem for p in stored] == [book["id"]]  # stored under a generated name, not the user's


def test_upload_rejects_non_pdf_and_corrupt_and_oversized(client, user, tmp_path):
    fake = tmp_path / "virus.pdf"
    fake.write_bytes(b"MZ\x90\x00 not a pdf")
    assert upload(client, fake).status_code == 415

    corrupt = tmp_path / "corrupt.pdf"
    corrupt.write_bytes(b"%PDF-1.4\n" + b"\x00" * 100)
    assert upload(client, corrupt).status_code == 422

    big = tmp_path / "big.pdf"
    big.write_bytes(b"%PDF-1.4\n" + b"0" * (6 * 1024 * 1024))
    assert upload(client, big).status_code == 413

    many = make_many_pages_pdf(tmp_path / "many.pdf", 31)
    r = upload(client, many)
    assert r.status_code == 422 and "31" in r.json()["detail"]

    empty = tmp_path / "empty.pdf"
    empty.write_bytes(b"")
    assert upload(client, empty).status_code in (400, 415)
    assert client.get("/api/books").json()["total"] == 0
    if os.name != "nt":  # on Windows MuPDF keeps a handle on files it failed to parse
        assert list(get_settings().tmp_dir.iterdir()) == []  # temp files cleaned up


def test_duplicate_upload_is_rejected(client, user, tmp_path):
    pdf = make_text_pdf(tmp_path / "a.pdf")
    first = upload(client, pdf).json()
    r = upload(client, pdf)
    assert r.status_code == 409
    assert r.json()["detail"]["book_id"] == first["id"]


def test_async_conversion_produces_chapters(client, ready_book):
    book_id = ready_book["id"]
    assert ready_book["chapter_count"] == 3
    assert ready_book["content_version"] == 1
    toc = client.get(f"/api/books/{book_id}/chapters").json()
    assert [c["title"] for c in toc["chapters"]][0].startswith("Capítulo 1")
    ch = client.get(f"/api/books/{book_id}/chapters/0").json()
    assert ch["blocks"][0]["type"] == "heading"
    image = next(b["image"] for b in ch["blocks"] if b["type"] == "image")
    img = client.get(f"/api/books/{book_id}/images/{image}")
    assert img.status_code == 200 and img.headers["content-type"] == "image/png"
    assert client.get(f"/api/books/{book_id}/chapters/99").status_code == 404


def test_original_pdf_is_served_only_to_owner(client, ready_book):
    book_id = ready_book["id"]
    r = client.get(f"/api/books/{book_id}/file")
    assert r.status_code == 200 and r.content.startswith(b"%PDF")
    assert r.headers["content-type"] == "application/pdf"
    partial = client.get(f"/api/books/{book_id}/file", headers={"Range": "bytes=0-9"})
    assert partial.status_code == 206 and len(partial.content) == 10

    intruder = TestClient(app)
    intruder.headers.update(CSRF)
    register(intruder, email="eve@example.com", name="Eve")
    for path in ("", "/file", "/chapters", "/chapters/0", "/progress", "/bookmarks", "/search?q=leitura"):
        assert intruder.get(f"/api/books/{book_id}{path}").status_code == 404, path
    assert intruder.delete(f"/api/books/{book_id}").status_code == 404
    assert intruder.get("/api/books").json()["total"] == 0

    anonymous = TestClient(app)
    assert anonymous.get(f"/api/books/{book_id}/file").status_code == 401


def test_path_traversal_on_images_is_blocked(client, ready_book):
    book_id = ready_book["id"]
    for name in ("..%2F..%2Fmanifest.json", "manifest.json", "img-0001.png%00.json", "..\\x.png"):
        assert client.get(f"/api/books/{book_id}/images/{name}").status_code == 404


def test_library_pagination_search_and_filters(client, user, tmp_path):
    for i in range(3):
        upload(client, make_text_pdf(tmp_path / f"b{i}.pdf", [(f"Capítulo {i} - Único", 1 + i)]), title=f"Volume {i}")
    page = client.get("/api/books", params={"page_size": 2}).json()
    assert page["total"] == 3 and len(page["items"]) == 2
    assert client.get("/api/books", params={"page": 2, "page_size": 2}).json()["items"][0]
    assert client.get("/api/books", params={"q": "volume 1"}).json()["total"] == 1
    assert client.get("/api/books", params={"status": "pending"}).json()["total"] == 3
    titles = [b["title"] for b in client.get("/api/books", params={"sort": "title"}).json()["items"]]
    assert titles == sorted(titles)


def test_progress_is_saved_and_restored(client, ready_book):
    book_id = ready_book["id"]
    assert client.get(f"/api/books/{book_id}/progress").json() is None
    pos = {"content_version": 1, "chapter_index": 1, "block_index": 2, "block_offset": 0.4, "page": 2, "percent": 42.5, "mode": "book"}
    assert client.put(f"/api/books/{book_id}/progress", json=pos).status_code == 200

    client.post("/api/auth/logout")
    client.post("/api/auth/login", json={"email": "ana@example.com", "password": "senha-segura-1"})
    got = client.get(f"/api/books/{book_id}/progress").json()
    assert {k: got[k] for k in pos} == pos
    assert client.get(f"/api/books/{book_id}").json()["progress"]["percent"] == 42.5
    dash = client.get("/api/books/dashboard").json()
    assert dash["continue_reading"][0]["id"] == book_id
    assert client.put(f"/api/books/{book_id}/progress", json={**pos, "block_offset": 2}).status_code == 422


def test_bookmarks_highlights_and_notes(client, ready_book):
    book_id = ready_book["id"]
    base = {"content_version": 1, "chapter_index": 0, "block_index": 1, "page": 1}
    bm = client.post(f"/api/books/{book_id}/bookmarks", json={**base, "kind": "bookmark"})
    assert bm.status_code == 201
    hl = client.post(
        f"/api/books/{book_id}/bookmarks",
        json={**base, "kind": "highlight", "start_offset": 0, "end_offset": 10, "quote": "Parágrafo "},
    ).json()
    assert hl["color"] == "yellow"
    note = client.post(
        f"/api/books/{book_id}/bookmarks",
        json={**base, "kind": "note", "start_offset": 5, "end_block_index": 2, "end_offset": 3, "quote": "x", "note": "Reler isto"},
    )
    assert note.status_code == 201

    # Adding a note to a highlight turns it into a note; clearing it reverts.
    upd = client.patch(f"/api/books/{book_id}/bookmarks/{hl['id']}", json={"note": "Importante", "color": "green"}).json()
    assert upd["kind"] == "note" and upd["color"] == "green"
    assert client.patch(f"/api/books/{book_id}/bookmarks/{hl['id']}", json={"note": ""}).json()["kind"] == "highlight"

    items = client.get(f"/api/books/{book_id}/bookmarks").json()
    assert len(items) == 3
    assert client.delete(f"/api/books/{book_id}/bookmarks/{items[0]['id']}").status_code == 204
    assert len(client.get(f"/api/books/{book_id}/bookmarks").json()) == 2

    bad = {**base, "kind": "highlight", "start_offset": 10, "end_offset": 5}
    assert client.post(f"/api/books/{book_id}/bookmarks", json=bad).status_code == 422
    assert client.post(f"/api/books/{book_id}/bookmarks", json={**base, "kind": "note", "note": "  "}).status_code == 422


def test_search_is_accent_and_case_insensitive(client, ready_book):
    r = client.get(f"/api/books/{ready_book['id']}/search", params={"q": "SILENCIO"}).json()
    assert r["total"] >= 7
    hit = r["hits"][0]
    assert hit["snippet"][hit["match_start"] : hit["match_start"] + hit["match_length"]].lower() == "silêncio"
    assert client.get(f"/api/books/{ready_book['id']}/search", params={"q": "x"}).status_code == 422


def test_delete_book_removes_rows_and_files(client, ready_book):
    s = get_settings()
    book_id = ready_book["id"]
    client.post(f"/api/books/{book_id}/bookmarks", json={"kind": "bookmark", "content_version": 1, "chapter_index": 0, "block_index": 0})
    assert (s.upload_dir / f"{book_id}.pdf").exists()
    assert (s.converted_dir / book_id / "v1" / "manifest.json").exists()

    assert client.delete(f"/api/books/{book_id}").status_code == 204
    assert client.get(f"/api/books/{book_id}").status_code == 404
    assert not (s.upload_dir / f"{book_id}.pdf").exists()
    assert not (s.converted_dir / book_id).exists()

    from sqlalchemy import func, select

    from app.db.session import get_sessionmaker
    from app.models import BookChapter, Bookmark, ConversionJob

    with get_sessionmaker()() as db:
        for model in (BookChapter, Bookmark, ConversionJob):
            assert db.scalar(select(func.count()).select_from(model)) == 0


def test_reprocess_creates_new_version_and_removes_old(client, ready_book):
    s = get_settings()
    book_id = ready_book["id"]
    r = client.post(f"/api/books/{book_id}/reprocess", json={"ocr": False})
    assert r.status_code == 200 and r.json()["status"] == "pending"
    assert client.post(f"/api/books/{book_id}/reprocess", json={}).status_code == 409  # already queued
    run_worker()
    book = client.get(f"/api/books/{book_id}").json()
    assert book["status"] == "ready" and book["content_version"] == 2
    assert not (s.converted_dir / book_id / "v1").exists()
    assert client.get(f"/api/books/{book_id}/chapters").json()["content_version"] == 2


def test_scanned_pdf_ends_as_needs_ocr_and_pdf_mode_still_works(client, user, tmp_path):
    book = upload(client, make_scanned_pdf(tmp_path / "scan.pdf")).json()
    run_worker()
    got = client.get(f"/api/books/{book['id']}").json()
    assert got["status"] == "needs_ocr"
    assert client.get(f"/api/books/{book['id']}/file").status_code == 200
    assert client.get(f"/api/books/{book['id']}/chapters").status_code == 409


def test_transient_failure_is_retried_then_marked_failed(client, user, tmp_path, monkeypatch):
    import app.tasks as tasks

    calls = {"n": 0}

    def boom(*_a, **_k):
        calls["n"] += 1
        raise RuntimeError("disk hiccup")

    monkeypatch.setattr(tasks, "convert_pdf", boom)
    book = upload(client, make_text_pdf(tmp_path / "a.pdf")).json()
    run_worker()
    first = client.get(f"/api/books/{book['id']}").json()
    assert first["status"] == "pending" and first["job"]["status"] == "retrying"

    # Retry is scheduled with a delay; enqueue it now instead of waiting.
    from rq import Queue
    from rq.registry import ScheduledJobRegistry

    from tests.conftest import FAKE_REDIS

    q = Queue("conversions", connection=FAKE_REDIS)
    for job_id in ScheduledJobRegistry(queue=q).get_job_ids():
        q.enqueue_job(q.fetch_job(job_id))
    run_worker()
    final = client.get(f"/api/books/{book['id']}").json()
    assert calls["n"] == 2
    assert final["status"] == "failed"
    assert "inesperado" in final["status_message"]
    assert "disk hiccup" not in final["status_message"]  # internals are not shown to the user


def test_conversion_error_fails_without_retry(client, user, tmp_path, monkeypatch):
    import app.tasks as tasks
    from app.converters.pdf import ConversionError

    def bad(*_a, **_k):
        raise ConversionError("PDF protegido por senha não é suportado.")

    monkeypatch.setattr(tasks, "convert_pdf", bad)
    book = upload(client, make_text_pdf(tmp_path / "a.pdf")).json()
    run_worker()
    got = client.get(f"/api/books/{book['id']}").json()
    assert got["status"] == "failed" and got["status_message"] == "PDF protegido por senha não é suportado."


def test_lost_job_is_reconciled(client, user, tmp_path):
    from app.db.session import get_sessionmaker
    from app.models import ConversionJob
    from tests.conftest import FAKE_REDIS

    book = upload(client, make_text_pdf(tmp_path / "a.pdf")).json()
    FAKE_REDIS.flushall()  # simulate the queue losing the job (e.g. Redis wiped)
    with get_sessionmaker()() as db:
        job = db.query(ConversionJob).one()
        job.updated_at = datetime.now(timezone.utc) - timedelta(minutes=10)
        db.commit()
    got = client.get(f"/api/books/{book['id']}").json()
    assert got["status"] == "failed"
    assert "reprocessar" in got["status_message"]


def test_storage_limit_blocks_upload(client, user, tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "storage_limit_mb", 100)
    monkeypatch.setattr(get_settings(), "min_free_disk_mb", 10_000_000)
    r = upload(client, make_text_pdf(tmp_path / "a.pdf"))
    assert r.status_code == 507
    assert "espaço" in r.json()["detail"].lower()


def test_rename_book(client, ready_book):
    r = client.patch(f"/api/books/{ready_book['id']}", json={"title": "  Novo   título ", "author": ""})
    assert r.json()["title"] == "Novo título" and r.json()["author"] is None
