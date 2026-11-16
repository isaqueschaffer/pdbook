import { API_BASE, IS_APP, session } from "./platform";

export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

/** True when the request never reached the server (offline, DNS, TLS...). */
export const isNetworkError = (e: unknown) => e instanceof ApiError && e.status === 0;

// Sent with every request; the API rejects state-changing requests without it (CSRF protection).
const CSRF_HEADERS = { "X-Requested-With": "PDBook" };

export function messageFrom(status: number, body: unknown): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object" && "message" in detail) return String((detail as { message: unknown }).message);
  }
  if (status === 0) return IS_APP ? "Sem conexão com a internet." : "Sem conexão com o servidor.";
  if (status === 413) return "Arquivo grande demais.";
  if (status === 429) return "Muitas tentativas. Aguarde um pouco.";
  if (status >= 500) return "O servidor encontrou um problema. Tente novamente.";
  return "Não foi possível concluir a operação.";
}

/** Headers that authenticate a request: the CSRF marker, plus the bearer token in the app. */
export function authHeaders(): Record<string, string> {
  if (!IS_APP) return { ...CSRF_HEADERS };
  const token = session.get()?.token;
  return { ...CSRF_HEADERS, "X-PDBook-Client": "app", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

export async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const auth = authHeaders();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      credentials: IS_APP ? "omit" : "same-origin",
      ...rest,
      headers: { ...auth, ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError(0, messageFrom(0, null));
  }
  if (res.status === 204) return undefined as T;
  const body = res.headers.get("content-type")?.includes("application/json") ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    // In the app, only a rejected token means the session is over (not e.g. a wrong password).
    if (res.status === 401 && (!IS_APP || "Authorization" in auth)) window.dispatchEvent(new CustomEvent("pdbook:unauthorized"));
    throw new ApiError(res.status, messageFrom(res.status, body), body);
  }
  return body as T;
}

/** Authenticated binary download (PDFs, images) for the app, which cannot rely on cookies. */
export async function requestBlob(path: string): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { credentials: IS_APP ? "omit" : "same-origin", headers: authHeaders() });
  } catch {
    throw new ApiError(0, messageFrom(0, null));
  }
  if (!res.ok) throw new ApiError(res.status, messageFrom(res.status, null));
  return res.blob();
}
