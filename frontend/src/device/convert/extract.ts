/**
 * Page geometry from pdf.js, shaped like PyMuPDF's get_text("dict") output so the shared
 * heuristics see the same thing on the phone and on the server: text runs are grouped into lines,
 * lines into blocks; images come with the box where they are painted.
 */
import { OPS, Util, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";
import type { TextItem, TextStyle } from "pdfjs-dist/types/src/display/api";

import { cleanText, type Line, type RawBlock, type TocEntry } from "./heuristics";

type Matrix = [number, number, number, number, number, number];

interface Run {
  text: string;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  baseline: number;
  size: number;
  bold: boolean;
}

interface FontInfo {
  bold?: boolean;
  black?: boolean;
  name?: string;
}

function fontIsBold(page: PDFPageProxy, fontName: string, cache: Map<string, boolean>): boolean {
  let bold = cache.get(fontName);
  if (bold !== undefined) return bold;
  bold = false;
  try {
    // Fonts are resolved in commonObjs once the page's operator list has been loaded.
    if (page.commonObjs.has(fontName)) {
      const f = page.commonObjs.get(fontName) as FontInfo;
      bold = !!(f.bold || f.black || /bold|black/i.test(f.name ?? ""));
    }
  } catch {
    /* unknown font: treat as regular */
  }
  cache.set(fontName, bold);
  return bold;
}

const half = (n: number) => Math.round(n * 2) / 2;

/** Text lines of one page, as RawBlocks in PDF points with y growing downwards. */
export async function textBlocks(page: PDFPageProxy, pageNo: number): Promise<RawBlock[]> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const styles = content.styles as Record<string, TextStyle>;
  const boldCache = new Map<string, boolean>();
  const runs: Run[] = [];
  for (const raw of content.items) {
    if (!("str" in raw)) continue;
    const item = raw as TextItem;
    if (!item.str || !item.str.trim()) {
      // Keep explicit spaces only as separators; they carry no geometry worth having.
      continue;
    }
    const m = Util.transform(viewport.transform, item.transform) as Matrix;
    const size = Math.hypot(m[2], m[3]);
    if (size < 1) continue;
    // Upright text only; rotated lines (margins, stamps) are usually not body text.
    if (Math.abs(m[1]) > size * 0.1 || Math.abs(m[2]) > size * 0.1 || m[0] <= 0) continue;
    const st = styles[item.fontName];
    const ascent = st && st.ascent > 0 && st.ascent < 2 ? st.ascent : 0.9;
    const descent = st && st.descent < 0 && st.descent > -1 ? st.descent : -0.2;
    const baseline = m[5];
    const x0 = m[4];
    const width = item.width * viewport.scale;
    runs.push({
      text: item.str,
      x0,
      x1: x0 + Math.max(width, 0),
      top: baseline - ascent * size,
      bottom: baseline - descent * size,
      baseline,
      size,
      bold: fontIsBold(page, item.fontName, boldCache),
    });
  }
  return groupBlocks(linesFromRuns(runs), pageNo);
}

/** Runs on the same baseline form a row; a wide horizontal gap (a column gutter) splits it. */
export function linesFromRuns(runs: Run[]): Line[] {
  const sorted = [...runs].sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0);
  const rows: Run[][] = [];
  for (const r of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(r.baseline - row[0].baseline) <= Math.max(row[0].size, r.size) * 0.35) row.push(r);
    else rows.push([r]);
  }
  const lines: Line[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x0 - b.x0);
    let seg: Run[] = [];
    const flush = () => {
      if (seg.length) lines.push(makeLine(seg));
      seg = [];
    };
    for (const r of row) {
      const prev = seg[seg.length - 1];
      if (prev && r.x0 - prev.x1 > Math.max(prev.size, r.size) * 1.5) flush();
      seg.push(r);
    }
    flush();
  }
  return lines.filter((l) => l.text);
}

