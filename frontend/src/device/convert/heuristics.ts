/**
 * Layout heuristics that turn page geometry into reflowable book content.
 *
 * A line-by-line port of backend/app/converters/pdf.py, so a PDF converted on the phone has the same
 * structure (headings, paragraphs, chapters) as one converted by the server. Keep both in step: a
 * change here that alters the output must bump CONVERTER_VERSION (see ./index.ts).
 */

export const MAX_CHAPTER_BLOCKS = 1200;
export const MAX_CHAPTER_CHARS = 120_000;
export const FALLBACK_PAGES_PER_CHAPTER = 15;
const TERMINAL_PUNCT = [..."." + '!?:;"”»)…'];
export const BULLET_RE = /^\s*([•●▪◦‣∙·\-–—*]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s+/;
export const PAGE_NUMBER_RE = /^\W*((p(á|a)g(ina)?|page|p\.)\s*)?([0-9]{1,4}|[ivxlcdm]{1,7})(\s*(de|of|\/)\s*[0-9]{1,4})?\W*$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f­​﻿]/g;
const SPACE_RE = /\s+/g;
// Private Use Area: icon-font glyphs (warning signs, bullets) that have no meaning as text.
const PRIVATE_USE_RE = /[-]/g;

export interface Line {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  size: number;
  bold: boolean;
}

export interface RawBlock {
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  lines: Line[];
  image?: string;
  imageW?: number;
  imageH?: number;
  imageKey?: string;
  ocr?: boolean;
}

export type ItemType = "heading" | "paragraph" | "list_item" | "image";

export interface Item {
  type: ItemType;
  page: number;
  text: string;
  level: number;
  image?: string;
  width?: number;
  height?: number;
}

export interface OutBlock {
  type: ItemType;
  page: number;
  text?: string;
  level?: number;
  image?: string;
  width?: number;
  height?: number;
}

export function toJson(it: Item): OutBlock {
  const d: OutBlock = { type: it.type, page: it.page };
  if (it.type === "image") Object.assign(d, { image: it.image, width: it.width, height: it.height });
  else d.text = it.text;
  if (it.type === "heading") d.level = it.level;
  return d;
}

export const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

// ---------------------------------------------------------------------------
// Character classes (Python str methods)

const isAlpha = (c: string) => /\p{L}/u.test(c);
const isAlnum = (c: string) => /[\p{L}\p{N}]/u.test(c);
const isLower = (c: string) => c !== c.toUpperCase() && c === c.toLowerCase();
const isUpper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();
const isSpace = (c: string) => /\s/u.test(c);
export const hasAlpha = (text: string) => /\p{L}/u.test(text);

// ---------------------------------------------------------------------------
// Text helpers

export function cleanText(text: string): string {
  return text.normalize("NFC").replace(CONTROL_RE, "").replace(PRIVATE_USE_RE, "").replace(SPACE_RE, " ").trim();
}

export function joinLines(parts: string[]): string {
  let out = "";
  for (let part of parts) {
    part = part.trim();
    if (!part) continue;
    if (!out) out = part;
    else if (out.endsWith("-") && out.length > 1 && isAlpha(out[out.length - 2]) && isLower(part.slice(0, 1))) out = out.slice(0, -1) + part;
    else out += " " + part;
  }
  return out;
}

export const endsSentence = (text: string) => TERMINAL_PUNCT.some((p) => text.trimEnd().endsWith(p));

/** False when the text layer is mostly symbols: fonts without a Unicode mapping. */
export function isReadable(blocks: RawBlock[]): boolean {
  let total = 0;
  let letters = 0;
  for (const b of blocks)
    for (const ln of b.lines)
      for (const c of ln.text) {
        if (isSpace(c)) continue;
        total++;
        if (isAlnum(c)) letters++;
      }
  return total === 0 || letters / total >= 0.5;
}

export function isCapsTitle(text: string): boolean {
  const letters = [...text].filter(isAlpha);
  return (
    letters.length >= 4 &&
    text.length <= 60 &&
    text.split(/\s+/).filter(Boolean).length <= 6 &&
    letters.filter(isUpper).length / letters.length >= 0.9 &&
    ![".", ",", ";"].some((p) => text.trimEnd().endsWith(p))
  );
}

const normRunning = (text: string) => text.toLowerCase().replace(/\d+/g, "#").trim();

