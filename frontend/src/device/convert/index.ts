/**
 * PDF -> book content, on the device. Mirrors convert_pdf() in backend/app/converters/pdf.py.
 *
 * The output is deterministic for a given file, options and CONVERTER_VERSION, which is what lets
 * two phones that import the same PDF share bookmarks and highlights: their block positions match.
 */
import { getDocument, type PDFDocumentProxy } from "pdfjs-dist";

import { PDFJS_ASSETS } from "../../services/pdfjs";
import {
  blockItems,
  buildChapters,
  cleanAuthor,
  cleanTitle,
  fontProfile,
  isReadable,
  mergePageBreaks,
  readingOrder,
  removeRunningText,
  toJson,
  words,
  type Item,
  type OutBlock,
  type RawBlock,
} from "./heuristics";
import { encodeImage, imagePlacements, pageSize, readToc, textBlocks } from "./extract";

/** Bump when a change alters the converted structure (block boundaries, chapters). */
export const CONVERTER_VERSION = 2;

/** content_version shared by every device that converts the same file the same way. */
export const deviceContentVersion = (ocr: boolean) => CONVERTER_VERSION * 2 + (ocr ? 1 : 0);

export class ConversionError extends Error {}

export interface ConversionOptions {
  ocr: boolean;
  maxPages: number;
  maxImages?: number;
  minImagePx?: number;
  ocrMinCharsPerPage?: number;
  signal?: AbortSignal;
  onProgress?: (percent: number, message?: string) => void;
}

export interface ImageSink {
  save(name: string, blob: Blob): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface ChapterOut {
  index: number;
  title: string;
  level: number;
  start_page: number;
  end_page: number;
  block_count: number;
  word_count: number;
  sections: { block: number; title: string; level: number }[];
  blocks: OutBlock[];
}

export interface ConversionResult {
  pageCount: number;
  chapters: ChapterOut[];
  wordCount: number;
  needsOcr: boolean;
  ocrUsed: boolean;
  warnings: string[];
  imageBytes: number;
}

export interface PdfInfo {
  pageCount: number;
  title: string | null;
  author: string | null;
}

export async function openPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  // pdf.js transfers (detaches) the buffer it is given: hand it a copy.
  const task = getDocument({ data: new Uint8Array(data.slice(0)), ...PDFJS_ASSETS, fontExtraProperties: true });
  try {
    return await task.promise;
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === "PasswordException") throw new ConversionError("PDFs protegidos por senha não são suportados.");
    throw new ConversionError("Não foi possível abrir o PDF. O arquivo pode estar corrompido.");
  }
}

export async function readPdfInfo(doc: PDFDocumentProxy): Promise<PdfInfo> {
  const meta = await doc.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as { Title?: string; Author?: string };
  return { pageCount: doc.numPages, title: cleanTitle(info.Title), author: cleanAuthor(info.Author) };
}

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

