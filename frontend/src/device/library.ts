/**
 * The app's implementation of the API the screens use (see services/api.ts). Library, reader,
 * progress and annotations are served from the phone; the server is reached through the sync queue
 * and only directly for account operations and books converted by the server.
 */
import { ApiError, isNetworkError, request, requestBlob, authHeaders } from "../services/http";
import { apiBase, session } from "../services/platform";
import type {
  Book,
  BookPage,
  Bookmark,
  ChapterContent,
  Dashboard,
  NewBookmark,
  PdfSource,
  Preferences,
  Progress,
  PublicConfig,
  SearchHit,
  SearchResult,
  StorageInfo,
  Toc,
  User,
} from "../services/types";
import { DEFAULT_PREFERENCES } from "../services/types";
import { foldSearch } from "./convert/heuristics";
import * as db from "./db";
import { DEVICE_LIMITS } from "./limits";
import { deleteContent, dropOpsFor, enqueue, mergeServerBook, purgeBook, serverCacheKey, startAutoSync, syncNow } from "./sync";

// The converter pulls in pdf.js: load it only when a conversion is needed.
const importer = () => import("./importer");

const now = () => new Date().toISOString();
const ts = (s?: string | null) => (s ? Date.parse(s) : 0);

/** Book-mode content is local when this phone converted the book itself. */
const localKey = (b: Book) => b.device?.contentKey ?? null;
const isServerBook = (b: Book) => b.storage_mode === "server";

async function requireBook(id: string): Promise<Book> {
  const b = await db.get<Book>(db.STORES.books, id);
  if (!b) throw new ApiError(404, "Livro não encontrado");
  return b;
}

// ---------------------------------------------------------------------------
// Session

let booted = false;
/** Once per launch, after the account is known: start syncing and restart interrupted conversions. */
function boot(): void {
  startAutoSync();
  if (booted) return;
  booted = true;
  void importer().then((m) => m.resumeInterrupted()).catch(() => {});
}

function adopt(user: User & { session_token?: string }): User {
  const { session_token, ...plain } = user;
  const token = session_token ?? session.get()?.token;
  if (!token) throw new ApiError(500, "O servidor não devolveu a sessão do aplicativo.");
  session.set({ token, user: plain });
  db.openAccount(plain.id);
  boot();
  return plain;
}

async function me(): Promise<User> {
  const stored = session.get();
  if (!stored) throw new ApiError(401, "Sessão expirada. Entre novamente.");
  db.openAccount(stored.user.id);
  try {
    const user = await request<User>("/auth/me");
    session.set({ token: stored.token, user });
    boot();
    return user;
  } catch (e) {
    // Offline: the phone keeps working with what it has.
    if (isNetworkError(e) || (e instanceof ApiError && e.status >= 500)) {
      boot();
      return stored.user;
    }
    if (e instanceof ApiError && e.status === 401) signOutLocally();
    throw e;
  }
}

/** Forget the session. The account's books stay on the phone for the next sign-in. */
export function signOutLocally(): void {
  session.clear();
  db.closeAccount();
}

// ---------------------------------------------------------------------------
// Library

async function listBooks(): Promise<Book[]> {
  return db.all<Book>(db.STORES.books);
}

const isActive = (b: Book) => b.status === "pending" || b.status === "processing";

async function books(params: { page?: number; page_size?: number; q?: string; status?: string; sort?: string }): Promise<BookPage> {
  let items = await listBooks();
  const q = foldSearch((params.q ?? "").trim());
  if (q) items = items.filter((b) => [b.title, b.author ?? "", b.original_filename].some((f) => foldSearch(f).includes(q)));
  if (params.status === "active") items = items.filter(isActive);
  else if (params.status) items = items.filter((b) => b.status === params.status);
  const sort = params.sort ?? "recent";
  items.sort((a, b) =>
    sort === "title"
      ? a.title.localeCompare(b.title, "pt-BR", { sensitivity: "base" })
      : sort === "opened"
        ? ts(b.last_opened_at) - ts(a.last_opened_at) || ts(b.created_at) - ts(a.created_at)
        : ts(b.created_at) - ts(a.created_at),
  );
  const page = Math.max(1, params.page ?? 1);
  const size = params.page_size ?? 24;
  return { items: items.slice((page - 1) * size, page * size), total: items.length, page, page_size: size };
}

