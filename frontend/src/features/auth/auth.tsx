import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router";

import { PageLoader } from "../../components/ui";
import { onSyncChange } from "../../device/sync";
import { signOutLocally } from "../../device/library";
import { ApiError, api } from "../../services/api";
import { IS_APP } from "../../services/platform";
import type { User } from "../../services/types";

export const ME_KEY = ["me"] as const;

export function useMe() {
  return useQuery<User | null>({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return await api.me();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

/** Clears cached data when any request reports an expired session. */
export function SessionWatcher() {
  const qc = useQueryClient();
  useEffect(() => {
    const onUnauthorized = () => {
      if (IS_APP) signOutLocally();
      if (qc.getQueryData(ME_KEY)) {
        qc.clear();
        qc.setQueryData(ME_KEY, null);
      }
    };
    window.addEventListener("pdbook:unauthorized", onUnauthorized);
    // App: a sync brought changes from the server (another device, the website): refresh the screens.
    const stopSync = IS_APP
      ? onSyncChange(() => {
          for (const key of ["books", "dashboard", "book", "reader", "preferences", "storage"]) void qc.invalidateQueries({ queryKey: [key] });
        })
      : () => {};
    return () => {
      window.removeEventListener("pdbook:unauthorized", onUnauthorized);
      stopSync();
    };
  }, [qc]);
  return null;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { data: user, isLoading, isError } = useMe();
  const location = useLocation();
  if (isLoading) return <PageLoader />;
  if (isError) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6 text-center text-sm text-ink-soft">
        Não foi possível contatar o servidor. Verifique sua conexão e recarregue a página.
      </div>
    );
  }
  if (!user) return <Navigate to={`/entrar?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <>{children}</>;
}

export function RedirectIfAuthenticated({ children }: { children: ReactNode }) {
  const { data: user, isLoading } = useMe();
  if (isLoading) return <PageLoader />;
  if (user) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Only allow same-app relative redirects after login (no open redirect). */
export function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}
