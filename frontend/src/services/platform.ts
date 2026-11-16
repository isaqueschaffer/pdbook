/**
 * Two builds share this code base:
 *  - web (default): served by Caddy next to the API; the browser keeps an HttpOnly session cookie
 *    and the server stores and converts the PDFs.
 *  - app (`vite build --mode app`, packaged with Capacitor): PDFs, conversion and OCR stay on the
 *    phone; the server is only used for the account and to sync progress, annotations and
 *    preferences. Authenticates with a bearer token.
 */
export const IS_APP = import.meta.env.VITE_APP_MODE === "app";

/** Origin of the PDBook server, e.g. https://leitura.exemplo.com. Empty on the web build (same origin). */
export const API_ORIGIN = IS_APP ? String(import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "") : "";

export const API_BASE = `${API_ORIGIN}/api`;

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