async function storage(): Promise<StorageInfo> {
  const all = await listBooks();
  const used = all.reduce((n, b) => n + (b.device?.file ? b.file_size : 0) + (b.device?.contentBytes ?? 0), 0);
  const est = await navigator.storage?.estimate?.().catch(() => undefined);
  const quota = est?.quota ?? 0;
  const free = quota ? Math.max(0, quota - (est?.usage ?? used)) : 0;
  return {
    used_bytes: est?.usage ?? used,
    limit_bytes: quota,
    disk_free_bytes: free,
    warn: !!quota && free < 300 * 1024 * 1024,
    full: !!quota && free < 50 * 1024 * 1024,
    user_used_bytes: used,
    user_limit_bytes: null,
  };
}

async function dashboard(): Promise<Dashboard> {
  const all = await listBooks();
  const byRecent = [...all].sort((a, b) => ts(b.created_at) - ts(a.created_at));
  const reading = all
    .filter((b) => b.progress && b.progress.percent < 99.5)
    .sort((a, b) => ts(b.progress!.updated_at) - ts(a.progress!.updated_at))
    .slice(0, 4);
  return {
    total_books: all.length,
    ready_books: all.filter((b) => b.status === "ready").length,
    processing_books: all.filter(isActive).length,
    words_read_estimate: all.reduce((n, b) => n + Math.floor((b.word_count * (b.progress?.percent ?? 0)) / 100), 0),
    continue_reading: reading,
    recent: byRecent.slice(0, 6),
    storage: await storage(),
  };
}

async function book(id: string): Promise<Book> {
  const b = await requireBook(id);
  // A conversion that is no longer running (app killed) must not show "processing" forever.
  if (isActive(b) && b.device?.file) {
    const { isConverting, resumeInterrupted } = await importer();
    if (!isConverting(b.id)) void resumeInterrupted();
  }
  return b;
}

async function updateBook(id: string, data: { title?: string; author?: string | null }): Promise<Book> {
  if (data.title !== undefined && !data.title.trim()) throw new ApiError(422, "O título não pode ficar vazio.");
  const next = await db.modify<Book>(db.STORES.books, id, (b) =>
    b
      ? { ...b, title: data.title !== undefined ? data.title.trim() : b.title, author: "author" in data ? data.author?.trim() || null : b.author, updated_at: now() }
      : undefined,
  );
  if (!next) throw new ApiError(404, "Livro não encontrado");
  await enqueue({ kind: "meta", bookId: id, data: { title: next.title, author: next.author } });
  return next;
}

async function deleteBook(id: string): Promise<void> {
  const b = await requireBook(id);
  const known = isServerBook(b) || b.device?.registered;
  await purgeBook(b);
  if (known) await enqueue({ kind: "delete", bookId: id });
  else await dropOpsFor(id);
}

async function reprocess(id: string, ocr: boolean): Promise<Book> {
  const b = await requireBook(id);
  if (isServerBook(b)) {
    const saved = await request<Book>(`/books/${id}/reprocess`, { method: "POST", json: { ocr } });
    await mergeServerBook(saved);
    return (await db.get<Book>(db.STORES.books, id)) ?? saved;
  }
  return (await importer()).reconvert(id, ocr);
}

/** Free the phone's space but keep the book (and its progress) in the account. */
async function removeFromDevice(id: string): Promise<Book> {
  const b = await requireBook(id);
  if (!b.device?.registered) throw new ApiError(409, "Conecte-se à internet para sincronizar este livro antes de removê-lo do aparelho.");
  if ((await importer()).isConverting(id)) throw new ApiError(409, "Aguarde o fim da conversão.");
  const next = await db.modify<Book>(db.STORES.books, id, (cur) =>
    cur ? { ...cur, job: null, device: { file: false, contentKey: null, contentBytes: 0, registered: true } } : undefined,
  );
  if (b.device.contentKey) await deleteContent(b.device.contentKey);
  await db.del(db.STORES.files, id);
  return next ?? b;
}