function makeLine(seg: Run[]): Line {
  let text = "";
  for (let i = 0; i < seg.length; i++) {
    const r = seg[i];
    if (i > 0) {
      const prev = seg[i - 1];
      const gap = r.x0 - prev.x1;
      if (gap > Math.min(prev.size, r.size) * 0.15 && !/\s$/.test(text) && !/^\s/.test(r.text)) text += " ";
    }
    text += r.text;
  }
  // Dominant size and weight, weighted by characters (as the server does per span).
  const weights = new Map<number, number>();
  let boldChars = 0;
  let total = 0;
  for (const r of seg) {
    const n = r.text.trim().length;
    weights.set(half(r.size), (weights.get(half(r.size)) ?? 0) + n);
    if (r.bold) boldChars += n;
    total += n;
  }
  let size = half(seg[0].size);
  let best = -1;
  for (const [s, c] of weights) if (c > best) [size, best] = [s, c];
  return {
    text: cleanText(text),
    x0: Math.min(...seg.map((r) => r.x0)),
    y0: Math.min(...seg.map((r) => r.top)),
    x1: Math.max(...seg.map((r) => r.x1)),
    y1: Math.max(...seg.map((r) => r.bottom)),
    size,
    bold: boldChars / (total || 1) > 0.6,
  };
}

/** Consecutive lines that overlap horizontally and sit close together form a block. */
export function groupBlocks(lines: Line[], pageNo: number): RawBlock[] {
  const blocks: RawBlock[] = [];
  const sorted = [...lines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  for (const ln of sorted) {
    let target: RawBlock | null = null;
    for (const b of blocks) {
      const last = b.lines[b.lines.length - 1];
      const lh = Math.max(last.y1 - last.y0, 1);
      const gap = ln.y0 - last.y1;
      const overlap = Math.min(ln.x1, b.x1) - Math.max(ln.x0, b.x0);
      if (gap < lh * 0.9 && gap > -lh * 0.5 && overlap > 0 && (!target || last.y1 > target.lines[target.lines.length - 1].y1)) target = b;
    }
    if (target) {
      target.lines.push(ln);
      target.x0 = Math.min(target.x0, ln.x0);
      target.x1 = Math.max(target.x1, ln.x1);
      target.y1 = Math.max(target.y1, ln.y1);
    } else blocks.push({ page: pageNo, x0: ln.x0, y0: ln.y0, x1: ln.x1, y1: ln.y1, lines: [ln] });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Images

export interface ImagePlacement {
  objId: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  width: number;
  height: number;
}

/** Where each image XObject is painted on the page (walks the operator list tracking the CTM). */
export async function imagePlacements(page: PDFPageProxy): Promise<ImagePlacement[]> {
  const viewport = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList();
  const out: ImagePlacement[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as unknown[];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = Util.transform(ctm, args as Matrix) as Matrix;
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = args[0] as Matrix | null;
      if (m) ctm = Util.transform(ctm, m) as Matrix;
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
      const [objId, w, h] = args as [string, number, number];
      if (typeof objId !== "string") continue;
      const m = Util.transform(viewport.transform, ctm);
      const pts = [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      out.push({ objId, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), width: w, height: h });
    }
  }
  return out;
}

interface PdfImage {
  width: number;
  height: number;
  kind?: number;
  data?: Uint8ClampedArray | Uint8Array;
  bitmap?: ImageBitmap;
}

function imageObject(page: PDFPageProxy, objId: string): Promise<PdfImage | null> {
  const store = objId.startsWith("g_") ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), 10_000);
    try {
      store.get(objId, (img: PdfImage | null) => {
        window.clearTimeout(timer);
        resolve(img ?? null);
      });
    } catch {
      window.clearTimeout(timer);
      resolve(null);
    }
  });
}

const MAX_IMAGE_SIDE = 1800;

/** Decode an image painted on the page into a JPEG/PNG Blob plus a small fingerprint used to spot
 * logos repeated on many pages (the server compares PDF object numbers; pdf.js has no stable ids). */
