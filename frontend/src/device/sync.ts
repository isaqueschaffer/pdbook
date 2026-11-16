/**
 * Two-way sync between the phone and the PDBook server.
 *
 * Writes are local first: the app saves to IndexedDB, then queues an operation in the outbox. The
 * outbox is replayed in order whenever the server is reachable; every operation is idempotent
 * (client-generated ids, timestamped progress), so a replay after a dropped connection is harmless.
 * Pulls refresh the local copy of the library from the server, never touching books that still
 * have queued changes.
 */
import { ApiError, isNetworkError, request } from "../services/http";
import type { Book, Bookmark, Preferences, Progress } from "../services/types";
import * as db from "./db";

export type Op =
  | { kind: "register"; bookId: string }
  | { kind: "content"; bookId: string }
  | { kind: "meta"; bookId: string; data: { title?: string; author?: string | null } }
  | { kind: "delete"; bookId: string }
  | { kind: "progress"; bookId: string }
  | { kind: "bm-create"; bookId: string; bookmark: Bookmark }
  | { kind: "bm-update"; bookId: string; bookmarkId: string; data: { note?: string | null; color?: string } }
  | { kind: "bm-delete"; bookId: string; bookmarkId: string }
  | { kind: "prefs" };

type Queued = Op & { seq: number };

const listeners = new Set<() => void>();
/** Called after a sync changed local data, so the UI can refresh. */
export function onSyncChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const notify = () => listeners.forEach((cb) => cb());

export async function enqueue(op: Op): Promise<void> {
  // Only the latest progress / preferences matter: keep a single queued entry for each.
  if (op.kind === "progress" || op.kind === "prefs" || op.kind === "content") {
    const queued = await db.all<Queued>(db.STORES.outbox);
    if (queued.some((q) => q.kind === op.kind && ("bookId" in op ? "bookId" in q && q.bookId === op.bookId : true))) {
      kick();
      return;
    }
  }
  await db.put(db.STORES.outbox, op);
  kick();
}

export async function pendingBookIds(): Promise<Set<string>> {
  const queued = await db.all<Queued>(db.STORES.outbox);
  return new Set(queued.flatMap((q) => ("bookId" in q ? [q.bookId] : [])));
}

/** Drop queued operations of a book that never reached the server (deleted before its first sync). */
export async function dropOpsFor(bookId: string): Promise<void> {
  for (const q of await db.all<Queued>(db.STORES.outbox)) if ("bookId" in q && q.bookId === bookId) await db.del(db.STORES.outbox, q.seq);
}

// ---------------------------------------------------------------------------
// Outbox replay

let flushing: Promise<void> | null = null;
let kickTimer: number | undefined;

/** Schedule a flush shortly (coalesces bursts of writes, e.g. a reading session). */
export function kick(delay = 800): void {
  window.clearTimeout(kickTimer);
  kickTimer = window.setTimeout(() => void flush().catch(() => {}), delay);
}

