/**
 * Two builds share this code base:
 *  - web (default): served by Caddy next to the API; the browser keeps an HttpOnly session cookie
 *    and the server stores and converts the PDFs.
 *  - app (`vite build --mode app`, packaged with Capacitor): PDFs, conversion and OCR stay on the
 *    phone; the server is only used for the account and to sync progress, annotations and
 *    preferences. Authenticates with a bearer token.
 */
export const IS_APP = import.meta.env.VITE_APP_MODE === "app";

const SERVER_KEY = "pdbook.server";

/** "leitura.exemplo.com/" -> "https://leitura.exemplo.com"; null when it is not an http(s) address. */
export function normalizeServer(raw: string): string | null {
  let value = raw.trim().replace(/\/+$/, "");
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** App: origin of the PDBook server, chosen on the sign-in screen (default: VITE_API_URL).
 * Website: empty, the API is on the same origin. */
export function apiOrigin(): string {
  if (!IS_APP) return "";
  try {
    const stored = localStorage.getItem(SERVER_KEY);
    if (stored) return stored;
  } catch {
    /* storage unavailable */
  }
  return normalizeServer(String(import.meta.env.VITE_API_URL ?? "")) ?? "";
}

/** Point the app at another server. The session belongs to the old one, so it is dropped. */
export function setServer(origin: string): void {
  if (origin === apiOrigin()) return;
  session.clear();
  try {
    localStorage.setItem(SERVER_KEY, origin);
  } catch {
    /* storage unavailable */
  }
}

export const apiBase = () => `${apiOrigin()}/api`;

const SESSION_KEY = "pdbook.session";

export interface StoredSession {
  token: string;
  user: { id: string; email: string; display_name: string; created_at: string };
}

/** App only: the session token and the last known user (lets the library open offline). */
export const session = {
  get(): StoredSession | null {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? (JSON.parse(raw) as StoredSession) : null;
    } catch {
      return null;
    }
  },
  set(value: StoredSession): void {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(value));
    } catch {
      /* storage unavailable: the session lasts until the app closes */
    }
  },
  clear(): void {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
  },
};
