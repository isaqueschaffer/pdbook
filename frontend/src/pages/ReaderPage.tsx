import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Bookmark as BookmarkIcon,
  BookmarkCheck,
  FileText,
  List,
  NotebookPen,
  ScanText,
  Search,
  Type,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

import { Dialog } from "../components/Dialog";
import { useToast } from "../components/toast";
import { Button, IconButton, Spinner } from "../components/ui";
import { useBook, useReprocess } from "../features/library/hooks";
import { BookView, TOOLBAR, type Position, type SelectionDraft, type Target } from "../features/reader/BookView";
import { AnnotationsPanel, Drawer, SearchPanel, TocPanel } from "../features/reader/Panels";
import { PdfViewer } from "../features/reader/PdfViewer";
import { blockForPage, chapterForPage, percentAt } from "../features/reader/positions";
import { SettingsPanel } from "../features/reader/SettingsPanel";
import { usePreferences } from "../features/reader/usePreferences";
import { ApiError, api } from "../services/api";
import { usePublicConfig } from "../services/config";
import type { Book, Bookmark, HighlightColor, NewBookmark, Progress } from "../services/types";

type Panel = "toc" | "search" | "notes" | "settings" | null;

export function ReaderPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { data: book, isLoading, isError } = useBook(id);
  const { prefs, update, reset } = usePreferences();

  if (isLoading) {
    return (
      <div className="reader flex min-h-screen items-center justify-center" data-theme={prefs.theme}>
        <Spinner className="size-6" />
      </div>
    );
  }
  if (isError || !book) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-ink-soft">Livro não encontrado.</p>
        <Link to="/biblioteca">
          <Button variant="secondary">Voltar à biblioteca</Button>
        </Link>
      </div>
    );
  }
  const wantsPdf = params.get("modo") === "pdf" || book.chapter_count === 0;
  return (
    <Reader
      key={`${book.id}-${book.content_version}`}
      book={book}
      mode={wantsPdf ? "pdf" : "book"}
      setMode={(m) => setParams(m === "pdf" ? { modo: "pdf" } : {}, { replace: true })}
      prefs={prefs}
      update={update}
      reset={reset}
    />
  );
}