// ---------------------------------------------------------------------------
// Reader content

async function toc(id: string): Promise<Toc> {
  const b = await requireBook(id);
  const key = localKey(b);
  if (key) {
    const t = await db.get<Toc>(db.STORES.toc, key);
    if (t) return t;
    throw new ApiError(410, "O conteúdo convertido não está neste aparelho. Reprocesse o livro.");
  }
  if (!isServerBook(b)) throw new ApiError(409, "O modo Livro deste documento está em outro aparelho.");
  // Converted by the server: read it there and keep a copy so it opens offline next time.
  const cacheKey = serverCacheKey(id);
  try {
    const t = await request<Toc>(`/books/${id}/chapters`);
    const old = await db.get<Toc>(db.STORES.toc, cacheKey);
    if (old && old.content_version !== t.content_version) {
      await db.del(db.STORES.chapters, db.prefixRange(cacheKey));
      await db.del(db.STORES.images, db.prefixRange(cacheKey));
    }
    await db.put(db.STORES.toc, t, cacheKey);
    return t;
  } catch (e) {
    const cached = isNetworkError(e) ? await db.get<Toc>(db.STORES.toc, cacheKey) : undefined;
    if (cached) return cached;
    throw e;
  }
}

async function chapter(id: string, index: number): Promise<ChapterContent> {
  const b = await requireBook(id);
  const key = localKey(b) ?? serverCacheKey(id);
  const local = await db.get<ChapterContent>(db.STORES.chapters, `${key}:${index}`);
  if (local && (localKey(b) || local.content_version === b.content_version)) return local;
  if (!isServerBook(b)) throw new ApiError(404, "Capítulo não encontrado");
  const remote = await request<ChapterContent>(`/books/${id}/chapters/${index}`);
  await db.put(db.STORES.chapters, remote, `${key}:${index}`);
  return remote;
}

const MAX_SEARCH_HITS = 200;

/** Same algorithm as the server's search (accent and case insensitive, offsets into the text). */
async function search(id: string, q: string): Promise<SearchResult> {
  const b = await requireBook(id);
  if (isServerBook(b) && !localKey(b)) {
    try {
      return await request<SearchResult>(`/books/${id}/search?q=${encodeURIComponent(q)}`);
    } catch (e) {
      if (!isNetworkError(e)) throw e; // offline: search the chapters cached on the phone
    }
  }
  const t = await toc(id);
  const needle = foldSearch(q.split(/\s+/).filter(Boolean).join(" "));
  const hits: SearchHit[] = [];
  let total = 0;
  for (const ch of t.chapters) {
    let blocks: ChapterContent["blocks"];
    try {
      blocks = (await chapter(id, ch.index)).blocks;
    } catch {
      continue;
    }
    blocks.forEach((block, bi) => {
      const text = block.text ?? "";
      const hay = foldSearch(text);
      let start = needle ? hay.indexOf(needle) : -1;
      while (start !== -1) {
        total++;
        if (hits.length < MAX_SEARCH_HITS) {
          const a = Math.max(0, start - 70);
          const z = Math.min(text.length, start + needle.length + 70);
          hits.push({
            chapter_index: ch.index,
            chapter_title: ch.title,
            block_index: bi,
            page: block.page ?? 1,
            snippet: (a ? "…" : "") + text.slice(a, z) + (z < text.length ? "…" : ""),
            match_start: start - a + (a ? 1 : 0),
            match_length: needle.length,
          });
        }
        start = hay.indexOf(needle, start + needle.length);
      }
    });
  }
  return { query: q, total, truncated: total > hits.length, hits };
}