export async function convertPdf(doc: PDFDocumentProxy, opts: ConversionOptions, images: ImageSink): Promise<ConversionResult> {
  const maxImages = opts.maxImages ?? 300;
  const minImagePx = opts.minImagePx ?? 120;
  const minChars = opts.ocrMinCharsPerPage ?? 40;
  const pageCount = doc.numPages;
  if (pageCount === 0) throw new ConversionError("O PDF não possui páginas.");
  if (pageCount > opts.maxPages) throw new ConversionError(`O PDF tem ${pageCount} páginas; o limite neste aparelho é ${opts.maxPages}.`);

  let ocrBlocks: typeof import("./ocr").ocrBlocks | null = null;
  if (opts.ocr) ocrBlocks = (await import("./ocr")).ocrBlocks;

  const pages: RawBlock[][] = [];
  const heights: number[] = [];
  const lowTextPages: number[] = [];
  let garbledPages = 0;
  let columnedPages = 0;
  let ocrPages = 0;
  let imageCount = 0;
  let imageBytes = 0;
  let capped = false;
  const fpFile = new Map<string, string>(); // fingerprint -> saved image name
  const fpSize = new Map<string, number>();
  const fpPages = new Map<string, number>(); // fingerprint -> pages it appears on

  for (let i = 0; i < pageCount; i++) {
    if (opts.signal?.aborted) throw new ConversionError("Conversão cancelada.");
    const pageNo = i + 1;
    const page = await doc.getPage(pageNo);
    const { width, height } = pageSize(page);
    // The operator list loads the page's fonts (needed for bold detection) and lists its images.
    const placements = await imagePlacements(page);
    let text = await textBlocks(page, pageNo);
    const chars = text.reduce((n, b) => n + b.lines.reduce((m, l) => m + l.text.length, 0), 0);
    const garbled = chars >= minChars && !isReadable(text);
    if (garbled) {
      // Text layer exists but is unusable (fonts without a Unicode mapping): treat as a scan.
      garbledPages++;
      text = [];
    }
    const scanned = garbled || chars < minChars;
    if (scanned) {
      lowTextPages.push(pageNo);
      if (ocrBlocks) {
        opts.onProgress?.(Math.round((i / pageCount) * 85), `Reconhecendo texto da página ${pageNo} de ${pageCount}`);
        text = await ocrBlocks(page, pageNo);
        ocrPages++;
      }
    }

    const imgBlocks: RawBlock[] = [];
    if (maxImages > 0) {
      const area = width * height;
      const seenHere = new Set<string>();
      for (const p of placements) {
        const shown = Math.max(0, p.x1 - p.x0) * Math.max(0, p.y1 - p.y0);
        if (p.width < minImagePx || p.height < minImagePx || shown < area * 0.02) continue;
        if (shown > area * 0.9 && scanned) continue; // full-page scan, not a figure
        const enc = await encodeImage(page, p.objId);
        if (!enc || seenHere.has(enc.fingerprint)) continue;
        seenHere.add(enc.fingerprint);
        fpPages.set(enc.fingerprint, (fpPages.get(enc.fingerprint) ?? 0) + 1);
        let name = fpFile.get(enc.fingerprint);
        if (!name) {
          if (imageCount >= maxImages) {
            capped = true;
            continue;
          }
          if (enc.blob.size > 8 * 1024 * 1024) continue;
          name = `img-${String(imageCount + 1).padStart(4, "0")}.${enc.png ? "png" : "jpg"}`;
          await images.save(name, enc.blob);
          imageCount++;
          imageBytes += enc.blob.size;
          fpFile.set(enc.fingerprint, name);
          fpSize.set(enc.fingerprint, enc.blob.size);
        }
        imgBlocks.push({ page: pageNo, x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1, lines: [], image: name, imageW: p.width, imageH: p.height, imageKey: enc.fingerprint });
      }
    }

    const [ordered, columned] = readingOrder([...text, ...imgBlocks], width);
    if (columned) columnedPages++;
    pages.push(ordered);
    heights.push(height);
    page.cleanup();
    opts.onProgress?.(Math.round(((i + 1) / pageCount) * 85));
    if (i % 3 === 2) await yieldToUi();
  }

  const toc = await readToc(doc);

  // Images repeated on many pages are logos/decorations.
  const decorative = new Set([...fpPages].filter(([, c]) => c > 3).map(([fp]) => fp));
  for (const fp of decorative) {
    const name = fpFile.get(fp);
    if (name) {
      await images.remove(name);
      imageBytes -= fpSize.get(fp) ?? 0;
    }
  }
  for (let i = 0; i < pages.length; i++) pages[i] = pages[i].filter((b) => !(b.image && b.imageKey && decorative.has(b.imageKey)));

  removeRunningText(pages, heights);
  const [body, levels] = fontProfile(pages);
  let items: Item[] = [];
  for (const blocks of pages) for (const b of blocks) items.push(...blockItems(b, body, levels));
  items = mergePageBreaks(items);

  const chunks = buildChapters(items, toc, pageCount);
  const totalWords = items.reduce((n, it) => n + words(it.text), 0);
  const needsOcr = !opts.ocr && lowTextPages.length / pageCount >= 0.5;

  const warnings: string[] = [];
  if (garbledPages && !opts.ocr)
    warnings.push(`${garbledPages} página(s) têm o texto embutido ilegível (fontes sem codificação de caracteres); use o OCR para recuperá-lo.`);
  if (opts.ocr && ocrPages) warnings.push(`${ocrPages} página(s) foram lidas por OCR; o texto pode conter erros de reconhecimento.`);
  else if (lowTextPages.length && !opts.ocr && lowTextPages.length > garbledPages)
    warnings.push(`${lowTextPages.length} página(s) têm pouco ou nenhum texto extraível (possivelmente digitalizadas).`);
  if (columnedPages) warnings.push("O documento tem páginas em colunas; a ordem de leitura foi reconstruída e pode ter imperfeições.");
  if (capped) warnings.push("Nem todas as imagens foram extraídas (limite por livro atingido).");
  warnings.push("Tabelas, fórmulas e diagramas podem não ser reproduzidos fielmente; use o modo PDF para conferi-los.");

  const chapters: ChapterOut[] = chunks.map(([title, level, chunk], idx) => {
    const firstIsTitle = chunk.length > 0 && chunk[0].type === "heading";
    const sections = chunk
      .map((it, i) => ({ it, i }))
      .filter(({ it, i }) => it.type === "heading" && !(i === 0 && firstIsTitle))
      .map(({ it, i }) => ({ block: i, title: it.text.slice(0, 200), level: it.level }))
      .slice(0, 200);
    if (!title) title = firstIsTitle ? chunk[0].text.slice(0, 120) : `Capítulo ${idx + 1}`;
    return {
      index: idx,
      title: title.slice(0, 300),
      level,
      start_page: chunk[0].page,
      end_page: chunk[chunk.length - 1].page,
      block_count: chunk.length,
      word_count: chunk.reduce((n, it) => n + words(it.text), 0),
      sections,
      blocks: chunk.map(toJson),
    };
  });

  opts.onProgress?.(100);
  return { pageCount, chapters, wordCount: totalWords, needsOcr, ocrUsed: !!(opts.ocr && ocrPages), warnings, imageBytes };
}