export function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Folded heading without its section number: "2.1 Attention" matches the outline's "Attention". */
export const foldTitle = (text: string) => fold(text).replace(/^(\d+ )+/, "");

/** Lower-case and strip accents keeping a 1:1 character mapping (search offsets stay valid). */
export function foldSearch(text: string): string {
  let out = "";
  for (const c of text) {
    const base = c.normalize("NFD")[0]?.toLowerCase() ?? c;
    out += base.length === c.length ? base : c;
  }
  return out;
}

function mostCommon(counts: Map<number, number>): number | undefined {
  let best: number | undefined;
  let bestCount = -1;
  for (const [k, v] of counts) if (v > bestCount) [best, bestCount] = [k, v];
  return best;
}

// ---------------------------------------------------------------------------
// Layout analysis

/** Order blocks top-to-bottom, reading the left column before the right one on two-column pages. */
export function readingOrder(blocks: RawBlock[], pageWidth: number): [RawBlock[], boolean] {
  const mid = pageWidth / 2;
  const tol = pageWidth * 0.03;
  const side = (b: RawBlock) => (b.x1 <= mid + tol ? "L" : b.x0 >= mid - tol ? "R" : "F");
  const sides = blocks.map(side);
  const columned = sides.filter((s) => s === "L").length >= 2 && sides.filter((s) => s === "R").length >= 2;
  if (!columned) return [[...blocks].sort((a, b) => Math.round(a.y0) - Math.round(b.y0) || a.x0 - b.x0), false];

  const ordered: RawBlock[] = [];
  let segment: RawBlock[] = [];
  const flush = () => {
    ordered.push(...segment.filter((b) => side(b) === "L").sort((a, b) => a.y0 - b.y0));
    ordered.push(...segment.filter((b) => side(b) === "R").sort((a, b) => a.y0 - b.y0));
    segment = [];
  };
  for (const b of [...blocks].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)) {
    if (side(b) === "F") {
      flush();
      ordered.push(b);
    } else segment.push(b);
  }
  flush();
  return [ordered, true];
}

/** Drop headers/footers that repeat across pages, and bare page numbers in the margins. */
export function removeRunningText(pages: RawBlock[][], heights: number[]): void {
  const n = pages.length;
  const counts = new Map<string, number>();
  pages.forEach((blocks, i) => {
    const h = heights[i];
    const seen = new Set<string>();
    for (const b of blocks) for (const ln of b.lines) if (ln.y1 < h * 0.1 || ln.y0 > h * 0.9) seen.add(normRunning(ln.text));
    for (const t of seen) counts.set(t, (counts.get(t) ?? 0) + 1);
  });
  const threshold = Math.max(3, Math.floor(n * 0.3));
  const repeated = new Set([...counts].filter(([t, c]) => c >= threshold && t).map(([t]) => t));
  pages.forEach((blocks, i) => {
    const h = heights[i];
    const kept: RawBlock[] = [];
    for (const b of blocks) {
      if (b.image) {
        kept.push(b);
        continue;
      }
      b.lines = b.lines.filter((ln) => !((ln.y1 < h * 0.1 || ln.y0 > h * 0.9) && (repeated.has(normRunning(ln.text)) || PAGE_NUMBER_RE.test(ln.text))));
      if (b.lines.length) kept.push(b);
    }
    pages[i] = kept;
  });
}

export function fontProfile(pages: RawBlock[][]): [number, Map<number, number>] {
  const sizes = new Map<number, number>();
  for (const blocks of pages) for (const b of blocks) for (const ln of b.lines) sizes.set(ln.size, (sizes.get(ln.size) ?? 0) + ln.text.length);
  if (!sizes.size) return [11, new Map()];
  const body = mostCommon(sizes)!;
  const headingSizes = [...sizes].filter(([s, c]) => s >= body * 1.2 && c >= 3).map(([s]) => s).sort((a, b) => b - a);
  return [body, new Map(headingSizes.map((s, i) => [s, Math.min(i + 1, 3)]))];
}

