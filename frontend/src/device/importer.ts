/**
 * Importing and converting PDFs on the phone. One conversion runs at a time (like the server's OCR
 * queue) so memory stays bounded; the UI follows progress through the book record, exactly as it
 * follows a server job.
 */
import { ApiError } from "../services/http";
import type { Book, Toc } from "../services/types";
import { CONVERTER_VERSION, ConversionError, convertPdf, deviceContentVersion, openPdf, readPdfInfo } from "./convert";
import { cleanText, titleFromFilename } from "./convert/heuristics";
import * as db from "./db";
import { DEVICE_LIMITS } from "./limits";
import { deleteContent, enqueue, kick } from "./sync";


export class DuplicateBook extends ApiError {
  bookId: string;
  constructor(bookId: string) {
    super(409, "Você já importou este documento.", { detail: { message: "Você já importou este documento.", book_id: bookId } });
    this.bookId = bookId;
  }
}

async function sha256(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const now = () => new Date().toISOString();

/**
 * Validate and store a PDF on the device, then queue its conversion. Returns the new book.
 * `targetId` brings to this phone a book imported on another one: the record keeps its id, so its
 * progress and annotations carry over (the server checks it is the same file when it syncs).
 */
export async function importPdf(file: File, opts: { ocr: boolean; targetId?: string }): Promise<Book> {
  if (file.size === 0) throw new ApiError(400, "O arquivo está vazio.");
  if (file.size > DEVICE_LIMITS.maxBytes) throw new ApiError(413, `O arquivo excede o limite de ${DEVICE_LIMITS.maxBytes / 1024 / 1024} MB.`);
  const buf = await file.arrayBuffer();
  const head = new TextDecoder("latin1").decode(new Uint8Array(buf, 0, Math.min(1024, buf.byteLength))).replace(/^[\s\0]+/, "");
  if (!head.startsWith("%PDF-")) throw new ApiError(415, "O arquivo enviado não é um PDF válido.");

  const digest = await sha256(buf);
  const books = await db.all<Book>(db.STORES.books);
  const dup = books.find((b) => b.device?.sha256 === digest && b.id !== opts.targetId);
  if (dup) throw new DuplicateBook(dup.id);
  const target = opts.targetId ? books.find((b) => b.id === opts.targetId) : undefined;

  let doc;
  try {
    doc = await openPdf(buf);
  } catch (e) {
    throw new ApiError(422, e instanceof ConversionError ? e.message : "Não foi possível ler o PDF.");
  }
  const info = await readPdfInfo(doc).finally(() => void doc.loadingTask.destroy());
  if (info.pageCount === 0) throw new ApiError(422, "O PDF não possui páginas.");
  if (info.pageCount > DEVICE_LIMITS.maxPages) throw new ApiError(422, `O PDF tem ${info.pageCount} páginas; o limite é ${DEVICE_LIMITS.maxPages}.`);

  const filename = cleanText(file.name.split(/[\\/]/).pop() ?? "").slice(0, 255) || "documento.pdf";
  const book: Book = {
    id: target?.id ?? crypto.randomUUID(),
    title: target?.title ?? info.title ?? titleFromFilename(filename),
    author: target ? target.author : info.author,
    original_filename: filename,
    file_size: file.size,
    storage_mode: "device",
    page_count: info.pageCount,
    status: "pending",
    status_message: "Aguardando processamento",
    ocr_requested: opts.ocr,
    ocr_used: false,
    content_version: 0,
    chapter_count: 0,
    word_count: 0,
    warnings: [],
    created_at: target?.created_at ?? now(),
    updated_at: now(),
    last_opened_at: target?.last_opened_at ?? null,
    progress: target?.progress ?? null,
    job: job(opts.ocr, "queued", 0),
    device: { file: true, contentKey: null, contentBytes: 0, registered: false, sha256: digest },
  };
  await db.batch([db.STORES.books, db.STORES.files], (s) => {
    s(db.STORES.files).put(new Blob([buf], { type: "application/pdf" }), book.id);
    s(db.STORES.books).put(book, book.id);
  });
  queueConversion(book.id, opts.ocr);
  return book;
}

function job(ocr: boolean, status: NonNullable<Book["job"]>["status"], progress: number): NonNullable<Book["job"]> {
  return {
    kind: ocr ? "ocr" : "text",
    status,
    progress,
    attempts: status === "queued" ? 0 : 1,
    max_attempts: 1,
    created_at: now(),
    started_at: status === "queued" ? null : now(),
    finished_at: null,
  };
}

// ---------------------------------------------------------------------------
// Conversion queue

const queue: { bookId: string; ocr: boolean }[] = [];
let running = false;

export function queueConversion(bookId: string, ocr: boolean): void {
  if (queue.some((j) => j.bookId === bookId)) return;
  queue.push({ bookId, ocr });
  void pump();
}

export const isConverting = (bookId: string) => queue.some((j) => j.bookId === bookId) || current === bookId;
let current: string | null = null;

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const next = queue.shift()!;
      current = next.bookId;
      try {
        await convertOne(next.bookId, next.ocr);
      } catch (e) {
        console.error("PDBook: conversion failed", e);
      } finally {
        current = null;
      }
    }
    // Free the OCR engine (tens of MB) once the queue is empty.
    const { releaseOcr } = await import("./convert/ocr");
    await releaseOcr();
  } finally {
    running = false;
  }
}

// Progress updates are fired without waiting; the queue keeps them in order, so a late one can never
// land after the final status and leave the book "processing".
let writes: Promise<unknown> = Promise.resolve();

