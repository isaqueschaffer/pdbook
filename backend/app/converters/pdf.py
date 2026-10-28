"""PDF -> structured, reflowable book content.

The converter walks the document one page at a time (PyMuPDF opens files lazily, so the whole PDF is
never held in memory), keeps only the extracted text geometry, then:

1. removes running headers/footers and page numbers;
2. orders blocks for reading (handles two-column layouts);
3. classifies lines as headings or body text from font size/weight;
4. rebuilds paragraphs (de-hyphenation, merges paragraphs split by page breaks);
5. splits the result into chapters (PDF outline > detected headings > page ranges);
6. writes versioned JSON files plus the relevant images.

Output format (format 1):
    manifest.json             book-level metadata and chapter list
    chapters/NNNN.json        {"index", "title", "blocks": [{"type", "text"|"image", "level"?, "page"}]}
    images/img-NNNN.png|jpg   extracted figures
"""

from __future__ import annotations

import json
import logging
import re
import unicodedata
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import pymupdf

from app.converters import ocr as ocr_mod

log = logging.getLogger(__name__)

FORMAT_VERSION = 1
MAX_CHAPTER_BLOCKS = 1200
MAX_CHAPTER_CHARS = 120_000
FALLBACK_PAGES_PER_CHAPTER = 15
TERMINAL_PUNCT = tuple('.!?:;"”»)…')
BULLET_RE = re.compile(r"^\s*([•●▪◦‣∙·\-–—*]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s+")
PAGE_NUMBER_RE = re.compile(
    r"^\W*((p(á|a)g(ina)?|page|p\.)\s*)?([0-9]{1,4}|[ivxlcdm]{1,7})(\s*(de|of|/)\s*[0-9]{1,4})?\W*$", re.I
)
CONTROL_RE = re.compile(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f­​﻿]")
SPACE_RE = re.compile(r"\s+")


class ConversionError(Exception):
    """Conversion failed for a reason that can be shown to the user."""


@dataclass
class ConversionOptions:
    max_pages: int = 250
    ocr: bool = False
    ocr_languages: str = "por+eng"
    ocr_dpi: int = 200
    ocr_page_timeout: int = 120
    ocr_min_chars_per_page: int = 40
    max_images: int = 300
    min_image_px: int = 120


@dataclass
class Line:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    size: float
    bold: bool


@dataclass
class RawBlock:
    page: int
    x0: float
    y0: float
    x1: float
    y1: float
    lines: list[Line] = field(default_factory=list)
    image: str | None = None
    image_w: int = 0
    image_h: int = 0
    image_xref: int = 0


@dataclass
class Item:
    type: str  # heading | paragraph | list_item | image
    page: int
    text: str = ""
    level: int = 0
    image: str | None = None
    width: int = 0
    height: int = 0

    def to_json(self) -> dict:
        d: dict = {"type": self.type, "page": self.page}
        if self.type == "image":
            d.update(image=self.image, width=self.width, height=self.height)
        else:
            d["text"] = self.text
        if self.type == "heading":
            d["level"] = self.level
        return d

    @property
    def words(self) -> int:
        return len(self.text.split())


@dataclass
class ChapterMeta:
    index: int
    title: str
    level: int
    start_page: int
    end_page: int
    block_count: int
    word_count: int
    file: str
    sections: list[dict]


@dataclass
class ConversionResult:
    page_count: int
    chapters: list[ChapterMeta]
    word_count: int
    needs_ocr: bool
    ocr_used: bool
    warnings: list[str]


ProgressCallback = Callable[[int], None]


# ---------------------------------------------------------------------------
# Text helpers


