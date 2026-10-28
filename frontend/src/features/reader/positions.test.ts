import { describe, expect, it } from "vitest";

import type { Block, Bookmark, Chapter } from "../../services/types";
import { blockForPage, chapterForPage, percentAt, rangesForBlock, segment, wordCount } from "./positions";

const mark = (over: Partial<Bookmark>): Bookmark => ({
  id: "h1",
  kind: "highlight",
  content_version: 1,
  chapter_index: 0,
  block_index: 0,
  start_offset: 0,
  end_block_index: null,
  end_offset: 5,
  page: 1,
  quote: null,
  note: null,
  color: "yellow",
  created_at: "",
  updated_at: "",
  ...over,
});

const chapter = (index: number, words: number, start: number, end: number): Chapter => ({
  index,
  title: `C${index}`,
  level: 1,
  start_page: start,
  end_page: end,
  block_count: 2,
  word_count: words,
  sections: [],
});

describe("highlight segmentation", () => {
  it("splits a block around a highlight", () => {
    const segs = segment("Olá mundo bonito", rangesForBlock([mark({ start_offset: 4, end_offset: 9 })], 0, 16));
    expect(segs.map((s) => [s.text, s.mark?.id ?? null])).toEqual([
      ["Olá ", null],
      ["mundo", "h1"],
      [" bonito", null],
    ]);
  });

  it("handles highlights spanning several blocks", () => {
    const m = mark({ block_index: 1, start_offset: 3, end_block_index: 3, end_offset: 2 });
    expect(rangesForBlock([m], 0, 10)).toEqual([]);
    expect(rangesForBlock([m], 1, 10)[0]).toMatchObject({ start: 3, end: 10 });
    expect(rangesForBlock([m], 2, 8)[0]).toMatchObject({ start: 0, end: 8 });
    expect(rangesForBlock([m], 3, 8)[0]).toMatchObject({ start: 0, end: 2 });
  });

  it("lets the later of two overlapping highlights win and ignores plain bookmarks", () => {
    const a = mark({ id: "a", start_offset: 0, end_offset: 6 });
    const b = mark({ id: "b", start_offset: 3, end_offset: 9, color: "blue" });
    const bm = mark({ id: "c", kind: "bookmark", start_offset: null });
    const segs = segment("abcdefghij", rangesForBlock([a, b, bm], 0, 10));
    expect(segs.map((s) => [s.text, s.mark?.id ?? null])).toEqual([
      ["abc", "a"],
      ["defghi", "b"],
      ["j", null],
    ]);
  });
});

describe("progress", () => {
  const chapters = [chapter(0, 10, 1, 2), chapter(1, 10, 3, 5)];
  const blocks: Block[] = [
    { type: "paragraph", page: 3, text: "um dois três quatro cinco" },
    { type: "paragraph", page: 4, text: "seis sete oito nove dez" },
  ];

  it("counts words", () => {
    expect(wordCount("  um  dois\ntrês ")).toBe(3);
    expect(wordCount(null)).toBe(0);
  });

  it("computes the book percentage from chapter, block and offset", () => {
    expect(percentAt(chapters, 0, [], 0, 0)).toBe(0);
    expect(percentAt(chapters, 1, blocks, 0, 0)).toBe(50);
    expect(percentAt(chapters, 1, blocks, 1, 0.4)).toBe(85);
  });

  it("maps a PDF page to chapter and block", () => {
    expect(chapterForPage(chapters, 4)).toBe(1);
    expect(chapterForPage(chapters, 99)).toBe(1);
    expect(blockForPage(blocks, 4)).toBe(1);
  });
});
