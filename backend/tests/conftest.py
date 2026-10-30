"""Test setup: SQLite database, fakeredis and temporary storage directories.

Set TEST_DATABASE_URL to a PostgreSQL URL (e.g. a Neon branch) to run the same suite against Postgres.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="pdbook-tests-"))
os.environ.update(
    {
        "ENVIRONMENT": "test",
        "DATABASE_URL": os.environ.get("TEST_DATABASE_URL", f"sqlite:///{(_TMP / 'test.db').as_posix()}"),
        "SESSION_SECRET": "test-secret-" + "x" * 40,
        "REDIS_URL": "redis://fake:6379/0",
        "UPLOAD_DIR": str(_TMP / "originals"),
        "CONVERTED_DIR": str(_TMP / "converted"),
        "TMP_DIR": str(_TMP / "tmp"),
        "MAX_UPLOAD_MB": "5",
        "MAX_PDF_PAGES": "30",
        "JOB_MAX_RETRIES": "1",
        "MIN_FREE_DISK_MB": "0",
        "FRONTEND_URL": "http://testserver",
        "LOGIN_RATE_LIMIT": "50",
        "REGISTER_RATE_LIMIT": "500",
        "UPLOAD_RATE_LIMIT": "500",
    }
)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import fakeredis  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import app.core.redis as redis_mod  # noqa: E402

FAKE_REDIS = fakeredis.FakeRedis()


class _FakeRedisFactory:
    @staticmethod
    def from_url(*_args, **_kwargs):
        return FAKE_REDIS


redis_mod.Redis = _FakeRedisFactory  # type: ignore[assignment]
redis_mod.get_redis.cache_clear()

from app.db.base import Base  # noqa: E402
from app.db.session import get_engine  # noqa: E402
from app.main import app  # noqa: E402

CSRF = {"X-Requested-With": "PDBook"}


@pytest.fixture(autouse=True)
def _clean_state():
    engine = get_engine()
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    FAKE_REDIS.flushall()
    yield


@pytest.fixture
def client() -> TestClient:
    c = TestClient(app)
    c.headers.update(CSRF)
    return c


def register(client: TestClient, email: str = "ana@example.com", password: str = "senha-segura-1", name: str = "Ana") -> dict:
    r = client.post("/api/auth/register", json={"email": email, "password": password, "display_name": name})
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture
def user(client: TestClient) -> dict:
    return register(client)


def run_worker() -> None:
    """Process every queued job synchronously with a real RQ worker on fakeredis."""
    from rq import SimpleWorker
    from rq.timeouts import TimerDeathPenalty

    from app.services.queue import OCR_QUEUE, TEXT_QUEUE

    class TestWorker(SimpleWorker):
        death_penalty_class = TimerDeathPenalty  # SIGALRM is not available on Windows

    TestWorker([TEXT_QUEUE, OCR_QUEUE], connection=FAKE_REDIS).work(burst=True)


@pytest.fixture
def tmpdir_path(tmp_path: Path) -> Path:
    return tmp_path