def clean_text(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    text = CONTROL_RE.sub("", text)
    return SPACE_RE.sub(" ", text).strip()


def join_lines(parts: list[str]) -> str:
    out = ""
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if not out:
            out = part
        elif out.endswith("-") and len(out) > 1 and out[-2].isalpha() and part[:1].islower():
            out = out[:-1] + part  # de-hyphenate "exem-\nplo"
        else:
            out += " " + part
    return out


def _ends_sentence(text: str) -> bool:
    return text.rstrip().endswith(TERMINAL_PUNCT)


def _norm_running(text: str) -> str:
    return re.sub(r"\d+", "#", text.lower()).strip()


def _fold(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower())
    return re.sub(r"[^a-z0-9]+", " ", "".join(c for c in text if not unicodedata.combining(c))).strip()


# ---------------------------------------------------------------------------
# Page extraction


def _extract_text_blocks(page: pymupdf.Page, page_no: int) -> list[RawBlock]:
    flags = pymupdf.TEXT_MEDIABOX_CLIP  # no ligature/whitespace preservation, no image payloads
    data = page.get_text("dict", flags=flags)
    blocks: list[RawBlock] = []
    for b in data["blocks"]:
        if b.get("type") != 0:
            continue
        rb = RawBlock(page_no, *b["bbox"])
        for ln in b["lines"]:
            spans = [s for s in ln["spans"] if s["text"].strip()]
            if not spans:
                continue
            text = clean_text("".join(s["text"] for s in ln["spans"]))
            if not text:
                continue
            weights = Counter()
            bold_chars = 0
            for s in spans:
                n = len(s["text"].strip())
                weights[round(s["size"] * 2) / 2] += n
                if s["flags"] & 16 or "bold" in s["font"].lower() or "black" in s["font"].lower():
                    bold_chars += n
            total = sum(weights.values()) or 1
            # Upright text only; rotated lines (margins, stamps) are usually not body text.
            if abs(ln.get("dir", (1, 0))[1]) > 0.1:
                continue
            rb.lines.append(Line(text, *ln["bbox"], size=weights.most_common(1)[0][0], bold=bold_chars / total > 0.6))
        if rb.lines:
            blocks.append(rb)
    return blocks


def _ocr_blocks(page: pymupdf.Page, page_no: int, opts: ConversionOptions, languages: str) -> list[RawBlock]:
    pix = page.get_pixmap(dpi=opts.ocr_dpi, colorspace=pymupdf.csGRAY)
    png = pix.tobytes("png")
    del pix
    paragraphs = ocr_mod.ocr_png(png, languages=languages, dpi=opts.ocr_dpi, timeout=opts.ocr_page_timeout)
    blocks = []
    for par in paragraphs:
        lines = [
            # Word box height is ~0.75 of the font size for mixed-case text.
            Line(clean_text(ln.text), ln.x0, ln.y0, ln.x1, ln.y1, size=round(ln.height / 0.75 * 2) / 2, bold=False)
            for ln in par.lines
            if clean_text(ln.text)
        ]
        if lines:
            blocks.append(
                RawBlock(page_no, min(l.x0 for l in lines), min(l.y0 for l in lines), max(l.x1 for l in lines), max(l.y1 for l in lines), lines)
            )
    return blocks


def _image_blocks(
    doc: pymupdf.Document, page: pymupdf.Page, page_no: int, opts: ConversionOptions, images_dir: Path, state: dict
) -> list[RawBlock]:
    if opts.max_images <= 0:
        return []
    area = page.rect.width * page.rect.height
    out: list[RawBlock] = []
    seen_here: set[int] = set()
    for info in page.get_image_info(xrefs=True):
        xref = info.get("xref") or 0
        if not xref or xref in seen_here:
            continue
        seen_here.add(xref)
        state["xref_pages"][xref] += 1
        x0, y0, x1, y1 = info["bbox"]
        shown = max(0.0, (x1 - x0)) * max(0.0, (y1 - y0))
        if info["width"] < opts.min_image_px or info["height"] < opts.min_image_px or shown < area * 0.02:
            continue
        if shown > area * 0.9 and state.get("scanned_page"):
            continue  # full-page scan, not a figure
        name = state["xref_files"].get(xref)
        if name is None:
            if state["count"] >= opts.max_images:
                state["capped"] = True
                continue
            name = _save_image(doc, xref, images_dir, state["count"] + 1)
            if name is None:
                continue
            state["count"] += 1
            state["xref_files"][xref] = name
        out.append(RawBlock(page_no, x0, y0, x1, y1, image=name, image_w=info["width"], image_h=info["height"], image_xref=xref))
    return out


def _save_image(doc: pymupdf.Document, xref: int, images_dir: Path, n: int) -> str | None:
    try:
        info = doc.extract_image(xref)
        ext = (info.get("ext") or "").lower()
        if ext in ("jpeg", "jpg") and not info.get("smask"):
            name, payload = f"img-{n:04d}.jpg", info["image"]
        elif ext == "png" and not info.get("smask"):
            name, payload = f"img-{n:04d}.png", info["image"]
        else:
            pix = pymupdf.Pixmap(doc, xref)
            if pix.n - pix.alpha >= 4:  # CMYK -> RGB
                pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
            name, payload = f"img-{n:04d}.png", pix.tobytes("png")
            del pix
        if len(payload) > 8 * 1024 * 1024:
            return None
        images_dir.mkdir(parents=True, exist_ok=True)
        (images_dir / name).write_bytes(payload)
        return name
    except Exception:  # noqa: BLE001 - a broken image must not fail the whole book
        log.warning("skipping unreadable image xref=%s", xref)
        return None


# ---------------------------------------------------------------------------
# Layout analysis


def _reading_order(blocks: list[RawBlock], page_width: float) -> tuple[list[RawBlock], bool]:
    """Order blocks top-to-bottom, reading left column before right column when the page has two."""
    mid = page_width / 2
    tol = page_width * 0.03

    def side(b: RawBlock) -> str:
        if b.x1 <= mid + tol:
            return "L"
        if b.x0 >= mid - tol:
            return "R"
        return "F"

    sides = [side(b) for b in blocks]
    columned = sides.count("L") >= 2 and sides.count("R") >= 2
    if not columned:
        return sorted(blocks, key=lambda b: (round(b.y0), b.x0)), False

    ordered: list[RawBlock] = []
    segment: list[RawBlock] = []

    def flush() -> None:
        ordered.extend(sorted((b for b in segment if side(b) == "L"), key=lambda b: b.y0))
        ordered.extend(sorted((b for b in segment if side(b) == "R"), key=lambda b: b.y0))
        segment.clear()

    for b in sorted(blocks, key=lambda b: (b.y0, b.x0)):
        if side(b) == "F":
            flush()
            ordered.append(b)
        else:
            segment.append(b)
    flush()
    return ordered, True


def _remove_running_text(pages: list[list[RawBlock]], heights: list[float]) -> None:
    """Drop headers/footers that repeat across pages, and bare page numbers in the margins."""
    n = len(pages)
    counts: Counter[str] = Counter()
    for blocks, h in zip(pages, heights):
        seen = set()
        for b in blocks:
            for ln in b.lines:
                if ln.y1 < h * 0.1 or ln.y0 > h * 0.9:
                    seen.add(_norm_running(ln.text))
        counts.update(seen)
    threshold = max(3, int(n * 0.3))
    repeated = {t for t, c in counts.items() if c >= threshold and t}
    for i, (blocks, h) in enumerate(zip(pages, heights)):
        kept = []
        for b in blocks:
            if b.image:
                kept.append(b)
                continue
            b.lines = [
                ln
                for ln in b.lines
                if not (
                    (ln.y1 < h * 0.1 or ln.y0 > h * 0.9)
                    and (_norm_running(ln.text) in repeated or PAGE_NUMBER_RE.match(ln.text))
                )
            ]
            if b.lines:
                kept.append(b)
        pages[i] = kept


def _font_profile(pages: list[list[RawBlock]]) -> tuple[float, dict[float, int]]:
    sizes: Counter[float] = Counter()
    for blocks in pages:
        for b in blocks:
            for ln in b.lines:
                sizes[ln.size] += len(ln.text)
    if not sizes:
        return 11.0, {}
    body = sizes.most_common(1)[0][0]
    heading_sizes = sorted((s for s, c in sizes.items() if s >= body * 1.2 and c >= 3), reverse=True)
    levels = {s: min(i + 1, 3) for i, s in enumerate(heading_sizes)}
    return body, levels


def _block_items(b: RawBlock, body: float, levels: dict[float, int]) -> list[Item]:
    if b.image:
        return [Item("image", b.page, image=b.image, width=b.image_w, height=b.image_h)]

    items: list[Item] = []
    groups: list[tuple[int, list[Line]]] = []  # (heading level or 0, lines)
    for ln in b.lines:
        lvl = 0
        if ln.size >= body * 1.2 and len(ln.text) <= 150 and any(c.isalpha() for c in ln.text):
            lvl = levels.get(ln.size) or 3
        if groups and groups[-1][0] == lvl:
            groups[-1][1].append(ln)
        else:
            groups.append((lvl, [ln]))

    for lvl, lines in groups:
        text = join_lines([ln.text for ln in lines])
        if lvl and len(lines) <= 3:
            items.append(Item("heading", b.page, text=text, level=lvl))
            continue
        # A short, fully bold block at body size reads as a minor heading.
        if (
            len(groups) == 1
            and len(lines) <= 2
            and all(ln.bold for ln in lines)
            and len(text) <= 100
            and not _ends_sentence(text)
            and any(c.isalpha() for c in text)
        ):
            items.append(Item("heading", b.page, text=text, level=3))
            continue
        items.extend(_paragraphs(lines, b, body))
    return items


def _paragraphs(lines: list[Line], b: RawBlock, body: float) -> list[Item]:
    width = max(b.x1 - b.x0, 1.0)
    paras: list[list[Line]] = [[lines[0]]]
    for prev, ln in zip(lines, lines[1:]):
        gap = ln.y0 - prev.y1
        lh = max(prev.y1 - prev.y0, 1.0)
        new = False
        if gap > lh * 0.8:
            new = True
        elif BULLET_RE.match(ln.text):
            new = True
        elif _ends_sentence(prev.text) and (ln.x0 - b.x0 > body * 0.9 or prev.x1 < b.x1 - width * 0.15):
            new = True
        if new:
            paras.append([ln])
        else:
            paras[-1].append(ln)
    items = []
    for p in paras:
        text = join_lines([ln.text for ln in p])
        if text:
            items.append(Item("list_item" if BULLET_RE.match(text) else "paragraph", b.page, text=text))
    return items


def _merge_page_breaks(items: list[Item]) -> list[Item]:
    out: list[Item] = []
    for it in items:
        prev = out[-1] if out else None
        if (
            prev is not None
            and it.type == "paragraph"
            and prev.type == "paragraph"
            and it.page == prev.page + 1
            and not _ends_sentence(prev.text)
            and (it.text[:1].islower() or prev.text.endswith((",", "-")))
        ):
            prev.text = join_lines([prev.text, it.text])
            continue
        out.append(it)
    return out


# ---------------------------------------------------------------------------
# Chapters


def _split_points_from_toc(toc: list, items: list[Item], page_count: int) -> list[tuple[int, str, int]]:
    entries = [(lvl, clean_text(title), page) for lvl, title, page, *_ in toc if 1 <= page <= page_count and clean_text(title)]
    if not entries:
        return []
    top = min(e[0] for e in entries)
    chosen = [e for e in entries if e[0] == top]
    if len(chosen) < 2:
        chosen = [e for e in entries if e[0] <= top + 1]
    if len(chosen) < 2:
        return []
    points: list[tuple[int, str, int]] = []
    last = -1
    for lvl, title, page in chosen:
        folded = _fold(title)
        idx = None
        for i, it in enumerate(items):
            if it.page < page or i <= last:
                continue
            if it.page > page:
                break
            if it.type == "heading" and folded and (_fold(it.text).startswith(folded[:40]) or folded.startswith(_fold(it.text)[:40] or "\0")):
                idx = i
                break
        if idx is None:
            idx = next((i for i, it in enumerate(items) if it.page >= page and i > last), None)
        if idx is None:
            continue
        points.append((idx, title, lvl - top + 1))
        last = idx
    return points


def _split_points_from_headings(items: list[Item], page_count: int) -> list[tuple[int, str, int]]:
    for max_level in (1, 2):
        heads = [(i, it.text, it.level) for i, it in enumerate(items) if it.type == "heading" and it.level <= max_level]
        if 2 <= len(heads) <= max(8, page_count * 1.5):
            return heads
    return []


def _split_points_by_pages(items: list[Item]) -> list[tuple[int, str, int]]:
    points: list[tuple[int, str, int]] = []
    next_page = 1
    for i, it in enumerate(items):
        if it.page >= next_page:
            points.append((i, "", 1))
            next_page = it.page + FALLBACK_PAGES_PER_CHAPTER
    return points


def build_chapters(items: list[Item], toc: list, page_count: int) -> list[tuple[str, int, list[Item]]]:
    if not items:
        return []
    points = _split_points_from_toc(toc, items, page_count) or _split_points_from_headings(items, page_count)
    by_pages = not points
    if by_pages:
        points = _split_points_by_pages(items)

    chapters: list[tuple[str, int, list[Item]]] = []
    if points[0][0] > 0:
        chapters.append(("Início", 1, items[: points[0][0]]))
    for n, (start, title, level) in enumerate(points):
        end = points[n + 1][0] if n + 1 < len(points) else len(items)
        chunk = items[start:end]
        if by_pages and chunk[0].type == "heading":
            title = chunk[0].text[:120]
        elif by_pages:
            title = f"Páginas {chunk[0].page}–{chunk[-1].page}" if chunk[0].page != chunk[-1].page else f"Página {chunk[0].page}"
        chapters.append((title, level, chunk))

    # A chapter holding only headings (e.g. "Parte I") is folded into the next one.
    merged: list[tuple[str, int, list[Item]]] = []
    carry: list[Item] = []
    for n, (title, level, chunk) in enumerate(chapters):
        chunk = carry + chunk
        carry = []
        if n + 1 < len(chapters) and len(chunk) <= 3 and all(it.type == "heading" for it in chunk):
            carry = chunk
            continue
        merged.append((title, level, chunk))

    # Keep each chapter file small enough to load quickly on a phone.
    sized: list[tuple[str, int, list[Item]]] = []
    for title, level, chunk in merged:
        parts: list[list[Item]] = [[]]
        chars = 0
        for it in chunk:
            if parts[-1] and (len(parts[-1]) >= MAX_CHAPTER_BLOCKS or chars >= MAX_CHAPTER_CHARS):
                parts.append([])
                chars = 0
            parts[-1].append(it)
            chars += len(it.text)
        for k, part in enumerate(parts):
            sized.append((title if k == 0 else f"{title} (parte {k + 1})", level, part))
    return sized


# ---------------------------------------------------------------------------
# Entry point


def convert_pdf(pdf_path: Path, out_dir: Path, opts: ConversionOptions, progress: ProgressCallback | None = None) -> ConversionResult:
    """Convert pdf_path into out_dir (which must not exist yet). Raises ConversionError."""
    try:
        doc = pymupdf.open(pdf_path)
    except Exception as exc:  # noqa: BLE001
        raise ConversionError("Não foi possível abrir o PDF. O arquivo pode estar corrompido.") from exc
    try:
        if doc.needs_pass:
            raise ConversionError("PDF protegido por senha não é suportado.")
        page_count = doc.page_count
        if page_count == 0:
            raise ConversionError("O PDF não possui páginas.")
        if page_count > opts.max_pages:
            raise ConversionError(f"O PDF tem {page_count} páginas; o limite configurado é {opts.max_pages}.")

        languages = ocr_mod.resolve_languages(opts.ocr_languages) if opts.ocr else ""
        out_dir.mkdir(parents=True)
        images_dir = out_dir / "images"
        img_state = {"count": 0, "capped": False, "xref_files": {}, "xref_pages": Counter()}

        pages: list[list[RawBlock]] = []
        heights: list[float] = []
        low_text_pages: list[int] = []
        columned_pages = 0
        ocr_pages = 0
        for i in range(page_count):
            page = doc.load_page(i)
            page_no = i + 1
            text_blocks = _extract_text_blocks(page, page_no)
            chars = sum(len(ln.text) for b in text_blocks for ln in b.lines)
            scanned = chars < opts.ocr_min_chars_per_page
            if scanned:
                low_text_pages.append(page_no)
                if opts.ocr:
                    text_blocks = _ocr_blocks(page, page_no, opts, languages)
                    ocr_pages += 1
            img_state["scanned_page"] = scanned
            blocks = text_blocks + _image_blocks(doc, page, page_no, opts, images_dir, img_state)
            ordered, columned = _reading_order(blocks, page.rect.width)
            columned_pages += columned
            pages.append(ordered)
            heights.append(page.rect.height)
            del page
            if i % 10 == 9:
                pymupdf.TOOLS.store_shrink(100)  # release MuPDF's object cache
            if progress:
                progress(int((i + 1) / page_count * 85))

        toc = doc.get_toc(simple=True)
    finally:
        doc.close()

    # Images repeated on many pages are logos/decorations.
    decorative = {x for x, c in img_state["xref_pages"].items() if c > 3}
    for xref in decorative:
        name = img_state["xref_files"].pop(xref, None)
        if name:
            (images_dir / name).unlink(missing_ok=True)
    for blocks in pages:
        blocks[:] = [b for b in blocks if not (b.image and b.image_xref in decorative)]

    _remove_running_text(pages, heights)
    body, levels = _font_profile(pages)
    items: list[Item] = []
    for blocks in pages:
        for b in blocks:
            items.extend(_block_items(b, body, levels))
    items = _merge_page_breaks(items)
    del pages

    chapters = build_chapters(items, toc, page_count)
    total_words = sum(it.words for it in items)
    scanned_share = len(low_text_pages) / page_count
    needs_ocr = not opts.ocr and scanned_share >= 0.5

    warnings: list[str] = []
    if opts.ocr and ocr_pages:
        warnings.append(f"{ocr_pages} página(s) foram lidas por OCR; o texto pode conter erros de reconhecimento.")
    elif low_text_pages and not opts.ocr:
        warnings.append(f"{len(low_text_pages)} página(s) têm pouco ou nenhum texto extraível (possivelmente digitalizadas).")
    if columned_pages:
        warnings.append("O documento tem páginas em colunas; a ordem de leitura foi reconstruída e pode ter imperfeições.")
    if img_state["capped"]:
        warnings.append("Nem todas as imagens foram extraídas (limite por livro atingido).")
    warnings.append("Tabelas, fórmulas e diagramas podem não ser reproduzidos fielmente; use o modo PDF para conferi-los.")

    chapters_dir = out_dir / "chapters"
    chapters_dir.mkdir()
    metas: list[ChapterMeta] = []
    for idx, (title, level, chunk) in enumerate(chapters):
        file = f"chapters/{idx:04d}.json"
        first_is_title = bool(chunk) and chunk[0].type == "heading"
        sections = [
            {"block": i, "title": it.text[:200], "level": it.level}
            for i, it in enumerate(chunk)
            if it.type == "heading" and not (i == 0 and first_is_title)
        ][:200]
        if not title:
            title = chunk[0].text[:120] if first_is_title else f"Capítulo {idx + 1}"
        title = title[:300]
        payload = {"index": idx, "title": title, "blocks": [it.to_json() for it in chunk]}
        (out_dir / file).write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        metas.append(
            ChapterMeta(
                index=idx,
                title=title,
                level=level,
                start_page=chunk[0].page,
                end_page=chunk[-1].page,
                block_count=len(chunk),
                word_count=sum(it.words for it in chunk),
                file=file,
                sections=sections,
            )
        )

    manifest = {
        "format": FORMAT_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "page_count": page_count,
        "word_count": total_words,
        "ocr_used": bool(opts.ocr and ocr_pages),
        "needs_ocr": needs_ocr,
        "warnings": warnings,
        "chapters": [m.__dict__ for m in metas],
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    if progress:
        progress(100)
    return ConversionResult(page_count, metas, total_words, needs_ocr, bool(opts.ocr and ocr_pages), warnings)


def read_pdf_info(pdf_path: Path) -> tuple[int, str | None, str | None, bool]:
    """(page_count, title, author, encrypted) without reading page contents."""
    with pymupdf.open(pdf_path) as doc:
        if doc.needs_pass:
            return doc.page_count, None, None, True
        meta = doc.metadata or {}
        title = clean_text(meta.get("title") or "") or None
        author = clean_text(meta.get("author") or "") or None
        if title and (re.match(r"(?i)^(untitled|sem t[ií]tulo|microsoft (word|powerpoint))", title) or re.search(r"\.(docx?|pdf|tex|odt)$", title, re.I)):
            title = None
        return doc.page_count, title, author, False
