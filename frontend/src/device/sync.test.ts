/** Outbox replay and library pulls against a fake server, on an in-memory IndexedDB. */
import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Book, Bookmark, Progress } from "../services/types";
import * as db from "./db";
import { enqueue, flush, syncNow } from "./sync";

(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

type Handler = (method: string, path: string, body: unknown) => { status: number; body?: unknown } | "offline";
let server: Handler;
const calls: string[] = [];

vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
  const method = init.method ?? "GET";
  const path = url.replace(/^\/api/, "");
  calls.push(`${method} ${path}`);
  const res = server(method, path, init.body ? JSON.parse(String(init.body)) : undefined);
  if (res === "offline") throw new TypeError("Failed to fetch");
  return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
});

let n = 0;
beforeEach(() => {
  calls.length = 0;
  db.openAccount(`user-${++n}`); // a fresh database per test
});

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

function localBook(id: string, over: Partial<Book> = {}): Book {
  return {
    id,
    title: "Livro",
    author: null,
    original_filename: "livro.pdf",
    file_size: 10,
    storage_mode: "device",
    page_count: 3,
    status: "ready",
    status_message: null,
    ocr_requested: false,
    ocr_used: false,
    content_version: 2,
    chapter_count: 2,
    word_count: 100,
    warnings: [],
    created_at: iso(),
    updated_at: iso(),
    last_opened_at: null,
    progress: null,
    job: null,
    device: { file: true, contentKey: "c1-abc", contentBytes: 5, registered: false, sha256: "f".repeat(64) },
    ...over,
  };
}

const serverBook = (id: string, over: Partial<Book> = {}): Book => ({ ...localBook(id), device: undefined, ...over });

describe("outbox", () => {
  it("keeps operations while offline and replays them in order once online", async () => {
    await db.put(db.STORES.books, localBook("local-1"), "local-1");
    await enqueue({ kind: "register", bookId: "local-1" });
    await db.put(db.STORES.progress, { content_version: 2, chapter_index: 1, block_index: 3, block_offset: 0, page: 2, percent: 40, mode: "book", updated_at: iso() } satisfies Progress, "local-1");
    await enqueue({ kind: "progress", bookId: "local-1" });
    await enqueue({ kind: "progress", bookId: "local-1" }); // coalesced

    server = () => "offline";
    await flush();
    expect(await db.all(db.STORES.outbox)).toHaveLength(2);

    server = (method, path) => {
      if (method === "POST" && path === "/books/device") return { status: 201, body: serverBook("local-1") };
      if (method === "PUT" && path === "/books/local-1/progress") return { status: 200, body: {} };
      return { status: 404 };
    };
    calls.length = 0;
    await flush();
    expect(calls).toEqual(["POST /books/device", "PUT /books/local-1/progress"]);
    expect(await db.all(db.STORES.outbox)).toHaveLength(0);
    expect((await db.get<Book>(db.STORES.books, "local-1"))?.device?.registered).toBe(true);
  });

  it("adopts the existing book when the same PDF was imported on another phone", async () => {
    const mark = { id: "m1", book_id: "local-2", kind: "bookmark", content_version: 2, chapter_index: 0, block_index: 1 } as unknown as Bookmark;
    await db.put(db.STORES.books, localBook("local-2"), "local-2");
    await db.put(db.STORES.files, new Blob(["%PDF-"]), "local-2");
    await db.put(db.STORES.bookmarks, mark);
    await enqueue({ kind: "register", bookId: "local-2" });
    await enqueue({ kind: "bm-create", bookId: "local-2", bookmark: mark });

    const posted: string[] = [];
    server = (method, path) => {
      if (path === "/books/device") return { status: 200, body: serverBook("from-other-phone", { title: "Título renomeado" }) };
      posted.push(`${method} ${path}`);
      return { status: 201, body: {} };
    };
    await flush();

    expect(await db.get(db.STORES.books, "local-2")).toBeUndefined();
    const adopted = await db.get<Book>(db.STORES.books, "from-other-phone");
    expect(adopted?.title).toBe("Título renomeado");
    expect(adopted?.device?.file).toBe(true);
    expect(await db.get(db.STORES.files, "from-other-phone")).toBeDefined();
    expect((await db.byIndex<Bookmark>(db.STORES.bookmarks, "book", "from-other-phone")).map((m) => m.id)).toEqual(["m1"]);
    // The queued bookmark followed the book to its server id.
    expect(posted).toEqual(["POST /books/from-other-phone/bookmarks"]);
  });

  it("drops an operation the server rejects for good, so the queue never gets stuck", async () => {
    await enqueue({ kind: "bm-update", bookId: "b", bookmarkId: "gone", data: { color: "blue" } });
    await enqueue({ kind: "meta", bookId: "b", data: { title: "Novo" } });
    server = (method) => (method === "PATCH" ? { status: 422, body: { detail: "inválido" } } : { status: 200 });
    await flush();
    expect(await db.all(db.STORES.outbox)).toHaveLength(0);
  });

  it("stops at a server error and keeps the rest for later", async () => {
    await enqueue({ kind: "delete", bookId: "x" });
    await enqueue({ kind: "delete", bookId: "y" });
    server = () => ({ status: 503 });
    await flush();
    expect(await db.all(db.STORES.outbox)).toHaveLength(2);
  });
});

describe("pull", () => {
  it("mirrors the account's library and keeps this phone's own conversion", async () => {
    await db.put(db.STORES.books, localBook("mine", { device: { file: true, contentKey: "c1-x", contentBytes: 1, registered: true }, chapter_count: 9 }), "mine");
    await db.put(db.STORES.books, localBook("deleted-elsewhere", { device: { file: true, contentKey: null, contentBytes: 0, registered: true } }), "deleted-elsewhere");
    await db.put(db.STORES.books, localBook("offline-import"), "offline-import"); // never synced: must survive
    await enqueue({ kind: "register", bookId: "offline-import" });

    server = (_method, path) => {
      if (path.startsWith("/books?")) {
        return {
          status: 200,
          body: { items: [serverBook("mine", { title: "Do servidor", chapter_count: 3 }), serverBook("web-upload", { storage_mode: "server" })], total: 2 },
        };
      }
      if (path === "/preferences") return { status: 200, body: { theme: "sepia" } };
      if (path === "/books/device") return "offline";
      return { status: 404 };
    };
    await syncNow();

    const ids = (await db.all<Book>(db.STORES.books)).map((b) => b.id).sort();
    expect(ids).toEqual(["mine", "offline-import", "web-upload"]);
    const mine = await db.get<Book>(db.STORES.books, "mine");
    expect(mine?.title).toBe("Do servidor");
    expect(mine?.chapter_count).toBe(9); // its own conversion, not the other device's
    expect((await db.get<Book>(db.STORES.books, "web-upload"))?.device).toBeUndefined();
    expect(await db.get(db.STORES.kv, "preferences")).toEqual({ theme: "sepia" });
  });
});
