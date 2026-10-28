"""Tesseract OCR for scanned pages.

Tesseract runs as a subprocess, one page at a time, single-threaded (OMP_THREAD_LIMIT=1) and with
a per-page timeout, so a single OCR job uses one core and a bounded amount of memory.
TSV output is used so the result keeps line geometry, which feeds the same heading/paragraph
heuristics used for native PDF text.
"""

from __future__ import annotations

import csv
import io
import os
import shutil
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from statistics import median


class OcrUnavailable(Exception):
    pass


@dataclass
class OcrLine:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    height: float


@dataclass
class OcrParagraph:
    lines: list[OcrLine]


def tesseract_path() -> str | None:
    return shutil.which("tesseract")


@lru_cache
def available_languages() -> frozenset[str]:
    exe = tesseract_path()
    if not exe:
        return frozenset()
    out = subprocess.run([exe, "--list-langs"], capture_output=True, text=True, timeout=30)
    langs = out.stdout.splitlines()[1:]
    return frozenset(lang.strip() for lang in langs if lang.strip())


def resolve_languages(requested: str) -> str:
    if not tesseract_path():
        raise OcrUnavailable("Tesseract OCR não está instalado no servidor.")
    have = available_languages()
    chosen = [lang for lang in requested.split("+") if lang in have]
    if not chosen:
        chosen = ["eng"] if "eng" in have else sorted(have)[:1]
    if not chosen:
        raise OcrUnavailable("Nenhum idioma do Tesseract está instalado.")
    return "+".join(chosen)


def ocr_png(png: bytes, *, languages: str, dpi: int, timeout: int) -> list[OcrParagraph]:
    """OCR one rendered page. Coordinates are returned in PDF points (1/72 in)."""
    exe = tesseract_path()
    if not exe:
        raise OcrUnavailable("Tesseract OCR não está instalado no servidor.")
    env = {**os.environ, "OMP_THREAD_LIMIT": "1"}
    proc = subprocess.run(
        [exe, "stdin", "stdout", "-l", languages, "--dpi", str(dpi), "--psm", "3", "tsv"],
        input=png,
        capture_output=True,
        timeout=timeout,
        env=env,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"tesseract exited with code {proc.returncode}")
    return parse_tsv(proc.stdout.decode("utf-8", "replace"), scale=72.0 / dpi)


def parse_tsv(tsv: str, *, scale: float = 1.0, min_conf: float = 20.0) -> list[OcrParagraph]:
    words: dict[tuple[int, int, int], list[dict]] = {}
    order: list[tuple[int, int, int]] = []
    reader = csv.DictReader(io.StringIO(tsv), delimiter="\t", quoting=csv.QUOTE_NONE)
    for row in reader:
        if row.get("level") != "5":
            continue
        text = (row.get("text") or "").strip()
        try:
            conf = float(row.get("conf") or -1)
        except ValueError:
            conf = -1
        if not text or conf < min_conf:
            continue
        key = (int(row["block_num"]), int(row["par_num"]), int(row["line_num"]))
        if key not in words:
            words[key] = []
            order.append(key)
        words[key].append(row)

    paragraphs: dict[tuple[int, int], list[OcrLine]] = {}
    par_order: list[tuple[int, int]] = []
    for key in order:
        ws = words[key]
        left = min(int(w["left"]) for w in ws)
        top = min(int(w["top"]) for w in ws)
        right = max(int(w["left"]) + int(w["width"]) for w in ws)
        bottom = max(int(w["top"]) + int(w["height"]) for w in ws)
        height = median(int(w["height"]) for w in ws)
        line = OcrLine(" ".join(w["text"].strip() for w in ws), left * scale, top * scale, right * scale, bottom * scale, height * scale)
        pkey = key[:2]
        if pkey not in paragraphs:
            paragraphs[pkey] = []
            par_order.append(pkey)
        paragraphs[pkey].append(line)
    return [OcrParagraph(paragraphs[k]) for k in par_order]
