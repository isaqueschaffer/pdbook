# BookFlow API + worker image. Multi-arch: builds natively on ARM64 (OCI Ampere A1) and x86_64.
# Every Python dependency ships manylinux aarch64 wheels, so no compiler is needed.
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Tesseract OCR (Portuguese + English) from Debian: packaged for arm64 and amd64.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-por tesseract-ocr-eng tini \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 10001 bookflow \
 && useradd --system --uid 10001 --gid bookflow --home-dir /app --shell /usr/sbin/nologin bookflow

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY --chown=bookflow:bookflow alembic.ini worker.py ./
COPY --chown=bookflow:bookflow alembic ./alembic
COPY --chown=bookflow:bookflow app ./app

RUN mkdir -p /data/originals /data/converted /data/tmp && chown -R bookflow:bookflow /data
ENV UPLOAD_DIR=/data/originals CONVERTED_DIR=/data/converted TMP_DIR=/data/tmp TMPDIR=/data/tmp

USER bookflow
EXPOSE 8000

ENTRYPOINT ["/usr/bin/tini", "--"]
# --proxy-headers: trust X-Forwarded-For from Caddy (the only thing that can reach this port).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--proxy-headers", "--forwarded-allow-ips", "*", "--no-access-log"]