export function blockItems(b: RawBlock, body: number, levels: Map<number, number>): Item[] {
  if (b.image) return [{ type: "image", page: b.page, text: "", level: 0, image: b.image, width: b.imageW, height: b.imageH }];

  const items: Item[] = [];
  // OCR line heights are noisy (caps vs. lowercase words), so only clearly bigger text counts.
  const sizeFactor = b.ocr ? 1.6 : 1.2;
  const groups: [number, Line[]][] = [];
  for (const ln of b.lines) {
    let lvl = 0;
    if (ln.size >= body * sizeFactor && ln.text.length <= 150 && hasAlpha(ln.text)) lvl = levels.get(ln.size) || 3;
    const last = groups[groups.length - 1];
    if (last && last[0] === lvl) last[1].push(ln);
    else groups.push([lvl, [ln]]);
  }

  for (const [lvl, groupLines] of groups) {
    let lines = groupLines;
    const text = joinLines(lines.map((l) => l.text));
    if (lvl && lines.length <= 3) {
      items.push({ type: "heading", page: b.page, text, level: lvl });
      continue;
    }
    // A short standalone line in capitals ("PRIMEIRA NOITE") is a section title.
    if (groups.length === 1 && lines.length <= 2 && isCapsTitle(text)) {
      items.push({ type: "heading", page: b.page, text, level: b.ocr ? 1 : 2 });
      continue;
    }
    // Tesseract sometimes glues a title line to the paragraph below it.
    if (b.ocr && lines.length > 1 && isCapsTitle(lines[0].text)) {
      items.push({ type: "heading", page: b.page, text: lines[0].text, level: 1 });
      lines = lines.slice(1);
    }
    // A short, fully bold block at body size reads as a minor heading.
    if (groups.length === 1 && lines.length <= 2 && lines.every((l) => l.bold) && text.length <= 100 && !endsSentence(text) && hasAlpha(text)) {
      items.push({ type: "heading", page: b.page, text, level: 3 });
      continue;
    }
    items.push(...paragraphs(lines, b, body));
  }
  return items;
}

function paragraphs(lines: Line[], b: RawBlock, body: number): Item[] {
  const width = Math.max(b.x1 - b.x0, 1);
  const paras: Line[][] = [[lines[0]]];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const ln = lines[i];
    const gap = ln.y0 - prev.y1;
    const lh = Math.max(prev.y1 - prev.y0, 1);
    const fresh =
      gap > lh * 0.8 || BULLET_RE.test(ln.text) || (endsSentence(prev.text) && (ln.x0 - b.x0 > body * 0.9 || prev.x1 < b.x1 - width * 0.15));
    if (fresh) paras.push([ln]);
    else paras[paras.length - 1].push(ln);
  }
  const out: Item[] = [];
  for (const p of paras) {
    const text = joinLines(p.map((l) => l.text));
    if (text) out.push({ type: BULLET_RE.test(text) ? "list_item" : "paragraph", page: b.page, text, level: 0 });
  }
  return out;
}

export function mergePageBreaks(items: Item[]): Item[] {
  const out: Item[] = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (
      prev &&
      it.type === "paragraph" &&
      prev.type === "paragraph" &&
      it.page === prev.page + 1 &&
      !endsSentence(prev.text) &&
      (isLower(it.text.slice(0, 1)) || prev.text.endsWith(",") || prev.text.endsWith("-"))
    ) {
      prev.text = joinLines([prev.text, it.text]);
      continue;
    }
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chapters

/** [level, title, page] in document order, like PyMuPDF's get_toc(simple=True). */
export type TocEntry = [number, string, number];
type SplitPoint = [number, string, number]; // item index, title, level

function splitPointsFromToc(toc: TocEntry[], items: Item[], pageCount: number): SplitPoint[] {
  const entries = toc.map(([lvl, title, page]) => [lvl, cleanText(title), page] as TocEntry).filter(([, title, page]) => page >= 1 && page <= pageCount && title);
  if (!entries.length) return [];
  const top = Math.min(...entries.map((e) => e[0]));
  let chosen = entries.filter((e) => e[0] === top);
  if (chosen.length < 2) chosen = entries.filter((e) => e[0] <= top + 1);
  if (chosen.length < 2) return [];
  const points: SplitPoint[] = [];
  let last = -1;
  for (const [lvl, title, page] of chosen) {
    const folded = foldTitle(title);
    let idx: number | null = null;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.page < page || i <= last) continue;
      if (it.page > page) break;
      const head = it.type === "heading" ? foldTitle(it.text) : "";
      if (head && folded && (head.startsWith(folded.slice(0, 40)) || folded.startsWith(head.slice(0, 40)))) {
        idx = i;
        break;
      }
    }
    if (idx === null) {
      const found = items.findIndex((it, i) => it.page >= page && i > last);
      idx = found === -1 ? null : found;
    }
    if (idx === null) continue;
    points.push([idx, title, lvl - top + 1]);
    last = idx;
  }
  return points;
}

