"""PDBook RQ worker.

Starts WORKER_CONCURRENCY worker processes. Process 0 listens to the text queue and the OCR queue;
any extra processes only take text conversions, so at most one OCR job runs at a time.
Each job runs in a forked work-horse with a time limit (RQ job_timeout) and an address-space limit
(WORKER_MEMORY_LIMIT_MB, see app.tasks._apply_memory_limit).

Usage:  python worker.py            run the workers
        python worker.py --check    exit 0 if Redis is reachable and a worker is registered (health check)
"""

from __future__ import annotations

import multiprocessing
import os
import socket
import sys

from rq import Worker

from app.core.config import get_settings
from app.core.logging import setup_logging
from app.core.redis import get_redis
from app.services.queue import OCR_QUEUE, TEXT_QUEUE
from app.services.storage import ensure_dirs


def run(index: int) -> None:
    settings = get_settings()
    setup_logging(settings.log_level)
    os.environ["PDBOOK_FORKING_WORKER"] = "1"
    queues = [TEXT_QUEUE, OCR_QUEUE] if index == 0 and settings.ocr_enabled else [TEXT_QUEUE]
    worker = Worker(queues, connection=get_redis(), name=f"pdbook-{socket.gethostname()}-{index}")
    # The scheduler is needed for retries with a delay; RQ elects a single scheduler across workers.
    worker.work(with_scheduler=True, logging_level=settings.log_level.upper())


def check() -> int:
    redis = get_redis()
    redis.ping()
    host = socket.gethostname()
    mine = [w for w in Worker.all(connection=redis) if w.name.startswith(f"pdbook-{host}-")]
    return 0 if mine else 1


def main() -> None:
    if "--check" in sys.argv:
        sys.exit(check())
    settings = get_settings()
    ensure_dirs()
    if settings.worker_concurrency == 1:
        run(0)
        return
    procs = [multiprocessing.Process(target=run, args=(i,), daemon=False) for i in range(settings.worker_concurrency)]
    for p in procs:
        p.start()
    for p in procs:
        p.join()


if __name__ == "__main__":
    main()
