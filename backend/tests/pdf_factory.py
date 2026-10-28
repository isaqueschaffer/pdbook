"""Small synthetic PDFs generated on the fly (no third-party documents in the repository)."""

from __future__ import annotations

from pathlib import Path

import pymupdf

LOREM = (
    "A leitura atenta exige tempo e silêncio. Cada parágrafo deste documento foi escrito para testar "
    "a reconstrução do texto, a quebra automática de linhas e a preservação da ordem de leitura em "
    "diferentes tamanhos de fonte. Palavras longas como extraordinariamente e responsabilidade ajudam "
    "a verificar a hifenização no fim das linhas."
)


def _page(doc: pymupdf.Document, header: str | None, number: int) -> pymupdf.Page:
    page = doc.new_page(width=420, height=595)
    if header:
        page.insert_text((50, 30), header, fontsize=8)
    page.insert_text((200, 575), str(number), fontsize=8)
    return page


def make_text_pdf(path: Path, chapters: list[tuple[str, int]] | None = None, *, toc: bool = True, image: bool = True) -> Path:
    """Book with a running header, page numbers, chapter headings and body paragraphs."""
    chapters = chapters or [("Capítulo 1 — O Começo", 3), ("Capítulo 2 — A Travessia", 2), ("Capítulo 3 — O Retorno", 2)]
    doc = pymupdf.open()
    outline = []
    n = 0
    for c, (title, paragraphs) in enumerate(chapters):
        n += 1
        page = _page(doc, "Livro de Teste do BookFlow", n)
        outline.append([1, title, n])
        page.insert_textbox(pymupdf.Rect(50, 60, 370, 100), title, fontsize=20, fontname="hebo")
        y = 110
        for p in range(paragraphs):
            text = f"Parágrafo {c + 1}.{p + 1}. {LOREM}"
            rect = pymupdf.Rect(50, y, 370, y + 120)
            page.insert_textbox(rect, text, fontsize=11, fontname="helv")
            y += 125
            if y > 480 and p + 1 < paragraphs:
                n += 1
                page = _page(doc, "Livro de Teste do BookFlow", n)
                y = 60
        if image and c == 0:
            pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 200, 150), False)
            pix.set_rect(pix.irect, (40, 90, 160))
            page.insert_image(pymupdf.Rect(110, min(y, 420), 310, min(y, 420) + 150), pixmap=pix)
    if toc:
        doc.set_toc(outline)
    doc.set_metadata({"title": "Livro de Teste", "author": "Equipe BookFlow"})
    doc.save(path)
    doc.close()
    return path


def make_scanned_pdf(path: Path, text: str = "Documento digitalizado para teste de OCR do BookFlow.") -> Path:
    """A page that only contains a picture of text (no text layer)."""
    src = pymupdf.open()
    p = src.new_page(width=420, height=595)
    p.insert_textbox(pymupdf.Rect(40, 60, 380, 400), (text + " ") * 4, fontsize=16, fontname="helv")
    pix = p.get_pixmap(dpi=150)
    src.close()
    doc = pymupdf.open()
    page = doc.new_page(width=420, height=595)
    page.insert_image(page.rect, pixmap=pix)
    doc.save(path)
    doc.close()
    return path


def make_two_column_pdf(path: Path) -> Path:
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_textbox(pymupdf.Rect(50, 40, 545, 80), "Artigo em Duas Colunas", fontsize=20, fontname="hebo")
    left = ["Coluna esquerda primeiro bloco. " + LOREM, "Coluna esquerda segundo bloco. " + LOREM]
    right = ["Coluna direita primeiro bloco. " + LOREM, "Coluna direita segundo bloco. " + LOREM]
    for i, t in enumerate(left):
        page.insert_textbox(pymupdf.Rect(50, 100 + i * 200, 285, 290 + i * 200), t, fontsize=10, fontname="helv")
    for i, t in enumerate(right):
        page.insert_textbox(pymupdf.Rect(310, 100 + i * 200, 545, 290 + i * 200), t, fontsize=10, fontname="helv")
    doc.save(path)
    doc.close()
    return path


def make_many_pages_pdf(path: Path, pages: int) -> Path:
    doc = pymupdf.open()
    for i in range(pages):
        doc.new_page().insert_text((72, 72), f"Página {i + 1}")
    doc.save(path)
    doc.close()
    return path