export async function encodeImage(page: PDFPageProxy, objId: string): Promise<{ blob: Blob; fingerprint: string; png: boolean } | null> {
  const img = await imageObject(page, objId);
  if (!img || !img.width || !img.height) return null;
  const src = document.createElement("canvas");
  src.width = img.width;
  src.height = img.height;
  const ctx = src.getContext("2d");
  if (!ctx) return null;
  let png = false;
  if (img.bitmap) ctx.drawImage(img.bitmap, 0, 0);
  else if (img.data) {
    const rgba = toRgba(img);
    if (!rgba) return null;
    ctx.putImageData(new ImageData(rgba, img.width, img.height), 0, 0);
    png = img.kind === 1;
  } else return null;

  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.width, img.height));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(img.width * scale));
  out.height = Math.max(1, Math.round(img.height * scale));
  const octx = out.getContext("2d")!;
  octx.fillStyle = "#fff"; // JPEG has no alpha: transparent areas become white, not black
  octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(src, 0, 0, out.width, out.height);

  const tiny = document.createElement("canvas");
  tiny.width = 8;
  tiny.height = 8;
  const tctx = tiny.getContext("2d", { willReadFrequently: true })!;
  tctx.drawImage(src, 0, 0, 8, 8);
  const px = tctx.getImageData(0, 0, 8, 8).data;
  let fp = `${img.width}x${img.height}:`;
  for (let i = 0; i < px.length; i += 4) fp += ((px[i] >> 5) * 64 + (px[i + 1] >> 5) * 8 + (px[i + 2] >> 5)).toString(36);

  const blob = await new Promise<Blob | null>((res) => out.toBlob(res, png ? "image/png" : "image/jpeg", 0.85));
  src.width = src.height = out.width = out.height = 0;
  return blob ? { blob, fingerprint: fp, png } : null;
}

function toRgba(img: PdfImage): Uint8ClampedArray<ArrayBuffer> | null {
  const { width: w, height: h, kind, data } = img;
  if (!data) return null;
  const n = w * h;
  const out = new Uint8ClampedArray(n * 4);
  if (kind === 3 && data.length >= n * 4) out.set(data.subarray(0, n * 4));
  else if (kind === 2 && data.length >= n * 3) {
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      out[i * 4] = data[j];
      out[i * 4 + 1] = data[j + 1];
      out[i * 4 + 2] = data[j + 2];
      out[i * 4 + 3] = 255;
    }
  } else if (kind === 1) {
    // 1 bit per pixel, rows padded to whole bytes.
    const rowBytes = (w + 7) >> 3;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const k = (y * w + x) * 4;
        out[k] = out[k + 1] = out[k + 2] = v;
        out[k + 3] = 255;
      }
  } else return null;
  return out;
}

// ---------------------------------------------------------------------------
// Outline and metadata

/** Flattened outline in document order, with 1-based page numbers. */
export async function readToc(doc: PDFDocumentProxy): Promise<TocEntry[]> {
  const outline = await doc.getOutline().catch(() => null);
  if (!outline) return [];
  const out: TocEntry[] = [];
  type Node = (typeof outline)[number];
  const walk = async (nodes: Node[], level: number) => {
    for (const node of nodes) {
      let page = -1;
      try {
        const dest = typeof node.dest === "string" ? await doc.getDestination(node.dest) : node.dest;
        const ref = Array.isArray(dest) ? dest[0] : null;
        if (ref && typeof ref === "object") page = (await doc.getPageIndex(ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0])) + 1;
        else if (typeof ref === "number") page = ref + 1;
      } catch {
        /* broken destination */
      }
      out.push([level, node.title ?? "", page]);
      if (node.items?.length) await walk(node.items, level + 1);
    }
  };
  await walk(outline, 1);
  return out;
}

export function pageSize(page: PDFPageProxy): { width: number; height: number } {
  const vp = page.getViewport({ scale: 1 });
  return { width: vp.width, height: vp.height };
}
