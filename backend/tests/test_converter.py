from __future__ import annotations

import json
import shutil

import pytest

from app.converters import ocr
from app.converters.pdf import ConversionError, ConversionOptions, Item, build_chapters, convert_pdf, join_lines
from tests.pdf_factory import make_many_pages_pdf, make_scanned_pdf, make_text_pdf, make_two_column_pdf


def _blocks(out_dir, meta):
    return json.loads((out_dir / meta.file).read_text(encoding="utf-8"))["blocks"]


def test_extracts_chapters_from_outline_and_strips_running_headers(tmp_path):
    pdf = make_text_pdf(tmp_path / "book.pdf")
    out = tmp_path / "out"
    result = convert_pdf(pdf, out, ConversionOptions())

    assert [c.title for c in result.chapters] == ["Capítulo 1 — O Começo", "Capítulo 2 — A Travessia", "Capítulo 3 — O Retorno"]
    assert not result.needs_ocr
    assert result.word_count > 300
    all_text = " ".join(b.get("text", "") for c in result.chapters for b in _blocks(out, c))
    assert "Livro de Teste do BookFlow" not in all_text  # running header removed
    first = _blocks(out, result.chapters[0])
    assert first[0]["type"] == "heading"
    assert any(b["type"] == "image" for b in first)
    assert (out / "images" / next(b["image"] for b in first if b["type"] == "image")).is_file()
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["format"] == 1 and len(manifest["chapters"]) == 3


def test_detects_headings_without_outline(tmp_path):
    pdf = make_text_pdf(tmp_path / "book.pdf", toc=False, image=False)
    result = convert_pdf(pdf, tmp_path / "out", ConversionOptions())
    assert len(result.chapters) == 3
    assert result.chapters[1].title.startswith("Capítulo 2")


def test_two_columns_are_read_left_then_right(tmp_path):
    pdf = make_two_column_pdf(tmp_path / "cols.pdf")
    out = tmp_path / "out"
    result = convert_pdf(pdf, out, ConversionOptions())
    texts = [b["text"] for b in _blocks(out, result.chapters[0]) if b["type"] == "paragraph"]
    order = [t.split(".")[0] for t in texts]
    assert order == ["Coluna esquerda primeiro bloco", "Coluna esquerda segundo bloco", "Coluna direita primeiro bloco", "Coluna direita segundo bloco"]
    assert any("colunas" in w for w in result.warnings)


def test_scanned_pdf_is_flagged_for_ocr(tmp_path):
    pdf = make_scanned_pdf(tmp_path / "scan.pdf")
    result = convert_pdf(pdf, tmp_path / "out", ConversionOptions())
    assert result.needs_ocr
    assert result.word_count == 0


@pytest.mark.skipif(not shutil.which("tesseract"), reason="Tesseract não instalado neste ambiente (presente na imagem Docker do worker)")
def test_ocr_recovers_text_from_scanned_pdf(tmp_path):
    pdf = make_scanned_pdf(tmp_path / "scan.pdf")
    out = tmp_path / "out"
    result = convert_pdf(pdf, out, ConversionOptions(ocr=True))
    assert result.ocr_used
    text = " ".join(b.get("text", "") for c in result.chapters for b in _blocks(out, c)).lower()
    assert "digitalizado" in text


def test_ocr_unavailable_raises_clear_error(tmp_path, monkeypatch):
    monkeypatch.setattr(ocr, "tesseract_path", lambda: None)
    pdf = make_scanned_pdf(tmp_path / "scan.pdf")
    with pytest.raises(ocr.OcrUnavailable):
        convert_pdf(pdf, tmp_path / "out", ConversionOptions(ocr=True))


def test_rejects_too_many_pages(tmp_path):
    pdf = make_many_pages_pdf(tmp_path / "big.pdf", 12)
    with pytest.raises(ConversionError, match="limite"):
        convert_pdf(pdf, tmp_path / "out", ConversionOptions(max_pages=10))


def test_rejects_corrupt_file(tmp_path):
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"%PDF-1.7\n" + b"\x00garbage" * 50)
    with pytest.raises(ConversionError):
        convert_pdf(bad, tmp_path / "out", ConversionOptions())


def test_dehyphenation_and_page_break_merge():
    assert join_lines(["uma pala-", "vra quebrada"]) == "uma palavra quebrada"
    assert join_lines(["bem-", "Vindo"]) == "bem- Vindo"
    items = [Item("paragraph", 1, text="texto que continua"), Item("paragraph", 2, text="na outra página.")]
    from app.converters.pdf import _merge_page_breaks

    merged = _merge_page_breaks(items)
    assert len(merged) == 1 and merged[0].text == "texto que continua na outra página."


def test_page_fallback_chapters_when_no_headings():
    items = [Item("paragraph", p, text=f"Texto da página {p}.") for p in range(1, 41)]
    chapters = build_chapters(items, [], 40)
    assert [c[0] for c in chapters] == ["Páginas 1–15", "Páginas 16–30", "Páginas 31–40"]


def test_garbled_text_layer_is_detected():
    from app.converters.pdf import Line, RawBlock, _is_readable

    def block(text):
        return RawBlock(1, 0, 0, 100, 10, [Line(text, 0, 0, 100, 10, 11, False)])

    # Real-world sample: fonts without ToUnicode yield symbol soup instead of letters.
    assert not _is_readable([block("#$!%! #B! ' #!$ (/$ )( 98? 3! &! #$! :. )( $%$")])
    assert _is_readable([block("Nesta lindíssima novela os protagonistas encontram-se durante quatro noites.")])
    assert _is_readable([block("Capítulo 1 — 1848 (pág. 12)")])


def test_caps_titles_become_headings_on_ocr_pages():
    from app.converters.pdf import Line, RawBlock, _block_items, _is_caps_title

    assert _is_caps_title("PRIMEIRA NOITE") and _is_caps_title("A MANHÃ")
    assert not _is_caps_title("Era uma noite prodigiosa") and not _is_caps_title("(1848)")
    lines = [
        Line("QUARTA NOITE", 0, 0, 100, 10, 11, False),
        Line("Meu Deus! Como acabou tudo isto!", 0, 12, 200, 22, 11, False),
    ]
    items = _block_items(RawBlock(102, 0, 0, 200, 22, lines, ocr=True), 11, {})
    assert [(i.type, i.text) for i in items] == [("heading", "QUARTA NOITE"), ("paragraph", "Meu Deus! Como acabou tudo isto!")]


def test_metadata_title_cleanup():
    from app.converters.pdf import clean_title

    raw = "(Microsoft Word - Fi\\363dor M. Dostoi\\351vski - Noites brancas.doc)"
    assert clean_title(raw) == "Fiódor M. Dostoiévski - Noites brancas"
    assert clean_title("Untitled") is None
    assert clean_title("Livro de Teste") == "Livro de Teste"


def test_parse_tesseract_tsv():
    tsv = (
        "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"
        "5\t1\t1\t1\t1\t1\t10\t10\t50\t20\t95\tOlá\n"
        "5\t1\t1\t1\t1\t2\t70\t10\t60\t20\t93\tmundo\n"
        "5\t1\t1\t2\t1\t1\t10\t60\t50\t20\t10\truído\n"
        "5\t1\t2\t1\t1\t1\t10\t100\t80\t20\t90\tSegundo\n"
    )
    pars = ocr.parse_tsv(tsv)
    assert [[ln.text for ln in p.lines] for p in pars] == [["Olá mundo"], ["Segundo"]]
