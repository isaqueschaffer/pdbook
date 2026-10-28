from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import CSRF, register


def test_register_login_logout_flow(client):
    user = register(client)
    assert user["email"] == "ana@example.com"
    assert client.get("/api/auth/me").json()["display_name"] == "Ana"

    assert client.post("/api/auth/logout").status_code == 204
    assert client.get("/api/auth/me").status_code == 401

    r = client.post("/api/auth/login", json={"email": "ANA@example.com", "password": "senha-segura-1"})
    assert r.status_code == 200
    assert client.get("/api/auth/me").status_code == 200


def test_session_cookie_is_httponly_and_scoped(client):
    r = client.post("/api/auth/register", json={"email": "b@example.com", "password": "senha-segura-1", "display_name": "B"})
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie and "path=/api" in cookie


def test_wrong_password_and_unknown_email_give_same_error(client):
    register(client)
    a = client.post("/api/auth/login", json={"email": "ana@example.com", "password": "errada-123"})
    b = client.post("/api/auth/login", json={"email": "ninguem@example.com", "password": "errada-123"})
    assert a.status_code == b.status_code == 401
    assert a.json() == b.json()


def test_duplicate_email_and_weak_password(client):
    register(client)
    assert client.post("/api/auth/register", json={"email": "ana@example.com", "password": "outra-senha-1", "display_name": "X"}).status_code == 409
    r = client.post("/api/auth/register", json={"email": "c@example.com", "password": "12345678", "display_name": "C"})
    assert r.status_code == 422
    assert "senha" in r.json()["detail"].lower() or "letras" in r.json()["detail"].lower()


def test_password_is_hashed_with_argon2(client):
    from sqlalchemy import select

    from app.db.session import get_sessionmaker
    from app.models import User

    register(client)
    with get_sessionmaker()() as db:
        u = db.scalar(select(User))
        assert u.password_hash.startswith("$argon2id$")
        assert "senha-segura-1" not in u.password_hash


def test_login_rate_limit(client, monkeypatch):
    from app.core.config import get_settings

    register(client)
    monkeypatch.setattr(get_settings(), "login_rate_limit", 3)
    codes = [client.post("/api/auth/login", json={"email": "ana@example.com", "password": "errada-123"}).status_code for _ in range(5)]
    assert codes[:3] == [401, 401, 401]
    assert codes[-1] == 429


def test_csrf_header_required_for_unsafe_methods():
    bare = TestClient(app)
    r = bare.post("/api/auth/register", json={"email": "d@example.com", "password": "senha-segura-1", "display_name": "D"})
    assert r.status_code == 403


def test_change_password_revokes_other_sessions(client):
    register(client)
    other = TestClient(app)
    other.headers.update(CSRF)
    assert other.post("/api/auth/login", json={"email": "ana@example.com", "password": "senha-segura-1"}).status_code == 200

    r = client.post("/api/account/password", json={"current_password": "senha-segura-1", "new_password": "nova-senha-2"})
    assert r.status_code == 204
    assert client.get("/api/auth/me").status_code == 200
    assert other.get("/api/auth/me").status_code == 401
    assert client.post("/api/account/password", json={"current_password": "errada", "new_password": "nova-senha-3"}).status_code == 403


def test_update_account_and_delete(client):
    register(client)
    r = client.patch("/api/account", json={"display_name": "Ana Maria"})
    assert r.json()["display_name"] == "Ana Maria"
    assert client.request("DELETE", "/api/account", json={"password": "errada"}).status_code == 403
    assert client.request("DELETE", "/api/account", json={"password": "senha-segura-1"}).status_code == 204
    assert client.post("/api/auth/login", json={"email": "ana@example.com", "password": "senha-segura-1"}).status_code == 401


def test_preferences_defaults_update_and_reset(client):
    register(client)
    prefs = client.get("/api/preferences").json()
    assert prefs["theme"] == "light" and prefs["font_family"] == "serif"
    prefs.update(theme="sepia", font_size=24, font_family="sans", line_height=2.0)
    assert client.put("/api/preferences", json=prefs).json()["theme"] == "sepia"

    # Preferences survive a new session.
    client.post("/api/auth/logout")
    client.post("/api/auth/login", json={"email": "ana@example.com", "password": "senha-segura-1"})
    got = client.get("/api/preferences").json()
    assert (got["theme"], got["font_size"], got["font_family"]) == ("sepia", 24, "sans")

    assert client.put("/api/preferences", json={**got, "font_size": 99}).status_code == 422
    assert client.post("/api/preferences/reset").json()["theme"] == "light"


def test_health_and_config(client):
    assert client.get("/api/health").json() == {"status": "ok"}
    cfg = client.get("/api/config").json()
    assert cfg["max_upload_mb"] == 5 and cfg["max_pdf_pages"] == 30