function Reader({
  book,
  mode,
  setMode,
  prefs,
  update,
  reset,
}: {
  book: Book;
  mode: "book" | "pdf";
  setMode: (m: "book" | "pdf") => void;
  prefs: ReturnType<typeof usePreferences>["prefs"];
  update: ReturnType<typeof usePreferences>["update"];
  reset: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { data: config } = usePublicConfig();
  const reprocess = useReprocess();
  const hasContent = book.chapter_count > 0;
  const version = book.content_version;

  const [panel, setPanel] = useState<Panel>(null);
  const [chapterIndex, setChapterIndex] = useState<number | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [pendingPage, setPendingPage] = useState<number | null>(null);
  const [pdfStartPage, setPdfStartPage] = useState<number | null>(null);
  const [percent, setPercent] = useState(book.progress?.percent ?? 0);
  const [chrome, setChrome] = useState(true);
  const [editing, setEditing] = useState<{ draft?: SelectionDraft; mark?: Bookmark } | null>(null);
  const position = useRef<Progress | null>(null);

  const toc = useQuery({ queryKey: ["reader", book.id, "toc", version], queryFn: () => api.toc(book.id), enabled: hasContent, staleTime: Infinity });
  const savedProgress = useQuery({ queryKey: ["reader", book.id, "progress"], queryFn: () => api.progress(book.id), staleTime: 0, gcTime: 0 });
  const marksKey = ["reader", book.id, "bookmarks"];
  const marks = useQuery({ queryKey: marksKey, queryFn: () => api.bookmarks(book.id), enabled: hasContent });
  const chapter = useQuery({
    queryKey: ["reader", book.id, "chapter", version, chapterIndex],
    queryFn: () => api.chapter(book.id, chapterIndex!),
    enabled: hasContent && chapterIndex !== null,
    staleTime: Infinity,
  });
  const chapters = useMemo(() => toc.data?.chapters ?? [], [toc.data]);

  // ---- Resume the last position ----
  useEffect(() => {
    if (!savedProgress.isSuccess) return;
    const p = savedProgress.data;
    if (mode === "pdf") {
      if (pdfStartPage === null) setPdfStartPage(p?.page ?? 1);
      return;
    }
    if (chapterIndex !== null || !toc.data) return;
    if (p && p.content_version === version && p.chapter_index < chapters.length && p.mode === "book") {
      setChapterIndex(p.chapter_index);
      setTarget({ block: p.block_index, offset: p.block_offset });
    } else if (p) {
      // Older content version or last read in PDF mode: map the PDF page to the new structure.
      setChapterIndex(chapterForPage(chapters, p.page));
      setPendingPage(p.page);
    } else {
      setChapterIndex(0);
      setTarget({ block: 0, offset: 0 });
    }
  }, [savedProgress.isSuccess, savedProgress.data, toc.data, chapters, chapterIndex, mode, version, pdfStartPage]);

  useEffect(() => {
    if (pendingPage !== null && chapter.data && chapter.data.index === chapterIndex) {
      setTarget({ block: blockForPage(chapter.data.blocks, pendingPage), offset: 0 });
      setPendingPage(null);
    }
  }, [pendingPage, chapter.data, chapterIndex]);

  // Prefetch the next chapter for instant navigation.
  useEffect(() => {
    if (chapterIndex === null || chapterIndex + 1 >= chapters.length) return;
    void qc.prefetchQuery({ queryKey: ["reader", book.id, "chapter", version, chapterIndex + 1], queryFn: () => api.chapter(book.id, chapterIndex + 1), staleTime: Infinity });
  }, [chapterIndex, chapters.length, qc, book.id, version]);

  // ---- Save progress (debounced, flushed when leaving the page) ----
  const saveTimer = useRef<number | undefined>(undefined);
  const flush = useCallback(
    (keepalive = false) => {
      window.clearTimeout(saveTimer.current);
      const p = position.current;
      if (!p) return;
      api.saveProgress(book.id, p, keepalive).catch(() => {});
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    [book.id, qc],
  );
  const schedule = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => flush(), 1500);
  }, [flush]);

  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && flush(true);
    const onPageHide = () => flush(true);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onHide);
      flush(true);
    };
  }, [flush]);

  const onBookPosition = useCallback(
    (pos: Position) => {
      if (!chapter.data || chapterIndex === null) return;
      const last = chapterIndex === chapters.length - 1;
      const pct = last && pos.atEnd ? 100 : percentAt(chapters, chapterIndex, chapter.data.blocks, pos.block, pos.offset);
      position.current = { content_version: version, chapter_index: chapterIndex, block_index: pos.block, block_offset: pos.offset, page: pos.page, percent: pct, mode: "book" };
      setPercent(pct);
      schedule();
    },
    [chapter.data, chapterIndex, chapters, version, schedule],
  );

  const onPdfPage = useCallback(
    (page: number, total: number) => {
      const pct = total > 1 ? ((page - 1) / (total - 1)) * 100 : 100;
      position.current = {
        content_version: version,
        chapter_index: chapters.length ? chapterForPage(chapters, page) : 0,
        block_index: 0,
        block_offset: 0,
        page,
        percent: pct,
        mode: "pdf",
      };
      setPercent(pct);
      schedule();
    },
    [chapters, version, schedule],
  );

  // ---- Auto-hide the toolbars while reading (only on user scrolling, not on programmatic jumps) ----
  const lastJump = useRef(Date.now());
  useEffect(() => {
    if (target) lastJump.current = Date.now();
  }, [target]);
  useEffect(() => {
    let lastY = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      if (Date.now() - lastJump.current < 1000) {
        lastY = y;
        return;
      }
      if (Math.abs(y - lastY) < 12) return;
      setChrome(y < lastY || y < 120);
      lastY = y;
    };
    const onMove = (e: MouseEvent) => e.clientY < 72 && setChrome(true);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("mousemove", onMove);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "/" && hasContent) {
        e.preventDefault();
        setPanel("search");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hasContent]);

  // ---- Navigation ----
  const go = useCallback(
    (index: number, block = 0, flash = false) => {
      setPanel(null);
      if (mode === "pdf") setMode("book");
      setChapterIndex(index);
      setTarget({ block, offset: 0, flash });
    },
    [mode, setMode],
  );

  function switchMode() {
    flush();
    const p = position.current;
    if (mode === "book") {
      setPdfStartPage(p?.page ?? 1);
      setMode("pdf");
    } else {
      if (p && chapters.length) {
        setChapterIndex(chapterForPage(chapters, p.page));
        setPendingPage(p.page);
      }
      setMode("book");
    }
    window.scrollTo({ top: 0 });
  }

  // ---- Bookmarks, highlights, notes ----
  const create = useMutation({
    mutationFn: (b: NewBookmark) => api.addBookmark(book.id, b),
    onSuccess: (b) => qc.setQueryData<Bookmark[]>(marksKey, (l) => [...(l ?? []), b]),
    onError: (e) => toast(e instanceof ApiError ? e.message : "Não foi possível salvar.", "error"),
  });
  const remove = useMutation({
    mutationFn: (b: Bookmark) => api.deleteBookmark(book.id, b.id),
    onSuccess: (_d, b) => qc.setQueryData<Bookmark[]>(marksKey, (l) => (l ?? []).filter((x) => x.id !== b.id)),
    onError: () => toast("Não foi possível excluir.", "error"),
  });
  const edit = useMutation({
    mutationFn: ({ b, note, color }: { b: Bookmark; note?: string | null; color?: HighlightColor }) => api.updateBookmark(book.id, b.id, { note, color }),
    onSuccess: (b) => qc.setQueryData<Bookmark[]>(marksKey, (l) => (l ?? []).map((x) => (x.id === b.id ? b : x))),
    onError: () => toast("Não foi possível salvar.", "error"),
  });

  const chapterMarks = useMemo(
    () => (marks.data ?? []).filter((m) => m.chapter_index === chapterIndex && m.content_version === version),
    [marks.data, chapterIndex, version],
  );
  const currentBlock = position.current?.mode === "book" ? position.current.block_index : null;
  const bookmarkHere = chapterMarks.find((m) => m.kind === "bookmark" && m.block_index === currentBlock);

  function toggleBookmark() {
    const p = position.current;
    if (!p || chapterIndex === null || !chapter.data) return;
    if (bookmarkHere) {
      remove.mutate(bookmarkHere);
      toast("Marcador removido.", "info");
      return;
    }
    const text = chapter.data.blocks[p.block_index]?.text ?? chapter.data.title;
    create.mutate(
      { kind: "bookmark", content_version: version, chapter_index: chapterIndex, block_index: p.block_index, page: p.page, quote: text.slice(0, 200) },
      { onSuccess: () => toast("Posição marcada.", "success") },
    );
  }

  function highlight(d: SelectionDraft, color: HighlightColor, note?: string) {
    if (chapterIndex === null) return;
    create.mutate({
      kind: note ? "note" : "highlight",
      content_version: version,
      chapter_index: chapterIndex,
      block_index: d.block,
      start_offset: d.start,
      end_block_index: d.endBlock,
      end_offset: d.end,
      page: d.page,
      quote: d.quote,
      color,
      note: note || null,
    });
  }

  const goToMark = (b: Bookmark) => {
    if (b.content_version !== version) {
      toast("Esta anotação pertence a uma versão anterior da conversão; abrindo pela página.", "info");
      if (b.page) {
        setPanel(null);
        setChapterIndex(chapterForPage(chapters, b.page));
        setPendingPage(b.page);
      }
      return;
    }
    go(b.chapter_index, b.block_index, true);
  };

  const chapterTitle = chapters.find((c) => c.index === chapterIndex)?.title;

  return (
    <div className="reader min-h-screen" data-theme={prefs.theme}>
      {/* Top bar */}
      <header
        className={`fixed inset-x-0 top-0 z-30 border-b border-[var(--r-line)] bg-[var(--r-bg)]/95 backdrop-blur transition-transform duration-200 ${
          chrome || panel ? "translate-y-0" : "-translate-y-full"
        }`}
        style={{ height: TOOLBAR }}
      >
        <div className="mx-auto flex h-full max-w-6xl items-center gap-1 px-2 sm:px-4">
          <IconButton label="Voltar à biblioteca" onClick={() => navigate(-1)}>
            <ArrowLeft className="size-5" />
          </IconButton>
          <div className="min-w-0 flex-1 px-2">
            <p className="truncate text-sm font-medium">{book.title}</p>
            <p className="truncate text-xs opacity-60">{mode === "pdf" ? "PDF original" : (chapterTitle ?? "")}</p>
          </div>
          {hasContent && (
            <>
              <IconButton label="Sumário" onClick={() => setPanel("toc")} active={panel === "toc"}>
                <List className="size-5" />
              </IconButton>
              <IconButton label="Buscar no livro (/)" onClick={() => setPanel("search")} active={panel === "search"}>
                <Search className="size-5" />
              </IconButton>
              {mode === "book" && (
                <IconButton label={bookmarkHere ? "Remover marcador" : "Marcar esta posição"} onClick={toggleBookmark} active={!!bookmarkHere}>
                  {bookmarkHere ? <BookmarkCheck className="size-5 text-[var(--r-accent)]" /> : <BookmarkIcon className="size-5" />}
                </IconButton>
              )}
              <IconButton label="Marcadores e anotações" onClick={() => setPanel("notes")} active={panel === "notes"} className="hidden sm:inline-flex">
                <NotebookPen className="size-5" />
              </IconButton>
            </>
          )}
          {mode === "book" && (
            <IconButton label="Aparência do texto" onClick={() => setPanel("settings")} active={panel === "settings"}>
              <Type className="size-5" />
            </IconButton>
          )}
          {hasContent && (
            <IconButton label={mode === "book" ? "Ver PDF original" : "Ver modo Livro"} onClick={switchMode}>
              {mode === "book" ? <FileText className="size-5" /> : <BookOpen className="size-5" />}
            </IconButton>
          )}
        </div>
      </header>

      {/* Status banner when Book mode is not available */}
      {!hasContent && (
        <div className="fixed inset-x-0 z-20 border-b border-[var(--r-line)] bg-[var(--r-panel)] px-4 py-2.5 text-sm" style={{ top: TOOLBAR }}>
          <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-3 gap-y-2">
            {book.status === "pending" || book.status === "processing" ? (
              <>
                <Spinner className="size-4" />
                <span>
                  Convertendo para o modo Livro{book.job?.progress ? ` (${book.job.progress}%)` : ""}. Enquanto isso, leia o PDF original.
                </span>
              </>
            ) : (
              <>
                <AlertTriangle className="size-4 shrink-0 text-[var(--warning)]" />
                <span className="flex-1">{book.status_message ?? "O modo Livro não está disponível para este documento."}</span>
                {config?.ocr_enabled && (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<ScanText className="size-4" />}
                    loading={reprocess.isPending}
                    onClick={() =>
                      reprocess.mutate(
                        { id: book.id, ocr: true },
                        {
                          onSuccess: () => toast("OCR agendado. O modo Livro aparece aqui quando terminar.", "success"),
                          onError: (e) => toast(e instanceof ApiError ? e.message : "Falha ao agendar OCR.", "error"),
                        },
                      )
                    }
                  >
                    Processar com OCR
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Content */}
      <main>
        {mode === "pdf" ? (
          <div style={{ paddingTop: TOOLBAR + (hasContent ? 0 : 52) }}>
            {pdfStartPage !== null ? (
              <PdfViewer url={api.fileUrl(book.id)} initialPage={pdfStartPage} onPageChange={onPdfPage} topOffset={TOOLBAR} />
            ) : (
              <div className="flex justify-center py-24">
                <Spinner className="size-6" />
              </div>
            )}
          </div>
        ) : chapter.data && chapterIndex === chapter.data.index ? (
          <>
            {book.warnings.length > 0 && chapterIndex === 0 && <ConversionNotice book={book} />}
            <BookView
              bookId={book.id}
              chapter={chapter.data}
              chapterCount={chapters.length}
              marks={chapterMarks}
              prefs={prefs}
              target={target}
              onTargetDone={() => setTarget(null)}
              onPosition={onBookPosition}
              onHighlight={(d, c) => highlight(d, c)}
              onNote={(d) => setEditing({ draft: d })}
              onMarkClick={(mid) => {
                const m = chapterMarks.find((x) => x.id === mid);
                if (m) setEditing({ mark: m });
              }}
              onNavigate={(i) => go(i, 0)}
              onTap={() => setChrome((c) => !c)}
            />
          </>
        ) : chapter.isError || toc.isError ? (
          <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="opacity-75">Não foi possível carregar este capítulo.</p>
            <Button variant="secondary" onClick={() => setMode("pdf")}>
              Abrir o PDF original
            </Button>
          </div>
        ) : (
          <div className="flex min-h-screen items-center justify-center">
            <Spinner className="size-6" />
          </div>
        )}
      </main>

      {/* Bottom progress bar */}
      <footer
        className={`fixed inset-x-0 bottom-0 z-20 border-t border-[var(--r-line)] bg-[var(--r-bg)]/95 backdrop-blur transition-transform duration-200 ${
          chrome ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="mx-auto flex h-11 max-w-6xl items-center gap-3 px-4 text-xs pb-[env(safe-area-inset-bottom)]">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--r-line)]" role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100} aria-label="Progresso de leitura">
            <div className="h-full bg-[var(--r-accent)] transition-[width] duration-300" style={{ width: `${percent}%` }} />
          </div>
          <span className="w-10 text-right tabular-nums opacity-70">{Math.round(percent)}%</span>
          <IconButton label="Marcadores e anotações" onClick={() => setPanel("notes")} className="size-8 sm:hidden">
            <NotebookPen className="size-4" />
          </IconButton>
        </div>
      </footer>

      {/* Panels */}
      <Drawer open={panel === "toc"} side="left" title="Sumário" onClose={() => setPanel(null)}>
        {toc.data ? <TocPanel chapters={chapters} current={chapterIndex ?? 0} onGo={(c, b) => go(c, b)} /> : <Spinner />}
      </Drawer>
      <Drawer open={panel === "search"} title="Buscar" onClose={() => setPanel(null)}>
        <SearchPanel bookId={book.id} onGo={(c, b) => go(c, b, true)} />
      </Drawer>
      <Drawer open={panel === "notes"} title="Marcadores e anotações" onClose={() => setPanel(null)}>
        <AnnotationsPanel
          items={marks.data ?? []}
          chapters={chapters}
          onGo={goToMark}
          onDelete={(b) => remove.mutate(b)}
          onEdit={(b) => {
            setPanel(null);
            setEditing({ mark: b });
          }}
        />
      </Drawer>
      <Drawer open={panel === "settings"} title="Aparência do texto" onClose={() => setPanel(null)}>
        <SettingsPanel prefs={prefs} update={update} reset={reset} />
      </Drawer>

      <NoteDialog
        state={editing}
        onClose={() => setEditing(null)}
        onCreate={(d, color, note) => highlight(d, color, note)}
        onSave={(b, note, color) => edit.mutate({ b, note, color })}
        onDelete={(b) => remove.mutate(b)}
      />
    </div>
  );
}

function ConversionNotice({ book }: { book: Book }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mx-auto max-w-2xl px-5 pt-[calc(56px+1rem)] font-sans text-xs">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 opacity-60 hover:opacity-100" aria-expanded={open}>
        <AlertTriangle className="size-3.5" /> Sobre esta conversão
      </button>
      {open && (
        <ul className="mt-2 list-disc space-y-1 rounded-lg border border-[var(--r-line)] p-3 pl-7 opacity-80">
          {book.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const COLORS: HighlightColor[] = ["yellow", "green", "blue", "pink"];

function NoteDialog({
  state,
  onClose,
  onCreate,
  onSave,
  onDelete,
}: {
  state: { draft?: SelectionDraft; mark?: Bookmark } | null;
  onClose: () => void;
  onCreate: (d: SelectionDraft, color: HighlightColor, note: string) => void;
  onSave: (b: Bookmark, note: string | null, color: HighlightColor) => void;
  onDelete: (b: Bookmark) => void;
}) {
  const [note, setNote] = useState("");
  const [color, setColor] = useState<HighlightColor>("yellow");
  useEffect(() => {
    setNote(state?.mark?.note ?? "");
    setColor(state?.mark?.color ?? "yellow");
  }, [state]);

  const quote = state?.draft?.quote ?? state?.mark?.quote ?? "";
  const isNew = !!state?.draft;

  return (
    <Dialog
      open={!!state}
      onClose={onClose}
      title={isNew ? "Nova anotação" : "Destaque"}
      footer={
        <>
          {!isNew && state?.mark && (
            <Button
              variant="ghost"
              className="mr-auto text-danger"
              onClick={() => {
                onDelete(state.mark!);
                onClose();
              }}
            >
              Excluir
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={isNew && !note.trim()}
            onClick={() => {
              if (state?.draft) onCreate(state.draft, color, note.trim());
              else if (state?.mark) onSave(state.mark, note.trim() || null, color);
              onClose();
            }}
          >
            Salvar
          </Button>
        </>
      }
    >
      {quote && <blockquote className="mb-4 line-clamp-6 border-l-2 border-accent pl-3 font-serif text-ink">{quote}</blockquote>}
      <div className="mb-3 flex gap-2" role="radiogroup" aria-label="Cor do destaque">
        {COLORS.map((c) => (
          <button
            key={c}
            role="radio"
            aria-checked={color === c}
            aria-label={c}
            onClick={() => setColor(c)}
            className={`size-7 rounded-full ring-offset-2 ring-offset-surface ${color === c ? "ring-2 ring-accent" : "ring-1 ring-line"}`}
            style={{ background: { yellow: "#fbe9a5", green: "#cfe8d2", blue: "#cfe0f3", pink: "#f6d3df" }[c] }}
          />
        ))}
      </div>
      <label className="block">
        <span className="sr-only">Anotação</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={4}
          maxLength={10000}
          autoFocus
          placeholder="Escreva sua anotação…"
          className="w-full resize-y rounded-lg border border-line bg-surface p-3 text-sm text-ink outline-none focus:border-accent"
        />
      </label>
    </Dialog>
  );
}
