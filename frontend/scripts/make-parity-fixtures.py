"""Regenerate the converter parity fixtures (frontend/src/device/convert/__fixtures__).

Builds a few PDFs with the backend's test factory, converts them with the server converter and saves
the result next to each PDF. heuristics.parity.test.ts converts the same PDFs on the phone side and
requires the same chapters and blocks. Run from the repository root:

    backend/.venv/Scripts/python frontend/scripts/make-parity-fixtures.py   (Windows)
    backend/.venv/bin/python frontend/scripts/make-parity-fixtures.py       (Linux/macOS)
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.converters.pdf import ConversionOptions, convert_pdf  # noqa: E402
from tests.pdf_factory import make_many_pages_pdf, make_text_pdf, make_two_column_pdf  # noqa: E402

OUT = ROOT / "frontend" / "src" / "device" / "convert" / "__fixtures__"

CASES = {
    "book-with-outline": lambda p: make_text_pdf(p, image=False),
    "book-without-outline": lambda p: make_text_pdf(p, toc=False, image=False),
    "two-columns": make_two_column_pdf,
    "many-pages": lambda p: make_many_pages_pdf(p, 40),
}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="pdbook-parity-"))
    try:
        for name, make in CASES.items():
            pdf = make(OUT / f"{name}.pdf")
            work = tmp / name
            result = convert_pdf(pdf, work, ConversionOptions(max_pages=500, max_images=0))
            chapters = []
            for meta in result.chapters:
                data = json.loads((work / meta.file).read_text(encoding="utf-8"))
                chapters.append(
                    {
                        "title": meta.title,
                        "level": meta.level,
                        "start_page": meta.start_page,
                        "end_page": meta.end_page,
                        "sections": meta.sections,
                        "blocks": data["blocks"],
                    }
                )
            expected = {"page_count": result.page_count, "word_count": result.word_count, "needs_ocr": result.needs_ocr, "chapters": chapters}
            (OUT / f"{name}.expected.json").write_text(json.dumps(expected, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
            print(f"{name}: {len(chapters)} chapters, {result.word_count} words")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
