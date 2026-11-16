/**
 * The phone must convert a PDF into the same book the server does: same chapters, same blocks, same
 * text. Otherwise a bookmark made on the website would land elsewhere in the app. The expected
 * output comes from the server converter (scripts/make-parity-fixtures.py).
 */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));

// Node has no DOM: use pdf.js's legacy build and its in-process worker.
vi.mock("pdfjs-dist", async () => import("pdfjs-dist/legacy/build/pdf.mjs"));
vi.mock("../../services/pdfjs", () => ({
  PDFJS_ASSETS: { standardFontDataUrl: join(pdfjsRoot, "standard_fonts") + "/", cMapUrl: join(pdfjsRoot, "cmaps") + "/", cMapPacked: true },
}));

const FIXTURES = join(import.meta.dirname, "__fixtures__");
const cases = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".pdf"))
  .map((f) => f.replace(/\.pdf$/, ""));

interface Expected {
  page_count: number;
  word_count: number;
  needs_ocr: boolean;
  chapters: { title: string; level: number; start_page: number; end_page: number; sections: unknown[]; blocks: unknown[] }[];
}

beforeAll(async () => {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(join(pdfjsRoot, "legacy", "build", "pdf.worker.mjs")).href;
});

describe("device converter matches the server converter", () => {
  it.each(cases)("%s", async (name: string) => {
    const { convertPdf, openPdf } = await import("./index");
    const bytes = readFileSync(join(FIXTURES, `${name}.pdf`));
    const expected = JSON.parse(readFileSync(join(FIXTURES, `${name}.expected.json`), "utf-8")) as Expected;

    const doc = await openPdf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const result = await convertPdf(doc, { ocr: false, maxPages: 500, maxImages: 0 }, { save: async () => {}, remove: async () => {} });
    await doc.loadingTask.destroy();

    expect(result.pageCount).toBe(expected.page_count);
    expect(result.needsOcr).toBe(expected.needs_ocr);
    expect(
      result.chapters.map((c) => ({ title: c.title, level: c.level, start_page: c.start_page, end_page: c.end_page, sections: c.sections, blocks: c.blocks })),
    ).toEqual(expected.chapters);
    expect(result.wordCount).toBe(expected.word_count);
  });
});
