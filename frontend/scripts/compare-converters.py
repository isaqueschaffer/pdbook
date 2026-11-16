"""Compare the server converter with the device converter on any folder of PDFs.

    # 1. server side: writes <name>.server.json next to each PDF
    backend/.venv/Scripts/python frontend/scripts/compare-converters.py server <folder>
    # 2. device side: writes <name>.device.json (pdf.js, same code as the app)
    cd frontend && PARITY_DIR=<folder> npx vitest run src/device/convert/compare.node.test.ts
    # 3. report
    backend/.venv/Scripts/python frontend/scripts/compare-converters.py report <folder>

The report shows, per PDF: chapters on each side, how many chapter titles match, block counts, how
many blocks are identical in the same position (what bookmarks rely on) and the text similarity.
"""

from __future__ import annotations

import difflib
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))


def server(folder: Path) -> None:
    from app.converters.pdf import ConversionOptions, convert_pdf

    for pdf in sorted(folder.glob("*.pdf")):
        tmp = Path(tempfile.mkdtemp(prefix="pdbook-cmp-"))
        try:
            started = time.perf_counter()
            result = convert_pdf(pdf, tmp / "out", ConversionOptions(max_pages=2000, max_images=0))
            elapsed = time.perf_counter() - started
            chapters = []
            for meta in result.chapters:
                data = json.loads((tmp / "out" / meta.file).read_text(encoding="utf-8"))
                chapters.append({"title": meta.title, "blocks": data["blocks"]})
            out = {"seconds": round(elapsed, 2), "page_count": result.page_count, "needs_ocr": result.needs_ocr, "word_count": result.word_count, "chapters": chapters}
            pdf.with_suffix(".server.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
            print(f"{pdf.name}: {len(chapters)} chapters in {elapsed:.1f}s")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


def _blocks(doc: dict) -> list[tuple[int, int, str, str]]:
    return [(ci, bi, b["type"], b.get("text") or "") for ci, ch in enumerate(doc["chapters"]) for bi, b in enumerate(ch["blocks"])]


def report(folder: Path) -> None:
    for s_path in sorted(folder.glob("*.server.json")):
        name = s_path.name.removesuffix(".server.json")
        d_path = folder / f"{name}.device.json"
        if not d_path.exists():
            print(f"{name}: no device output")
            continue
        s, d = json.loads(s_path.read_text(encoding="utf-8")), json.loads(d_path.read_text(encoding="utf-8"))
        sb, db = _blocks(s), _blocks(d)
        same_pos = sum(1 for a, b in zip(sb, db) if a == b)
        s_titles = [c["title"] for c in s["chapters"]]
        d_titles = [c["title"] for c in d["chapters"]]
        title_match = sum(1 for t in d_titles if t in s_titles)
        s_words = " ".join(t for *_, t in sb).split()
        d_words = " ".join(t for *_, t in db).split()
        sm = difflib.SequenceMatcher(None, s_words, d_words)
        para = difflib.SequenceMatcher(None, [t for *_, t in sb], [t for *_, t in db], autojunk=False)
        identical_blocks = sum(m.size for m in para.get_matching_blocks())
        print(f"\n== {name} ({s['page_count']} páginas)")
        print(f"  tempo: servidor {s['seconds']}s · aparelho {d['seconds']}s")
        print(f"  needs_ocr: servidor {s['needs_ocr']} · aparelho {d['needs_ocr']}")
        print(f"  capítulos: servidor {len(s_titles)} · aparelho {len(d_titles)} · títulos iguais {title_match}")
        print(f"  blocos: servidor {len(sb)} · aparelho {len(db)} · idênticos na mesma posição {same_pos} ({same_pos / max(len(sb), 1):.0%})")
        print(f"  blocos com texto idêntico (em qualquer posição): {identical_blocks} ({identical_blocks / max(len(sb), 1):.0%})")
        print(f"  palavras: servidor {len(s_words)} · aparelho {len(d_words)} · semelhança do texto {sm.ratio():.1%}")
        shown = 0
        for tag, i1, i2, j1, j2 in para.get_opcodes():
            if tag == "equal" or shown >= 3:
                continue
            shown += 1
            print(f"  -- diferença ({tag}):")
            for _, _, ty, t in sb[i1 : min(i2, i1 + 2)]:
                print(f"     servidor [{ty}] {t[:110]!r}")
            for _, _, ty, t in db[j1 : min(j2, j1 + 2)]:
                print(f"     aparelho [{ty}] {t[:110]!r}")


if __name__ == "__main__":
    cmd, folder = sys.argv[1], Path(sys.argv[2])
    {"server": server, "report": report}[cmd](folder)
