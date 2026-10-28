import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { useToast } from "../../components/toast";
import { api } from "../../services/api";
import { DEFAULT_PREFERENCES, type Preferences } from "../../services/types";

/**
 * Reader preferences: applied instantly in the UI (they are only CSS variables, no reconversion)
 * and persisted to the server with a short debounce, so dragging a slider issues one request.
 */
export function usePreferences() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ["preferences"], queryFn: api.preferences, staleTime: 10 * 60_000 });
  const [local, setLocal] = useState<Preferences | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<Preferences | null>(null);

  const prefs = local ?? data ?? DEFAULT_PREFERENCES;

  const flush = useCallback(async () => {
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    try {
      const saved = await api.savePreferences(next);
      qc.setQueryData(["preferences"], saved);
    } catch {
      toast("Não foi possível salvar suas preferências de leitura.", "error");
    }
  }, [qc, toast]);

  const update = useCallback(
    (patch: Partial<Preferences>) => {
      setLocal((cur) => {
        const next = { ...(cur ?? qc.getQueryData<Preferences>(["preferences"]) ?? DEFAULT_PREFERENCES), ...patch };
        pending.current = next;
        return next;
      });
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, 600);
    },
    [qc, flush],
  );

  const reset = useCallback(async () => {
    window.clearTimeout(timer.current);
    pending.current = null;
    try {
      const saved = await api.resetPreferences();
      qc.setQueryData(["preferences"], saved);
      setLocal(saved);
      toast("Configurações padrão restauradas.", "success");
    } catch {
      toast("Não foi possível restaurar as configurações.", "error");
    }
  }, [qc, toast]);

  // Save anything still pending when the reader unmounts.
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      void flush();
    },
    [flush],
  );

  return { prefs, update, reset, isLoading };
}

/** CSS variables consumed by `.book-text` (see index.css). */
export function readerStyle(p: Preferences): React.CSSProperties {
  return {
    "--fs": `${p.font_size}px`,
    "--lh": String(p.line_height),
    "--ps": String(p.paragraph_spacing),
    "--mx": `min(${p.margin}px, 7vw)`,
    "--mw": `${p.max_width + 2 * p.margin}px`,
  } as React.CSSProperties;
}