function update(id: string, patch: Partial<Book> | ((b: Book) => Partial<Book>)): Promise<Book | undefined> {
  const run = writes.then(() =>
    db.modify<Book>(db.STORES.books, id, (b) => (b ? { ...b, ...(typeof patch === "function" ? patch(b) : patch), updated_at: now() } : undefined)),
  );
  writes = run.catch(() => {});
  return run;
}

async function convertOne(bookId: string, ocr: boolean): Promise<void> {
  const book = await db.get<Book>(db.STORES.books, bookId);
  const file = await db.get<Blob>(db.STORES.files, bookId);
  if (!book || !book.device) return;
  if (!file) {
    await update(bookId, { status: book.device.contentKey ? book.status : "failed", status_message: "O PDF não está neste aparelho.", job: null });
    return;
  }
  const previousKey = book.device.contentKey;
  const key = `c${CONVERTER_VERSION}-${crypto.randomUUID().slice(0, 8)}`;
  await update(bookId, {
    status: "processing",
    status_message: ocr ? "Reconhecendo texto (OCR)…" : "Extraindo texto…",
    ocr_requested: ocr,
    job: job(ocr, "running", 0),
  });

  let lastPct = -1;
  let lastWrite = 0;
  const onProgress = (pct: number, message?: string) => {
    const t = Date.now();
    if (pct === lastPct || (t - lastWrite < 700 && pct < 100)) return;
    lastPct = pct;
    lastWrite = t;
    void update(bookId, { job: { ...job(ocr, "running", pct) }, ...(message ? { status_message: message } : {}) });
  };

  try {
    const doc = await openPdf(await file.arrayBuffer());
    let result;
    try {
      result = await convertPdf(
        doc,
        { ocr, maxPages: DEVICE_LIMITS.maxPages, onProgress },
        {
          save: (name, blob) => db.put(db.STORES.images, blob, `${key}:${name}`),
          remove: (name) => db.del(db.STORES.images, `${key}:${name}`),
        },
      );
    } finally {
      void doc.loadingTask.destroy();
    }

    const version = deviceContentVersion(ocr);
    const toc: Toc = {
      content_version: version,
      total_words: result.wordCount,
      chapters: result.chapters.map(({ blocks: _b, ...meta }) => meta),
    };
    let textBytes = 0;
    await db.batch([db.STORES.chapters, db.STORES.toc], (s) => {
      for (const ch of result.chapters) {
        const data = { index: ch.index, title: ch.title, content_version: version, blocks: ch.blocks };
        textBytes += JSON.stringify(data).length;
        s(db.STORES.chapters).put(data, `${key}:${ch.index}`);
      }
      s(db.STORES.toc).put(toc, key);
    });

    let status: Book["status"] = "ready";
    let message: string | null = null;
    if (result.needsOcr) {
      status = "needs_ocr";
      message =
        "O texto deste PDF não pôde ser extraído (documento digitalizado ou com fontes sem codificação). Leia no modo PDF ou use “Processar com OCR” para gerar o modo Livro.";
    } else if (!result.chapters.length) {
      status = "needs_ocr";
      message = "Nenhum texto foi encontrado no documento.";
    }
    const saved = await update(bookId, (fresh) => ({
      status,
      status_message: message,
      content_version: version,
      chapter_count: result.chapters.length,
      word_count: result.wordCount,
      warnings: result.warnings,
      ocr_used: result.ocrUsed,
      job: { ...job(ocr, "succeeded", 100), finished_at: now() },
      ...(fresh.device ? { device: { ...fresh.device, contentKey: key, contentBytes: textBytes + result.imageBytes } } : {}),
    }));
    if (!saved?.device) {
      await deleteContent(key); // deleted while converting
      return;
    }
    if (previousKey && previousKey !== key) await deleteContent(previousKey);
    if (saved) await enqueue(saved.device?.registered ? { kind: "content", bookId } : { kind: "register", bookId });
  } catch (e) {
    await deleteContent(key);
    const message = e instanceof ConversionError ? e.message : "A conversão falhou neste aparelho. O PDF original continua disponível.";
    // A previous successful version stays readable; only flag the book as failed if there is none.
    const after = await update(bookId, (b) => ({
      status: !b.device?.contentKey ? "failed" : b.chapter_count === 0 ? "needs_ocr" : "ready",
      status_message: message.slice(0, 500),
      job: { ...job(ocr, "failed", 0), finished_at: now() },
    }));
    if (after?.device && !after.device.registered) await enqueue({ kind: "register", bookId });
    else if (after?.device?.registered) await enqueue({ kind: "content", bookId });
    if (!(e instanceof ConversionError)) throw e;
  } finally {
    kick(200);
  }
}

/** Conversions cut short (app closed or killed) start again on the next launch. */
export async function resumeInterrupted(): Promise<void> {
  for (const b of await db.all<Book>(db.STORES.books)) {
    if (b.device?.file && (b.status === "pending" || b.status === "processing") && !isConverting(b.id)) queueConversion(b.id, b.ocr_requested);
  }
}

/** Reconvert a book stored on this phone (optionally with OCR). */
export async function reconvert(bookId: string, ocr: boolean): Promise<Book> {
  const b = await db.get<Book>(db.STORES.books, bookId);
  if (!b?.device?.file) throw new ApiError(409, "O PDF deste livro não está neste aparelho.");
  if (isConverting(bookId)) throw new ApiError(409, "Este livro já está sendo processado.");
  const next = (await update(bookId, { status: "pending", status_message: "Aguardando processamento", ocr_requested: ocr, job: job(ocr, "queued", 0) }))!;
  queueConversion(bookId, ocr);
  return next;
}
