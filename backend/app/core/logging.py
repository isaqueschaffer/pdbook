"""Logging setup. Messages are scrubbed of anything that looks like a secret before being emitted."""

from __future__ import annotations

import logging
import re

_SECRET_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(?i)\b(password|senha|token|secret|authorization|cookie)(\"?\s*[:=]\s*\"?)[^\s\",;&]+"), r"\1\2***"),
    (re.compile(r"(?i)\b((?:postgres(?:ql)?(?:\+psycopg)?|rediss?)://[^:/@\s]*:)[^@\s]+@"), r"\1***@"),
]


def scrub(text: str) -> str:
    for pattern, replacement in _SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = scrub(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(scrub(a) if isinstance(a, str) else a for a in record.args)
        return True


def setup_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s"))
    handler.addFilter(RedactingFilter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    # uvicorn's access log prints query strings; requests are logged by our middleware without them.
    logging.getLogger("uvicorn.access").disabled = True