export function flush(): Promise<void> {
  flushing ??= (async () => {
    try {
      let changed = false;
      let after = 0;
      // Re-read the queue before each operation: a registration may have moved the following ones
      // to another book id (rekey), and the reader may have queued more meanwhile.
      for (;;) {
        const op = (await db.all<Queued>(db.STORES.outbox, IDBKeyRange.lowerBound(after, true)))[0];
        if (!op) break;
        after = op.seq;
        try {
          changed = (await apply(op)) || changed;
          await db.del(db.STORES.outbox, op.seq);
        } catch (e) {
          // Offline, signed out or server trouble: keep the op and retry later.
          if (isNetworkError(e) || (e instanceof ApiError && (e.status === 401 || e.status === 429 || e.status >= 500))) break;
          // Rejected for good (validation, gone...): drop it so the queue never gets stuck.
          console.warn("PDBook: dropping sync operation", op.kind, e);
          await db.del(db.STORES.outbox, op.seq);
        }
      }
      if (changed) notify();
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

const isGone = (e: unknown) => e instanceof ApiError && e.status === 404;

async function apply(op: Queued): Promise<boolean> {
  switch (op.kind) {
    case "register":
      return register(op.bookId);
    case "content": {
      const b = await db.get<Book>(db.STORES.books, op.bookId);
      if (!b?.device?.registered) return false;
      await request(`/books/${op.bookId}/device-content`, { method: "PUT", json: contentPayload(b) });
      return false;
    }
    case "meta": {
      const saved = await request<Book>(`/books/${op.bookId}`, { method: "PATCH", json: op.data }).catch((e) => (isGone(e) ? null : Promise.reject(e)));
      if (saved) await mergeServerBook(saved);
      return !!saved;
    }
    case "delete":
      await request(`/books/${op.bookId}`, { method: "DELETE" }).catch((e) => (isGone(e) ? null : Promise.reject(e)));
      return false;
    case "progress": {
      const p = await db.get<Progress>(db.STORES.progress, op.bookId);
      if (p) await request(`/books/${op.bookId}/progress`, { method: "PUT", json: p });
      return false;
    }
    case "bm-create": {
      const b = op.bookmark;
      await request(`/books/${op.bookId}/bookmarks`, {
        method: "POST",
        json: {
          id: b.id,
          kind: b.kind,
          content_version: b.content_version,
          chapter_index: b.chapter_index,
          block_index: b.block_index,
          start_offset: b.start_offset,
          end_block_index: b.end_block_index,
          end_offset: b.end_offset,
          page: b.page,
          quote: b.quote,
          note: b.note,
          color: b.color,
        },
      });
      return false;
    }
    case "bm-update":
      await request(`/books/${op.bookId}/bookmarks/${op.bookmarkId}`, { method: "PATCH", json: op.data }).catch((e) => (isGone(e) ? null : Promise.reject(e)));
      return false;
    case "bm-delete":
      await request(`/books/${op.bookId}/bookmarks/${op.bookmarkId}`, { method: "DELETE" }).catch((e) => (isGone(e) ? null : Promise.reject(e)));
      return false;
    case "prefs": {
      const prefs = await db.get<Preferences>(db.STORES.kv, "preferences");
      if (prefs) await request("/preferences", { method: "PUT", json: prefs });
      return false;
    }
  }
}

export function contentPayload(b: Book) {
  return {
    status: b.status === "ready" || b.status === "needs_ocr" ? b.status : "failed",
    status_message: b.status_message,
    content_version: b.content_version,
    chapter_count: b.chapter_count,
    word_count: b.word_count,
    ocr_requested: b.ocr_requested,
    ocr_used: b.ocr_used,
    warnings: b.warnings.slice(0, 20),
  };
}

async function register(bookId: string): Promise<boolean> {
  let localId = bookId;
  const b = await db.get<Book>(db.STORES.books, localId);
  const device = b?.device;
  if (!b || !device || device.registered) return false;
  if (b.status === "pending" || b.status === "processing") {
    // Still converting: the conversion re-queues the registration when it ends.
    return false;
  }
  const body = (id: string) => ({
    method: "POST",
    json: {
      id,
      sha256: device.sha256,
      title: b.title,
      author: b.author,
      original_filename: b.original_filename,
      file_size: b.file_size,
      page_count: b.page_count,
      content: contentPayload(b),
    },
  });
  let saved: Book;
  try {
    saved = await request<Book>("/books/device", body(localId));
  } catch (e) {
    // The id is taken by a different file: the user brought a different PDF to a book from another
    // phone. It becomes a book of its own; the original comes back with the next pull.
    if (!(e instanceof ApiError && e.status === 409)) throw e;
    const fresh = crypto.randomUUID();
    await rekey(localId, fresh, false);
    localId = fresh;
    saved = await request<Book>("/books/device", body(fresh));
  }
  // The same PDF was already in the account (imported on another device): adopt that book, so its
  // progress and annotations follow, and move what this phone has under the server's id.
  if (saved.id !== localId) await rekey(localId, saved.id);
  await db.modify<Book>(db.STORES.books, saved.id, (local) =>
    local?.device
      ? {
          ...local,
          title: saved.title,
          author: saved.author,
          created_at: saved.created_at,
          device: { ...local.device, registered: true },
          progress: newer(local.progress, saved.progress),
        }
      : undefined,
  );
  return true;
}

const ts = (s?: string | null) => (s ? Date.parse(s) : 0);
function newer<T extends { updated_at?: string } | null | undefined>(a: T, b: T): T {
  return ts(a?.updated_at) >= ts(b?.updated_at) ? a : b;
}

/** Move the local records of a book to another id. `carryReading` false leaves the progress and
 * annotations behind: they belong to the book that owned the old id. */
async function rekey(from: string, to: string, carryReading = true): Promise<void> {
  const book = await db.get<Book>(db.STORES.books, from);
  const existing = await db.get<Book>(db.STORES.books, to);
  const file = await db.get<Blob>(db.STORES.files, from);
  const progress = carryReading ? await db.get<Progress>(db.STORES.progress, from) : undefined;
  const oldProgress = await db.get<Progress>(db.STORES.progress, to);
  const marks = carryReading ? await db.byIndex<Bookmark & { book_id: string }>(db.STORES.bookmarks, "book", from) : [];
  const ops = (await db.all<Queued>(db.STORES.outbox)).filter(
    (q) => "bookId" in q && q.bookId === from && (carryReading || q.kind === "register" || q.kind === "content" || q.kind === "meta"),
  );
  await db.batch([db.STORES.books, db.STORES.files, db.STORES.progress, db.STORES.bookmarks, db.STORES.outbox], (s) => {
    if (book) {
      const moved = carryReading ? book : { ...book, progress: null, last_opened_at: null };
      s(db.STORES.books).put({ ...existing, ...moved, id: to, created_at: existing?.created_at ?? book.created_at }, to);
      s(db.STORES.books).delete(from);
    }
    if (file) {
      s(db.STORES.files).put(file, to);
      s(db.STORES.files).delete(from);
    }
    if (progress) {
      s(db.STORES.progress).put(newer(progress, oldProgress), to);
      s(db.STORES.progress).delete(from);
    }
    for (const m of marks) s(db.STORES.bookmarks).put({ ...m, book_id: to });
    for (const q of ops) s(db.STORES.outbox).put({ ...q, bookId: to });
  });
  // The table of contents, chapters and images are keyed by the content key, not the book id.
}

// ---------------------------------------------------------------------------
// Pull

/** Merge a book from the server into the local library, keeping what only this phone knows. */
export async function mergeServerBook(sb: Book): Promise<void> {
  await db.modify<Book>(db.STORES.books, sb.id, (local) => merge(sb, local));
}

function merge(sb: Book, local: Book | undefined): Book {
  const device = local?.device ?? (sb.storage_mode === "device" ? { file: false, contentKey: null, contentBytes: 0, registered: true } : undefined);
  let merged: Book = { ...sb, device };
  if (local?.device?.contentKey) {
    // This phone converted the book itself: its own conversion is what it shows.
    merged = {
      ...merged,
      status: local.status,
      status_message: local.status_message,
      content_version: local.content_version,
      chapter_count: local.chapter_count,
      word_count: local.word_count,
      warnings: local.warnings,
      ocr_used: local.ocr_used,
      ocr_requested: local.ocr_requested,
      job: local.job,
    };
  }
  merged.progress = newer(local?.progress ?? null, sb.progress);
  merged.last_opened_at = ts(local?.last_opened_at) > ts(sb.last_opened_at) ? (local?.last_opened_at ?? null) : sb.last_opened_at;
  return merged;
}

async function pullLibrary(): Promise<void> {
  const remote: Book[] = [];
  for (let page = 1; page < 1000; page++) {
    const res = await request<{ items: Book[]; total: number }>(`/books?page=${page}&page_size=60&sort=recent`);
    remote.push(...res.items);
    if (res.items.length < 60 || remote.length >= res.total) break;
  }
  const pending = await pendingBookIds();
  const seen = new Set<string>();
  for (const sb of remote) {
    seen.add(sb.id);
    if (!pending.has(sb.id)) await mergeServerBook(sb);
  }
  // Books deleted on another device (or on the website) disappear here too.
  for (const b of await db.all<Book>(db.STORES.books)) {
    const known = b.storage_mode === "server" || b.device?.registered;
    if (known && !seen.has(b.id) && !pending.has(b.id)) await purgeBook(b);
  }
  try {
    const prefs = await request<Preferences>("/preferences");
    const queued = await db.all<Queued>(db.STORES.outbox);
    if (!queued.some((q) => q.kind === "prefs")) await db.put(db.STORES.kv, prefs, "preferences");
  } catch (e) {
    if (isNetworkError(e)) throw e;
  }
  await db.put(db.STORES.kv, new Date().toISOString(), "lastSync");
}

/** Remove a book and everything stored for it from this phone. */
export async function purgeBook(b: Book): Promise<void> {
  const marks = await db.byIndex<Bookmark>(db.STORES.bookmarks, "book", b.id);
  const key = b.device?.contentKey;
  if (key) await deleteContent(key);
  await db.batch([db.STORES.books, db.STORES.files, db.STORES.toc, db.STORES.progress, db.STORES.bookmarks], (s) => {
    s(db.STORES.books).delete(b.id);
    s(db.STORES.files).delete(b.id);
    s(db.STORES.toc).delete(serverCacheKey(b.id));
    s(db.STORES.progress).delete(b.id);
    for (const m of marks) s(db.STORES.bookmarks).delete(m.id);
  });
  // Cached chapters of a server-converted book.
  await deleteContent(serverCacheKey(b.id));
}

/** Content key of the offline copy of a server-converted book. */
export const serverCacheKey = (bookId: string) => `srv-${bookId}`;

export async function deleteContent(contentKey: string): Promise<void> {
  await db.del(db.STORES.toc, contentKey);
  await db.del(db.STORES.chapters, db.prefixRange(contentKey));
  await db.del(db.STORES.images, db.prefixRange(contentKey));
}

let syncing: Promise<void> | null = null;

/** Push queued changes, then refresh the library. Safe to call often; never throws. */
export function syncNow(): Promise<void> {
  syncing ??= (async () => {
    try {
      await flush();
      await pullLibrary();
      notify();
    } catch {
      /* offline or server unavailable: try again later */
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

let started = false;

/** Sync on start, when the connection comes back, when the app returns to the foreground and
 * every few minutes while it is open. */
export function startAutoSync(): void {
  if (started) return;
  started = true;
  void syncNow();
  window.addEventListener("online", () => void syncNow());
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void syncNow());
  window.setInterval(() => document.visibilityState === "visible" && void syncNow(), 3 * 60_000);
}