function splitPointsFromHeadings(items: Item[], pageCount: number): SplitPoint[] {
  for (const maxLevel of [1, 2]) {
    const heads: SplitPoint[] = [];
    items.forEach((it, i) => it.type === "heading" && it.level <= maxLevel && heads.push([i, it.text, it.level]));
    if (heads.length >= 2 && heads.length <= Math.max(8, pageCount * 1.5)) return heads;
  }
  return [];
}

function splitPointsByPages(items: Item[]): SplitPoint[] {
  const points: SplitPoint[] = [];
  let nextPage = 1;
  items.forEach((it, i) => {
    if (it.page >= nextPage) {
      points.push([i, "", 1]);
      nextPage = it.page + FALLBACK_PAGES_PER_CHAPTER;
    }
  });
  return points;
}

export type ChapterChunk = [string, number, Item[]];

export function buildChapters(items: Item[], toc: TocEntry[], pageCount: number): ChapterChunk[] {
  if (!items.length) return [];
  let points = splitPointsFromToc(toc, items, pageCount);
  if (!points.length) points = splitPointsFromHeadings(items, pageCount);
  const byPages = !points.length;
  if (byPages) points = splitPointsByPages(items);

  const chapters: ChapterChunk[] = [];
  if (points[0][0] > 0) chapters.push(["Início", 1, items.slice(0, points[0][0])]);
  points.forEach(([start, title, level], n) => {
    const end = n + 1 < points.length ? points[n + 1][0] : items.length;
    const chunk = items.slice(start, end);
    if (byPages && chunk[0].type === "heading") title = chunk[0].text.slice(0, 120);
    else if (byPages) {
      const a = chunk[0].page;
      const b = chunk[chunk.length - 1].page;
      title = a !== b ? `Páginas ${a}–${b}` : `Página ${a}`;
    }
    chapters.push([title, level, chunk]);
  });

  // A chapter holding only headings (e.g. "Parte I") is folded into the next one.
  const merged: ChapterChunk[] = [];
  let carry: Item[] = [];
  chapters.forEach(([title, level, c], n) => {
    const chunk = [...carry, ...c];
    carry = [];
    if (n + 1 < chapters.length && chunk.length <= 3 && chunk.every((it) => it.type === "heading")) {
      carry = chunk;
      return;
    }
    merged.push([title, level, chunk]);
  });

  // Keep each chapter small enough to load quickly on a phone.
  const sized: ChapterChunk[] = [];
  for (const [title, level, chunk] of merged) {
    const parts: Item[][] = [[]];
    let chars = 0;
    for (const it of chunk) {
      const cur = parts[parts.length - 1];
      if (cur.length && (cur.length >= MAX_CHAPTER_BLOCKS || chars >= MAX_CHAPTER_CHARS)) {
        parts.push([]);
        chars = 0;
      }
      parts[parts.length - 1].push(it);
      chars += it.text.length;
    }
    parts.forEach((part, k) => sized.push([k === 0 ? title : `${title} (parte ${k + 1})`, level, part]));
  }
  return sized;
}

// ---------------------------------------------------------------------------
// Metadata

const unescapeOctal = (text: string) => text.replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)));

/** "(Microsoft Word - Fi\363dor - Noites brancas.doc)" -> "Fiódor - Noites brancas"; null for placeholders. */
export function cleanTitle(raw: string | null | undefined): string | null {
  let title = cleanText(unescapeOctal(raw ?? "")).replace(/^[() ]+|[() ]+$/g, "");
  title = title.replace(/^microsoft (word|powerpoint|excel)\s*-\s*/i, "");
  title = title.replace(/\.(docx?|odt|rtf|pptx?|tex|pdf)$/i, "").trim();
  if (!title || /^(untitled|sem t[ií]tulo|document\d*|documento\d*)$/i.test(title)) return null;
  return title.slice(0, 300);
}

export const cleanAuthor = (raw: string | null | undefined) => cleanText(unescapeOctal(raw ?? "")).slice(0, 300) || null;

export function titleFromFilename(name: string): string {
  const stem = name.replace(/\.pdf$/i, "").replace(/_+/g, " ");
  return cleanText(stem).slice(0, 300) || "Documento sem título";
}