async function pdfSource(id: string): Promise<PdfSource> {
  const b = await requireBook(id);
  const file = await db.get<Blob>(db.STORES.files, id);
  if (file) {
    const url = URL.createObjectURL(file);
    return { url, release: () => URL.revokeObjectURL(url) };
  }
  if (isServerBook(b)) return { url: `${apiBase()}/books/${id}/file`, httpHeaders: authHeaders() };
  throw new ApiError(404, "O PDF deste livro está guardado em outro aparelho.");
}

async function imageSrc(id: string, name: string, version: number): Promise<{ src: string; release?: () => void }> {
  const b = await requireBook(id);
  const key = localKey(b) ?? serverCacheKey(id);
  let blob = await db.get<Blob>(db.STORES.images, `${key}:${name}`);
  if (!blob && isServerBook(b)) {
    blob = await requestBlob(`/books/${id}/images/${encodeURIComponent(name)}?v=${version}`);
    await db.put(db.STORES.images, blob, `${key}:${name}`);
  }
  if (!blob) throw new ApiError(404, "Imagem não encontrada");
  const src = URL.createObjectURL(blob);
  return { src, release: () => URL.revokeObjectURL(src) };
}

// ---------------------------------------------------------------------------
// Progress (local first, newest wins across devices)

async function progress(id: string): Promise<Progress | null> {
  const local = (await db.get<Progress>(db.STORES.progress, id)) ?? null;
  const b = await db.get<Book>(db.STORES.books, id);
  // Ask the server even for a book still being registered (brought from another phone): a 404 only
  // means there is nothing there yet.
  if (!b) return local;
  try {
    const remote = await request<Progress | null>(`/books/${id}/progress`);
    if (remote && ts(remote.updated_at) > ts(local?.updated_at)) {
      await db.put(db.STORES.progress, remote, id);
      return remote;
    }
  } catch {
    /* offline: the local position is the best we have */
  }
  return local;
}

async function saveProgress(id: string, p: Progress): Promise<Progress> {
  const saved: Progress = { ...p, updated_at: now() };
  await db.put(db.STORES.progress, saved, id);
  await db.modify<Book>(db.STORES.books, id, (b) =>
    b ? { ...b, last_opened_at: saved.updated_at!, progress: { percent: saved.percent, chapter_index: saved.chapter_index, updated_at: saved.updated_at! } } : undefined,
  );
  await enqueue({ kind: "progress", bookId: id });
  return saved;
}

// ---------------------------------------------------------------------------
// Bookmarks (local first; queued for the server)

type StoredMark = Bookmark & { book_id: string };
const strip = ({ book_id: _b, ...m }: StoredMark): Bookmark => m;

const markOrder = (a: Bookmark, b: Bookmark) =>
  a.chapter_index - b.chapter_index || a.block_index - b.block_index || (a.start_offset ?? -1) - (b.start_offset ?? -1) || ts(a.created_at) - ts(b.created_at);

async function bookmarks(id: string): Promise<Bookmark[]> {
  const b = await db.get<Book>(db.STORES.books, id);
  if (b) {
    try {
      const remote = await request<Bookmark[]>(`/books/${id}/bookmarks`);
      // Marks with changes still queued keep their local version.
      const queued = (await db.all<{ kind: string; bookmarkId?: string; bookmark?: Bookmark }>(db.STORES.outbox)).flatMap((q) =>
        q.kind.startsWith("bm-") ? [q.bookmarkId ?? q.bookmark?.id ?? ""] : [],
      );
      const pending = new Set(queued);
      const local = await db.byIndex<StoredMark>(db.STORES.bookmarks, "book", id);
      await db.batch([db.STORES.bookmarks], (s) => {
        for (const m of local) if (!pending.has(m.id)) s(db.STORES.bookmarks).delete(m.id);
        for (const m of remote) if (!pending.has(m.id)) s(db.STORES.bookmarks).put({ ...m, book_id: id });
      });
    } catch {
      /* offline */
    }
  }
  return (await db.byIndex<StoredMark>(db.STORES.bookmarks, "book", id)).map(strip).sort(markOrder);
}

