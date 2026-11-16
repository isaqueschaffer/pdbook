import { deleteAccountData } from "../device/db";
import { deviceApi, signOutLocally } from "../device/library";
import { ApiError, messageFrom, request } from "./http";
import { IS_APP, session } from "./platform";
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
  SearchResult,
  StorageInfo,
  Toc,
  User,
} from "./types";

export { ApiError, request };

/** Website upload with progress reporting (fetch cannot report upload progress). */
export function uploadBook(file: File, opts: { ocr: boolean; title?: string }, onProgress: (pct: number) => void, signal?: AbortSignal): Promise<Book> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("file", file);
    form.append("ocr", String(opts.ocr));
    if (opts.title) form.append("title", opts.title);
    xhr.open("POST", "/api/books");
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-Requested-With", "PDBook");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as Book);
      else reject(new ApiError(xhr.status, messageFrom(xhr.status, body), body));
    };
    xhr.onerror = () => reject(new ApiError(0, messageFrom(0, null)));
    xhr.onabort = () => reject(new ApiError(-1, "Envio cancelado."));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(form);
  });
}

/** The website: everything lives on the server. */
const serverApi = {
  config: () => request<PublicConfig>("/config"),
  me: () => request<User>("/auth/me"),
  login: (email: string, password: string) => request<User>("/auth/login", { method: "POST", json: { email, password } }),
  register: (display_name: string, email: string, password: string) =>
    request<User>("/auth/register", { method: "POST", json: { display_name, email, password } }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),

  updateAccount: (data: { display_name?: string; email?: string; current_password?: string }) =>
    request<User>("/account", { method: "PATCH", json: data }),
  changePassword: (current_password: string, new_password: string) =>
    request<void>("/account/password", { method: "POST", json: { current_password, new_password } }),
  logoutAll: () => request<void>("/account/logout-all", { method: "POST" }),
  deleteAccount: (password: string) => request<void>("/account", { method: "DELETE", json: { password } }),
  storage: () => request<StorageInfo>("/account/storage"),

  preferences: () => request<Preferences>("/preferences"),
  savePreferences: (p: Preferences) => request<Preferences>("/preferences", { method: "PUT", json: p }),
  resetPreferences: () => request<Preferences>("/preferences/reset", { method: "POST" }),

  dashboard: () => request<Dashboard>("/books/dashboard"),
  books: (params: { page?: number; page_size?: number; q?: string; status?: string; sort?: string }) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v !== undefined && v !== "" && qs.set(k, String(v)));
    return request<BookPage>(`/books?${qs}`);
  },
  book: (id: string) => request<Book>(`/books/${id}`),
  updateBook: (id: string, data: { title?: string; author?: string | null }) => request<Book>(`/books/${id}`, { method: "PATCH", json: data }),
  deleteBook: (id: string) => request<void>(`/books/${id}`, { method: "DELETE" }),
  reprocess: (id: string, ocr: boolean) => request<Book>(`/books/${id}/reprocess`, { method: "POST", json: { ocr } }),
  /** App only: drop the PDF and its conversion from the phone, keep the book in the account. */
  removeFromDevice: async (_id: string): Promise<Book> => {
    throw new ApiError(400, "Disponível apenas no aplicativo.");
  },
  pdfSource: async (id: string): Promise<PdfSource> => ({ url: `/api/books/${id}/file`, withCredentials: true }),
  imageSrc: async (id: string, name: string, version: number): Promise<{ src: string; release?: () => void }> => ({
    src: `/api/books/${id}/images/${encodeURIComponent(name)}?v=${version}`,
  }),

  toc: (id: string) => request<Toc>(`/books/${id}/chapters`),
  chapter: (id: string, index: number) => request<ChapterContent>(`/books/${id}/chapters/${index}`),
  search: (id: string, q: string) => request<SearchResult>(`/books/${id}/search?q=${encodeURIComponent(q)}`),
  progress: (id: string) => request<Progress | null>(`/books/${id}/progress`),
  saveProgress: (id: string, p: Progress, keepalive = false) =>
    request<Progress>(`/books/${id}/progress`, { method: "PUT", json: p, keepalive }),
  bookmarks: (id: string) => request<Bookmark[]>(`/books/${id}/bookmarks`),
  addBookmark: (id: string, b: NewBookmark) => request<Bookmark>(`/books/${id}/bookmarks`, { method: "POST", json: b }),
  updateBookmark: (id: string, bid: string, data: { note?: string | null; color?: string }) =>
    request<Bookmark>(`/books/${id}/bookmarks/${bid}`, { method: "PATCH", json: data }),
  deleteBookmark: (id: string, bid: string) => request<void>(`/books/${id}/bookmarks/${bid}`, { method: "DELETE" }),
};

/** The app: the library and the reader run on the phone; the account stays on the server. */
const appApi: typeof serverApi = {
  ...serverApi,
  ...deviceApi,
  login: async (email, password) => deviceApi.adopt(await serverApi.login(email, password)),
  register: async (name, email, password) => deviceApi.adopt(await serverApi.register(name, email, password)),
  logout: async () => {
    await deviceApi.syncNow(); // push what was read offline before the token goes away
    await serverApi.logout().catch(() => {});
    signOutLocally();
  },
  logoutAll: async () => {
    await serverApi.logoutAll().finally(signOutLocally);
  },
  deleteAccount: async (password) => {
    const user = session.get()?.user;
    await serverApi.deleteAccount(password);
    signOutLocally();
    if (user) await deleteAccountData(user.id);
  },
  updateAccount: async (data) => {
    const user = await serverApi.updateAccount(data);
    const s = session.get();
    if (s) session.set({ ...s, user });
    return user;
  },
  saveProgress: (id, p) => deviceApi.saveProgress(id, p),
};

export const api = IS_APP ? appApi : serverApi;
