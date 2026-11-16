/**
 * The app's on-device database (IndexedDB), one per account so two people sharing a phone never
 * see each other's books. Holds the PDFs, the converted content and a local copy of everything the
 * server syncs, so the library and the reader work without a connection.
 */

export const STORES = {
  books: "books", // id -> LocalBook
  files: "files", // book id -> PDF Blob
  toc: "toc", // content key -> Toc
  chapters: "chapters", // "<content key>:<index>" -> ChapterContent
  images: "images", // "<content key>:<name>" -> Blob
  progress: "progress", // book id -> Progress
  bookmarks: "bookmarks", // bookmark id -> Bookmark & { book_id }
  outbox: "outbox", // auto-increment -> pending server operation
  kv: "kv", // misc: cached preferences, last sync...
} as const;

type StoreName = (typeof STORES)[keyof typeof STORES];

const VERSION = 1;
let current: { userId: string; db: Promise<IDBDatabase> } | null = null;

function open(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of [STORES.books, STORES.files, STORES.toc, STORES.chapters, STORES.images, STORES.progress, STORES.kv]) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      }
      if (!db.objectStoreNames.contains(STORES.bookmarks)) db.createObjectStore(STORES.bookmarks, { keyPath: "id" }).createIndex("book", "book_id");
      if (!db.objectStoreNames.contains(STORES.outbox)) db.createObjectStore(STORES.outbox, { keyPath: "seq", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Banco de dados local bloqueado por outra aba."));
  });
}

const dbName = (userId: string) => `pdbook-${userId}`;

export function openAccount(userId: string): void {
  if (current?.userId === userId) return;
  current?.db.then((d) => d.close()).catch(() => {});
  current = { userId, db: open(dbName(userId)) };
  // Ask the OS not to evict our data under storage pressure (books are not re-downloadable).
  navigator.storage?.persist?.().catch(() => {});
}

export function closeAccount(): void {
  current?.db.then((d) => d.close()).catch(() => {});
  current = null;
}

export async function deleteAccountData(userId: string): Promise<void> {
  if (current?.userId === userId) closeAccount();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(dbName(userId));
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

function db(): Promise<IDBDatabase> {
  if (!current) return Promise.reject(new Error("Nenhuma conta aberta neste aparelho."));
  return current.db;
}

const done = (t: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("Transação cancelada"));
  });

const result = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export async function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const t = (await db()).transaction(store, "readonly");
  return (await result(t.objectStore(store).get(key))) as T | undefined;
}

export async function put(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
  const t = (await db()).transaction(store, "readwrite");
  t.objectStore(store).put(value, key);
  await done(t);
}

export async function del(store: StoreName, key: IDBValidKey | IDBKeyRange): Promise<void> {
  const t = (await db()).transaction(store, "readwrite");
  t.objectStore(store).delete(key);
  await done(t);
}

export async function all<T>(store: StoreName, query?: IDBKeyRange): Promise<T[]> {
  const t = (await db()).transaction(store, "readonly");
  return (await result(t.objectStore(store).getAll(query))) as T[];
}

export async function byIndex<T>(store: StoreName, index: string, value: IDBValidKey): Promise<T[]> {
  const t = (await db()).transaction(store, "readonly");
  return (await result(t.objectStore(store).index(index).getAll(value))) as T[];
}

/** Keys "<prefix>:..." of the stores keyed by book (chapters, images). */
export const prefixRange = (prefix: string) => IDBKeyRange.bound(`${prefix}:`, `${prefix}:￿`);

export async function keys(store: StoreName, query?: IDBKeyRange): Promise<IDBValidKey[]> {
  const t = (await db()).transaction(store, "readonly");
  return result(t.objectStore(store).getAllKeys(query));
}

/**
 * Atomic read-modify-write of one record: the read and the write share a readwrite transaction,
 * which IndexedDB runs one at a time per store, so concurrent writers (the converter reporting
 * progress, the reader saving its position, a sync) never overwrite each other's changes.
 * `fn` returns the new value, or undefined to leave the record as is.
 */
export async function modify<T>(store: StoreName, key: IDBValidKey, fn: (current: T | undefined) => T | undefined): Promise<T | undefined> {
  const t = (await db()).transaction(store, "readwrite");
  const s = t.objectStore(store);
  let next: T | undefined;
  const req = s.get(key);
  req.onsuccess = () => {
    next = fn(req.result as T | undefined);
    if (next !== undefined) s.put(next, key);
  };
  await done(t);
  return next;
}

/** Several writes in one transaction (all or nothing). */
export async function batch(stores: StoreName[], fn: (tx: (s: StoreName) => IDBObjectStore) => void): Promise<void> {
  const t = (await db()).transaction(stores, "readwrite");
  fn((s) => t.objectStore(s));
  await done(t);
}
