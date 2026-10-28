import type { Block, Bookmark, Chapter, HighlightColor } from "../../services/types";

export interface Segment {
  text: string;
  mark?: { id: string; color: HighlightColor; note: boolean };
}

/** Character range of a highlight/note inside one block. */
export interface BlockRange {
  id: string;
  start: number;
  end: number;
  color: HighlightColor;
  note: boolean;
}

/** Ranges of the given highlights that fall inside block `index` (text length `len`). */
export function rangesForBlock(marks: Bookmark[], index: number, len: number): BlockRange[] {
  const out: BlockRange[] = [];
  for (const m of marks) {
    if (m.kind === "bookmark" || m.start_offset == null) continue;
    const endBlock = m.end_block_index ?? m.block_index;
    if (index < m.block_index || index > endBlock) continue;
    const start = index === m.block_index ? m.start_offset : 0;
    const end = index === endBlock ? (m.end_offset ?? len) : len;
    const s = Math.max(0, Math.min(len, start));
    const e = Math.max(0, Math.min(len, end));
    if (e > s) out.push({ id: m.id, start: s, end: e, color: m.color ?? "yellow", note: !!m.note });
  }
  return out;
}

/** Split text at highlight boundaries. Where highlights overlap, the later one wins. */
export function segment(text: string, ranges: BlockRange[]): Segment[] {
  if (!ranges.length) return [{ text }];
  const cuts = new Set<number>([0, text.length]);
  ranges.forEach((r) => {
    cuts.add(r.start);
    cuts.add(r.end);
  });
  const points = [...cuts].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    if (a === b) continue;
    let cover: BlockRange | undefined;
    for (const r of ranges) if (r.start <= a && r.end >= b) cover = r;
    const piece = text.slice(a, b);
    const prev = out[out.length - 1];
    if (prev && prev.mark?.id === cover?.id) prev.text += piece;
    else out.push(cover ? { text: piece, mark: { id: cover.id, color: cover.color, note: cover.note } } : { text: piece });
  }
  return out;
}

export function wordCount(text: string | null | undefined): number {
  if (!text) return 0;
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const space = text.charCodeAt(i) <= 32;
    if (!space && !inWord) n++;
    inWord = !space;
  }
  return n;
}

/** Percentage of the whole book read at (chapter, block, offset). */
export function percentAt(chapters: Chapter[], chapterIndex: number, blocks: Block[], blockIndex: number, offset: number): number {
  const total = chapters.reduce((s, c) => s + c.word_count, 0);
  if (!total) {
    const n = chapters.length || 1;
    return Math.min(100, ((chapterIndex + (blocks.length ? (blockIndex + offset) / blocks.length : 0)) / n) * 100);
  }
  let before = 0;
  for (const c of chapters) if (c.index < chapterIndex) before += c.word_count;
  for (let i = 0; i < blockIndex && i < blocks.length; i++) before += wordCount(blocks[i].text);
  before += wordCount(blocks[blockIndex]?.text) * offset;
  return Math.max(0, Math.min(100, (before / total) * 100));
}

/** Locate the chapter/block that holds a PDF page (used when the stored position belongs to an older
 *  content version, or when switching from PDF mode to Book mode). */
export function chapterForPage(chapters: Chapter[], page: number): number {
  const hit = chapters.find((c) => c.start_page <= page && page <= c.end_page);
  if (hit) return hit.index;
  const after = chapters.find((c) => c.start_page >= page);
  return after ? after.index : Math.max(0, chapters.length - 1);
}

export function blockForPage(blocks: Block[], page: number): number {
  const i = blocks.findIndex((b) => b.page >= page);
  return i === -1 ? Math.max(0, blocks.length - 1) : i;
}

/** Character offset of (node, offset) measured from the start of `root`'s text. */
export function textOffset(root: Node, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}
