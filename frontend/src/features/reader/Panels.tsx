import { useQuery } from "@tanstack/react-query";
import { Bookmark as BookmarkIcon, Highlighter, Search, StickyNote, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Spinner } from "../../components/ui";
import { api } from "../../services/api";
import { formatRelative } from "../../services/format";
import type { Bookmark, Chapter } from "../../services/types";

export function Drawer({ open, side = "right", title, onClose, children }: { open: boolean; side?: "left" | "right"; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/25" onClick={onClose} aria-hidden />
      <aside
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`absolute inset-y-0 flex w-full max-w-sm flex-col bg-[var(--r-panel)] text-[var(--r-ink)] shadow-2xl outline-none ${
          side === "left" ? "left-0 border-r" : "right-0 border-l"
        } border-[var(--r-line)]`}
      >
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--r-line)] px-5">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Fechar" className="rounded-md p-1.5 opacity-70 hover:bg-black/5 hover:opacity-100">
            <X className="size-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </div>
  );
}

export function TocPanel({ chapters, current, onGo }: { chapters: Chapter[]; current: number; onGo: (chapter: number, block?: number) => void }) {
  return (
    <nav aria-label="Sumário">
      <ol className="space-y-0.5">
        {chapters.map((c) => (
          <li key={c.index}>
            <button
              onClick={() => onGo(c.index, 0)}
              aria-current={c.index === current ? "true" : undefined}
              className={`flex w-full items-baseline justify-between gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-black/5 ${
                c.index === current ? "font-semibold text-[var(--r-accent)]" : ""
              }`}
              style={{ paddingLeft: `${0.5 + (c.level - 1) * 0.75}rem` }}
            >
              <span>{c.title}</span>
              <span className="shrink-0 text-xs tabular-nums opacity-50">p. {c.start_page}</span>
            </button>
            {c.sections.length > 0 && c.index === current && (
              <ol className="mb-2 ml-3 border-l border-[var(--r-line)]">
                {c.sections.map((s) => (
                  <li key={s.block}>
                    <button
                      onClick={() => onGo(c.index, s.block)}
                      className="w-full rounded-md px-3 py-1.5 text-left text-[13px] opacity-75 hover:bg-black/5 hover:opacity-100"
                      style={{ paddingLeft: `${0.75 + (s.level - 1) * 0.6}rem` }}
                    >
                      {s.title}
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function SearchPanel({ bookId, onGo }: { bookId: string; onGo: (chapter: number, block: number) => void }) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const { data, isFetching, isError } = useQuery({
    queryKey: ["reader", bookId, "search", query],
    queryFn: () => api.search(bookId, query),
    enabled: query.length >= 2,
    staleTime: 5 * 60_000,
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setQuery(input.trim());
  }

  return (
    <div>
      <form onSubmit={submit} className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 opacity-50" aria-hidden />
        <input
          autoFocus
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Buscar no livro"
          aria-label="Buscar no livro"
          minLength={2}
          maxLength={100}
          className="h-10 w-full rounded-lg border border-[var(--r-line)] bg-transparent pl-9 pr-3 text-sm outline-none focus:border-[var(--r-accent)]"
        />
      </form>
      <div className="mt-4">
        {isFetching && (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        )}
        {isError && <p className="text-sm opacity-75">Não foi possível buscar agora.</p>}
        {data && !isFetching && (
          <>
            <p className="mb-3 text-xs opacity-60">
              {data.total === 0 ? "Nenhum resultado." : `${data.total} resultado${data.total > 1 ? "s" : ""}${data.truncated ? ` (mostrando ${data.hits.length})` : ""}`}
            </p>
            <ul className="space-y-1">
              {data.hits.map((h, i) => (
                <li key={i}>
                  <button onClick={() => onGo(h.chapter_index, h.block_index)} className="w-full rounded-md px-2 py-2 text-left hover:bg-black/5">
                    <span className="block text-xs opacity-55">
                      {h.chapter_title} · p. {h.page}
                    </span>
                    <span className="mt-0.5 block text-sm leading-relaxed">
                      {h.snippet.slice(0, h.match_start)}
                      <mark className="rounded-sm bg-[var(--r-search)] px-0.5 text-inherit">{h.snippet.slice(h.match_start, h.match_start + h.match_length)}</mark>
                      {h.snippet.slice(h.match_start + h.match_length)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

export function AnnotationsPanel({
  items,
  chapters,
  onGo,
  onDelete,
  onEdit,
}: {
  items: Bookmark[];
  chapters: Chapter[];
  onGo: (b: Bookmark) => void;
  onDelete: (b: Bookmark) => void;
  onEdit: (b: Bookmark) => void;
}) {
  const [tab, setTab] = useState<"marks" | "bookmarks">("marks");
  const title = (i: number) => chapters.find((c) => c.index === i)?.title ?? `Capítulo ${i + 1}`;
  const shown = items.filter((b) => (tab === "bookmarks" ? b.kind === "bookmark" : b.kind !== "bookmark"));

  return (
    <div>
      <div className="mb-4 grid grid-cols-2 rounded-lg bg-black/5 p-1 text-sm" role="tablist">
        {(
          [
            ["marks", "Destaques e notas"],
            ["bookmarks", "Marcadores"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={`rounded-md py-1.5 ${tab === value ? "bg-[var(--r-panel)] font-medium shadow-sm" : "opacity-70"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="py-10 text-center text-sm opacity-60">
          {tab === "bookmarks" ? "Use o ícone de marcador na barra superior para marcar uma posição." : "Selecione um trecho do texto para destacá-lo ou anotar."}
        </p>
      ) : (
        <ul className="space-y-2">
          {shown.map((b) => {
            const Icon = b.kind === "bookmark" ? BookmarkIcon : b.kind === "note" ? StickyNote : Highlighter;
            return (
              <li key={b.id} className="group rounded-lg border border-[var(--r-line)] p-3">
                <button onClick={() => onGo(b)} className="w-full text-left">
                  <span className="flex items-center gap-1.5 text-xs opacity-60">
                    <Icon className="size-3.5" />
                    {title(b.chapter_index)}
                    {b.page ? ` · p. ${b.page}` : ""}
                  </span>
                  {b.quote && (
                    <span
                      className="mt-1.5 line-clamp-3 border-l-2 pl-2 font-serif text-sm leading-relaxed"
                      style={{ borderColor: b.color ? `var(--r-mark-${b.color})` : "var(--r-line)" }}
                    >
                      {b.quote}
                    </span>
                  )}
                  {b.note && <span className="mt-1.5 block whitespace-pre-wrap text-sm">{b.note}</span>}
                </button>
                <div className="mt-2 flex items-center justify-between text-xs opacity-60">
                  <span>{formatRelative(b.created_at)}</span>
                  <span className="flex gap-1">
                    {b.kind !== "bookmark" && (
                      <button onClick={() => onEdit(b)} className="rounded px-1.5 py-0.5 hover:bg-black/5 hover:opacity-100">
                        Editar
                      </button>
                    )}
                    <button onClick={() => onDelete(b)} aria-label="Excluir" className="rounded p-1 hover:bg-black/5 hover:text-[var(--danger)]">
                      <Trash2 className="size-3.5" />
                    </button>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
