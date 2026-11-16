/**
 * OCR on the device with tesseract.js (WebAssembly). The engine, worker and language data are
 * bundled under /tesseract (scripts/copy-tesseract-assets.mjs), so it works offline and never
 * downloads anything at runtime. Loaded lazily: the ~10 MB engine is only fetched when OCR is used.
 */
import type { PDFPageProxy } from "pdfjs-dist";
import type { Worker } from "tesseract.js";

import { cleanText, type Line, type RawBlock } from "./heuristics";

export const OCR_DPI = 200;
const MIN_CONFIDENCE = 20;

let workerPromise: Promise<Worker> | null = null;

async function getWorker(): Promise<Worker> {
  workerPromise ??= (async () => {
    const { createWorker, OEM } = await import("tesseract.js");
    return createWorker(["por", "eng"], OEM.LSTM_ONLY, {
      workerPath: "/tesseract/worker.min.js",
      corePath: "/tesseract/core",
      langPath: "/tesseract/lang",
      gzip: false, // bundled uncompressed (see scripts/prepare-app-public.mjs)
      cacheMethod: "none", // the data already lives inside the app
      workerBlobURL: false,
    });
  })().catch((e) => {
    workerPromise = null;
    throw e;
  });
  return workerPromise;
}

/** Free the OCR engine's memory (tens of MB) once a book is done. */
export async function releaseOcr(): Promise<void> {
  const w = workerPromise;
  workerPromise = null;
  if (w) await (await w).terminate().catch(() => {});
}

/** Render the page in grayscale and OCR it. Coordinates come back in PDF points. */
export async function ocrBlocks(page: PDFPageProxy, pageNo: number): Promise<RawBlock[]> {
  const scale = OCR_DPI / 72;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  try {
    await page.render({ canvas, viewport }).promise;
    const worker = await getWorker();
    await worker.setParameters({ user_defined_dpi: String(OCR_DPI) });
    const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
    const k = 1 / scale;
    const blocks: RawBlock[] = [];
    for (const block of data.blocks ?? [])
      for (const par of block.paragraphs) {
        const lines: Line[] = [];
        for (const ln of par.lines) {
          const ws = ln.words.filter((w) => w.text.trim() && w.confidence >= MIN_CONFIDENCE);
          if (!ws.length) continue;
          const text = cleanText(ws.map((w) => w.text.trim()).join(" "));
          if (!text) continue;
          const heights = ws.map((w) => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
          const mid = heights.length >> 1;
          const median = heights.length % 2 ? heights[mid] : (heights[mid - 1] + heights[mid]) / 2;
          lines.push({
            text,
            x0: Math.min(...ws.map((w) => w.bbox.x0)) * k,
            y0: Math.min(...ws.map((w) => w.bbox.y0)) * k,
            x1: Math.max(...ws.map((w) => w.bbox.x1)) * k,
            y1: Math.max(...ws.map((w) => w.bbox.y1)) * k,
            // Word box height is ~0.75 of the font size for mixed-case text.
            size: Math.round(((median * k) / 0.75) * 2) / 2,
            bold: false,
          });
        }
        if (lines.length)
          blocks.push({
            page: pageNo,
            x0: Math.min(...lines.map((l) => l.x0)),
            y0: Math.min(...lines.map((l) => l.y0)),
            x1: Math.max(...lines.map((l) => l.x1)),
            y1: Math.max(...lines.map((l) => l.y1)),
            lines,
            ocr: true,
          });
      }
    return blocks;
  } finally {
    canvas.width = canvas.height = 0;
  }
}
