import type {
  Book,
  BookPage,
  Bookmark,
  ChapterContent,
  Dashboard,
  NewBookmark,
  Preferences,
  Progress,
  PublicConfig,
  SearchResult,
  StorageInfo,
  Toc,
  User,
} from "./types";

export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

// Sent with every request; the API rejects state-changing requests without it (CSRF protection).
const CSRF_HEADERS = { "X-Requested-With": "BookFlow" };

function messageFrom(status: number, body: unknown): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object" && "message" in detail) return String((detail as { message: unknown }).message);
  }
  if (status === 0) return "Sem conexão com o servidor.";
  if (status === 413) return "Arquivo grande demais.";
  if (status === 429) return "Muitas tentativas. Aguarde um pouco.";
  if (status >= 500) return "O servidor encontrou um problema. Tente novamente.";
  return "Não foi possível concluir a operação.";
}

export async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      credentials: "same-origin",
      ...rest,
      headers: { ...CSRF_HEADERS, ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError(0, messageFrom(0, null));
  }
  if (res.status === 204) return undefined as T;
  const body = res.headers.get("content-type")?.includes("application/json") ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent("bookflow:unauthorized"));
    throw new ApiError(res.status, messageFrom(res.status, body), body);
  }
  return body as T;
}

/** Upload with progress reporting (fetch cannot report upload progress). */
export function uploadBook(file: File, opts: { ocr: boolean; title?: string }, onProgress: (pct: number) => void, signal?: AbortSignal): Promise<Book> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("file", file);
    form.append("ocr", String(opts.ocr));
    if (opts.title) form.append("title", opts.title);
    xhr.open("POST", "/api/books");
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-Requested-With", CSRF_HEADERS["X-Requested-With"]);
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

export const api = {
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
  fileUrl: (id: string) => `/api/books/${id}/file`,
  imageUrl: (id: string, name: string, version: number) => `/api/books/${id}/images/${encodeURIComponent(name)}?v=${version}`,

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
