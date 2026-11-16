/**
 * Opt-in tool (see scripts/compare-converters.py): converts every PDF in $PARITY_DIR with the device
 * converter and writes <name>.device.json for the report. Skipped when PARITY_DIR is not set.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));

vi.mock("pdfjs-dist", async () => import("pdfjs-dist/legacy/build/pdf.mjs"));
vi.mock("../../services/pdfjs", () => ({
  PDFJS_ASSETS: { standardFontDataUrl: join(pdfjsRoot, "standard_fonts") + "/", cMapUrl: join(pdfjsRoot, "cmaps") + "/", cMapPacked: true },
}));

const dir = process.env.PARITY_DIR;
const pdfs = dir ? readdirSync(dir).filter((f) => f.endsWith(".pdf")) : [];

describe.skipIf(!dir)("device converter on real PDFs", () => {
  it.each(pdfs)(
    "%s",
    async (file: string) => {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(join(pdfjsRoot, "legacy", "build", "pdf.worker.mjs")).href;
      const { convertPdf, openPdf } = await import("./index");
      const bytes = readFileSync(join(dir!, file));
      const started = performance.now();
      const doc = await openPdf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      const r = await convertPdf(doc, { ocr: false, maxPages: 2000, maxImages: 0 }, { save: async () => {}, remove: async () => {} });
      await doc.loadingTask.destroy();
      const out = {
        seconds: Math.round((performance.now() - started) / 10) / 100,
        page_count: r.pageCount,
        needs_ocr: r.needsOcr,
        word_count: r.wordCount,
        chapters: r.chapters.map((c) => ({ title: c.title, blocks: c.blocks })),
      };
      writeFileSync(join(dir!, file.replace(/\.pdf$/, ".device.json")), JSON.stringify(out));
    },
    600_000,
  );
});