function validate(b: NewBookmark): void {
  if ((b.kind === "highlight" || b.kind === "note") && b.start_offset != null) {
    const endBlock = b.end_block_index ?? b.block_index;
    if (endBlock < b.block_index || (endBlock === b.block_index && (b.end_offset == null || b.end_offset <= b.start_offset))) throw new ApiError(422, "Trecho inválido");
  }
  if (b.kind === "note" && !(b.note ?? "").trim()) throw new ApiError(422, "A anotação não pode ficar vazia");
  if (b.kind === "highlight" && b.start_offset == null) throw new ApiError(422, "Selecione um trecho para destacar");
}

async function addBookmark(id: string, nb: NewBookmark): Promise<Bookmark> {
  validate(nb);
  const t = now();
  const mark: Bookmark = {
    id: crypto.randomUUID(),
    kind: nb.kind,
    content_version: nb.content_version,
    chapter_index: nb.chapter_index,
    block_index: nb.block_index,
    start_offset: nb.start_offset ?? null,
    end_block_index: nb.end_block_index ?? null,
    end_offset: nb.end_offset ?? null,
    page: nb.page ?? null,
    quote: nb.quote ?? null,
    note: nb.note ?? null,
    color: nb.kind === "highlight" && !nb.color ? "yellow" : (nb.color ?? null),
    created_at: t,
    updated_at: t,
  };
  await db.put(db.STORES.bookmarks, { ...mark, book_id: id });
  await enqueue({ kind: "bm-create", bookId: id, bookmark: mark });
  return mark;
}

async function updateBookmark(id: string, bid: string, data: { note?: string | null; color?: string }): Promise<Bookmark> {
  const stored = await db.get<StoredMark>(db.STORES.bookmarks, bid);
  if (!stored || stored.book_id !== id) throw new ApiError(404, "Marcador não encontrado");
  const m = { ...stored, updated_at: now() };
  if ("note" in data) {
    m.note = (data.note ?? "").trim() || null;
    if (m.kind === "highlight" && m.note) m.kind = "note";
    else if (m.kind === "note" && !m.note) m.kind = m.start_offset != null ? "highlight" : "bookmark";
  }
  if (data.color) m.color = data.color as Bookmark["color"];
  await db.put(db.STORES.bookmarks, m);
  await enqueue({ kind: "bm-update", bookId: id, bookmarkId: bid, data });
  return strip(m);
}

async function deleteBookmark(id: string, bid: string): Promise<void> {
  await db.del(db.STORES.bookmarks, bid);
  await enqueue({ kind: "bm-delete", bookId: id, bookmarkId: bid });
}

// ---------------------------------------------------------------------------
// Preferences (cached for offline, queued when changed)

async function preferences(): Promise<Preferences> {
  const cached = await db.get<Preferences>(db.STORES.kv, "preferences");
  if (cached) return cached;
  try {
    const remote = await request<Preferences>("/preferences");
    await db.put(db.STORES.kv, remote, "preferences");
    return remote;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

async function savePreferences(p: Preferences): Promise<Preferences> {
  await db.put(db.STORES.kv, p, "preferences");
  await enqueue({ kind: "prefs" });
  return p;
}

const resetPreferences = () => savePreferences({ ...DEFAULT_PREFERENCES });

const config = async (): Promise<PublicConfig> => ({
  max_upload_mb: DEVICE_LIMITS.maxBytes / 1024 / 1024,
  max_pdf_pages: DEVICE_LIMITS.maxPages,
  ocr_enabled: true,
});

export const deviceApi = {
  me,
  adopt,
  config,
  dashboard,
  books,
  book,
  updateBook,
  deleteBook,
  reprocess,
  removeFromDevice,
  toc,
  chapter,
  search,
  pdfSource,
  imageSrc,
  progress,
  saveProgress,
  bookmarks,
  addBookmark,
  updateBookmark,
  deleteBookmark,
  preferences,
  savePreferences,
  resetPreferences,
  storage,
  syncNow,
};
