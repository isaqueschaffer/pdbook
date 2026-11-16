"""The mobile app: bearer-token sessions and books converted on the device (metadata-only sync)."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import CSRF

SHA = "a" * 64
APP = {**CSRF, "X-PDBook-Client": "app"}


def app_client(email: str = "app@example.com") -> tuple[TestClient, dict]:
    c = TestClient(app)
    r = c.post("/api/auth/register", json={"email": email, "password": "senha-segura-1", "display_name": "App"}, headers=APP)
    assert r.status_code == 201, r.text
    body = r.json()
    assert not r.cookies, "the app client must not receive the session cookie"
    token = body["session_token"]
    # The app does not rely on cookies: drop them and authenticate with the header only.
    c.cookies.clear()
    c.headers.update({**APP, "Authorization": f"Bearer {token}"})
    return c, body


def content(**over) -> dict:
    return {
        "status": "ready",
        "content_version": 2,
        "chapter_count": 3,
        "word_count": 1200,
        "warnings": ["Aviso de teste"],
        **over,
    }


def register_book(c: TestClient, sha: str = SHA, **over) -> dict:
    payload = {
        "sha256": sha,
        "title": "Livro do aparelho",
        "author": "Autora",
        "original_filename": "livro.pdf",
        "file_size": 12345,
        "page_count": 40,
        "content": content(),
        **over,
    }
    return c.post("/api/books/device", json=payload).json()


def test_app_login_returns_token_and_bearer_auth_works():
    c, body = app_client()
    assert c.get("/api/auth/me").json()["email"] == "app@example.com"

    login = TestClient(app).post("/api/auth/login", json={"email": "app@example.com", "password": "senha-segura-1"}, headers=APP)
    assert login.status_code == 200
    assert login.json()["session_token"] and login.json()["session_token"] != body["session_token"]
    assert not login.cookies

    bad = TestClient(app)
    assert bad.get("/api/auth/me", headers={"Authorization": "Bearer nope"}).status_code == 401

    assert c.post("/api/auth/logout").status_code == 204
    assert c.get("/api/auth/me").status_code == 401


def test_browser_login_does_not_expose_token(client, user):
    r = client.post("/api/auth/login", json={"email": "ana@example.com", "password": "senha-segura-1"})
    assert r.status_code == 200
    assert "session_token" not in r.json()


def test_register_device_book_is_idempotent_by_hash():
    c, _ = app_client()
    client_id = str(uuid.uuid4())
    first = c.post(
        "/api/books/device",
        json={"id": client_id, "sha256": SHA, "title": "T", "original_filename": "t.pdf", "file_size": 10, "page_count": 5, "content": content()},
    )
    assert first.status_code == 201, first.text
    book = first.json()
    assert book["id"] == client_id
    assert book["storage_mode"] == "device"
    assert book["status"] == "ready" and book["chapter_count"] == 3 and book["content_version"] == 2

    # A second device imports the same PDF with its own id: it joins the existing book.
    again = c.post(
        "/api/books/device",
        json={"id": str(uuid.uuid4()), "sha256": SHA, "title": "Outro", "original_filename": "x.pdf", "file_size": 10, "page_count": 5, "content": content()},
    )
    assert again.status_code == 200
    assert again.json()["id"] == client_id

    # Device books take no server storage.
    assert c.get("/api/account/storage").json()["user_used_bytes"] == 0


def test_device_book_ids_cannot_be_hijacked():
    a, _ = app_client("a@example.com")
    b, _ = app_client("b@example.com")
    book = register_book(a)
    r = b.post(
        "/api/books/device",
        json={"id": book["id"], "sha256": "b" * 64, "title": "T", "original_filename": "t.pdf", "file_size": 1, "page_count": 1, "content": content()},
    )
    assert r.status_code == 409
    assert b.get(f"/api/books/{book['id']}").status_code == 404


def test_device_content_update_and_server_only_actions():
    c, _ = app_client()
    book = register_book(c, content=content(status="needs_ocr", chapter_count=0, word_count=0))
    assert book["status"] == "needs_ocr"

    r = c.put(f"/api/books/{book['id']}/device-content", json=content(content_version=3, ocr_requested=True, ocr_used=True, chapter_count=7))
    assert r.status_code == 200
    assert r.json()["status"] == "ready" and r.json()["chapter_count"] == 7 and r.json()["ocr_used"] is True

    assert c.get(f"/api/books/{book['id']}/file").status_code == 404
    assert c.post(f"/api/books/{book['id']}/reprocess", json={"ocr": False}).status_code == 409
    assert c.get(f"/api/books/{book['id']}/chapters").status_code == 409

    assert c.delete(f"/api/books/{book['id']}").status_code == 204
    assert c.get(f"/api/books/{book['id']}").status_code == 404


def test_offline_progress_never_overwrites_newer_position():
    c, _ = app_client()
    book = register_book(c)
    now = datetime.now(timezone.utc)
    base = {"content_version": 2, "chapter_index": 1, "block_index": 4, "block_offset": 0.5, "page": 9, "percent": 40, "mode": "book"}

    r = c.put(f"/api/books/{book['id']}/progress", json={**base, "updated_at": now.isoformat()})
    assert r.status_code == 200 and r.json()["percent"] == 40

    stale = {**base, "percent": 10, "page": 2, "updated_at": (now - timedelta(hours=2)).isoformat()}
    assert c.put(f"/api/books/{book['id']}/progress", json=stale).json()["percent"] == 40

    future = {**base, "percent": 55, "updated_at": (now + timedelta(days=3)).isoformat()}
    saved = c.put(f"/api/books/{book['id']}/progress", json=future).json()
    assert saved["percent"] == 55
    assert datetime.fromisoformat(saved["updated_at"]).replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc) + timedelta(seconds=1)

    # Without a timestamp (the website) the write always wins.
    assert c.put(f"/api/books/{book['id']}/progress", json={**base, "percent": 5}).json()["percent"] == 5


def test_bookmark_with_client_id_is_idempotent():
    c, _ = app_client()
    book = register_book(c)
    bid = str(uuid.uuid4())
    payload = {"id": bid, "kind": "highlight", "content_version": 2, "chapter_index": 0, "block_index": 1, "start_offset": 0, "end_offset": 5, "quote": "Olá", "color": "green"}
    first = c.post(f"/api/books/{book['id']}/bookmarks", json=payload)
    assert first.status_code == 201 and first.json()["id"] == bid
    replay = c.post(f"/api/books/{book['id']}/bookmarks", json=payload)
    assert replay.status_code == 201 and replay.json()["id"] == bid
    assert len(c.get(f"/api/books/{book['id']}/bookmarks").json()) == 1


def test_cors_allows_the_app_origin(monkeypatch):
    from app.core.config import get_settings
    from app.main import create_app

    monkeypatch.setattr(get_settings(), "cors_origins", "https://localhost,capacitor://localhost")
    c = TestClient(create_app())
    r = c.options(
        "/api/auth/me",
        headers={"Origin": "https://localhost", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization,x-pdbook-client,range"},
    )
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "https://localhost"
    allowed = r.headers["access-control-allow-headers"].lower()
    assert "authorization" in allowed and "x-pdbook-client" in allowed and "range" in allowed
