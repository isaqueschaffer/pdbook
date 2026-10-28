import { ChevronLeft, ChevronRight, Copy, StickyNote } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { api } from "../../services/api";
import type { Block, Bookmark, ChapterContent, HighlightColor, Preferences } from "../../services/types";
import { rangesForBlock, segment, textOffset } from "./positions";
import { readerStyle } from "./usePreferences";

export const TOOLBAR = 56;
const PROBE = TOOLBAR + 12;

export interface Position {
  block: number;
  offset: number;
  page: number;
  atEnd: boolean;
}

export interface Target {
  block: number;
  offset: number;
  flash?: boolean;
}

export interface SelectionDraft {
  block: number;
  start: number;
  endBlock: number;
  end: number;
  quote: string;
  page: number;
}

interface Props {
  bookId: string;
  chapter: ChapterContent;
  chapterCount: number;
  marks: Bookmark[];
  prefs: Preferences;
  target: Target | null;
  onTargetDone: () => void;
  onPosition: (p: Position) => void;
  onHighlight: (d: SelectionDraft, color: HighlightColor) => void;
  onNote: (d: SelectionDraft) => void;
  onMarkClick: (id: string) => void;
  onNavigate: (chapter: number) => void;
  /** A plain tap on the text (no selection, not on a highlight) toggles the toolbars. */
  onTap: () => void;
}

export function BookView(props: Props) {
  const { chapter, prefs, target, onTargetDone, onPosition } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ block: number; offset: number }>({ block: 0, offset: 0 });
  const [selection, setSelection] = useState<{ draft: SelectionDraft; x: number; y: number } | null>(null);

  const scrollToBlock = useCallback((block: number, offset: number, flash = false) => {
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-block="${block}"]`);
    if (!el || (block === 0 && offset === 0 && !flash)) {
      window.scrollTo({ top: 0 });
      return;
    }
    const rect = el.getBoundingClientRect();
    window.scrollTo({ top: Math.max(0, rect.top + window.scrollY + offset * rect.height - PROBE + 1) });
    if (flash) {
      el.classList.remove("flash");
      void el.offsetWidth; // restart the animation
      el.classList.add("flash");
    }
  }, []);

  // Jump to the requested position once the chapter is in the DOM.
  useLayoutEffect(() => {
    if (!target) return;
    scrollToBlock(target.block, target.offset, target.flash);
    anchor.current = { block: target.block, offset: target.offset };
    onTargetDone();
  }, [target, chapter, scrollToBlock, onTargetDone]);

  // Keep the reading position fixed while typography changes reflow the text.
  const layoutKey = `${prefs.font_size}|${prefs.line_height}|${prefs.paragraph_spacing}|${prefs.margin}|${prefs.max_width}|${prefs.font_family}|${prefs.justify}`;
  const firstLayout = useRef(true);
  useLayoutEffect(() => {
    if (firstLayout.current) {
      firstLayout.current = false;
      return;
    }
    scrollToBlock(anchor.current.block, anchor.current.offset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  // Track the block at the top of the viewport.
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      const root = rootRef.current;
      if (!root) return;
      const blocks = root.querySelectorAll<HTMLElement>("[data-block]");
      let lo = 0;
      let hi = blocks.length - 1;
      let found = blocks.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (blocks[mid].getBoundingClientRect().bottom > PROBE) {
          found = mid;
          hi = mid - 1;
        } else lo = mid + 1;
      }
      const el = blocks[found];
      if (!el) return;
      const r = el.getBoundingClientRect();
      const offset = Math.max(0, Math.min(1, (PROBE - r.top) / Math.max(r.height, 1)));
      const block = Number(el.dataset.block);
      anchor.current = { block, offset };
      const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      onPosition({ block, offset, page: Number(el.dataset.page) || 1, atEnd });
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    const t = window.setTimeout(measure, 50);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [chapter, onPosition]);

  // Text selection -> floating highlight menu.
  useEffect(() => {
    let t = 0;
    const read = () => {
      const sel = window.getSelection();
      const root = rootRef.current;
      if (!sel || sel.isCollapsed || !sel.rangeCount || !root) return setSelection(null);
      const range = sel.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) return setSelection(null);
      const startEl = (range.startContainer.nodeType === 1 ? (range.startContainer as Element) : range.startContainer.parentElement)?.closest<HTMLElement>("[data-text]");
      const endEl = (range.endContainer.nodeType === 1 ? (range.endContainer as Element) : range.endContainer.parentElement)?.closest<HTMLElement>("[data-text]");
      if (!startEl || !endEl) return setSelection(null);
      let block = Number(startEl.dataset.block);
      let start = textOffset(startEl, range.startContainer, range.startOffset);
      let endBlock = Number(endEl.dataset.block);
      let end = textOffset(endEl, range.endContainer, range.endOffset);
      if (endBlock > block && end === 0) {
        // Selection ends at the very start of the next block: clip to the previous one.
        endBlock -= 1;
        end = chapter.blocks[endBlock]?.text?.length ?? 0;
      }
      if (block === endBlock && end <= start) return setSelection(null);
      if (start >= (chapter.blocks[block]?.text?.length ?? 0)) {
        block += 1;
        start = 0;
      }
      const quote = sel.toString().replace(/\s+/g, " ").trim().slice(0, 5000);
      if (!quote) return setSelection(null);
      const rect = range.getBoundingClientRect();
      setSelection({
        draft: { block, start, endBlock, end, quote, page: Number(startEl.dataset.page) || 1 },
        x: Math.min(Math.max(rect.left + rect.width / 2, 120), window.innerWidth - 120),
        y: rect.top,
      });
    };
    const onChange = () => {
      window.clearTimeout(t);
      t = window.setTimeout(read, 250);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("selectionchange", onChange);
      window.clearTimeout(t);
    };
  }, [chapter]);

  const clearSelection = () => {
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  };

  const marksByBlock = useMemo(() => {
    const map = new Map<number, Bookmark[]>();
    for (const m of props.marks) {
      if (m.kind === "bookmark" || m.start_offset == null) continue;
      for (let b = m.block_index; b <= (m.end_block_index ?? m.block_index); b++) {
        if (!map.has(b)) map.set(b, []);
        map.get(b)!.push(m);
      }
    }
    return map;
  }, [props.marks]);

  return (
    <div className="pb-24 pt-[calc(56px+2.5rem)]">
      <article
        ref={rootRef}
        className="book-text"
        data-font={prefs.font_family}
        data-justify={prefs.justify}
        style={readerStyle(prefs)}
        lang="pt"
        onClick={(e) => {
          if (!window.getSelection()?.isCollapsed) return;
          const target = e.target as HTMLElement;
          const mark = target.closest<HTMLElement>("mark[data-id]");
          if (mark) props.onMarkClick(mark.dataset.id!);
          else if (!target.closest("button, a")) props.onTap();
        }}
      >
        {chapter.blocks.map((b, i) => (
          <BlockView key={i} block={b} index={i} bookId={props.bookId} version={chapter.content_version} marks={marksByBlock.get(i)} />
        ))}

        <nav className="mt-16 flex items-center justify-between gap-4 border-t border-[var(--r-line)] pt-6 font-sans text-sm" aria-label="Capítulos">
          <button
            disabled={chapter.index === 0}
            onClick={() => props.onNavigate(chapter.index - 1)}
            className="flex items-center gap-1 rounded-lg px-3 py-2 opacity-75 hover:bg-black/5 hover:opacity-100 disabled:invisible"
          >
            <ChevronLeft className="size-4" /> Anterior
          </button>
          <span className="text-xs opacity-50">
            {chapter.index + 1} / {props.chapterCount}
          </span>
          {chapter.index + 1 < props.chapterCount ? (
            <button
              onClick={() => props.onNavigate(chapter.index + 1)}
              className="flex items-center gap-1 rounded-lg bg-[var(--r-accent)] px-4 py-2 font-medium text-[var(--r-bg)] hover:opacity-90"
            >
              Próximo capítulo <ChevronRight className="size-4" />
            </button>
          ) : (
            <span className="px-3 py-2 text-xs opacity-60">Fim do livro</span>
          )}
        </nav>
      </article>

      {selection && (
        <div
          role="toolbar"
          aria-label="Ações para o trecho selecionado"
          className="fixed z-30 flex -translate-x-1/2 -translate-y-full items-center gap-1 rounded-xl border border-[var(--r-line)] bg-[var(--r-panel)] p-1.5 font-sans shadow-xl"
          style={{ left: selection.x, top: Math.max(selection.y - 10, TOOLBAR + 52) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {(["yellow", "green", "blue", "pink"] as HighlightColor[]).map((c) => (
            <button
              key={c}
              aria-label={`Destacar em ${{ yellow: "amarelo", green: "verde", blue: "azul", pink: "rosa" }[c]}`}
              onClick={() => {
                props.onHighlight(selection.draft, c);
                clearSelection();
              }}
              className="size-7 rounded-full ring-1 ring-black/10 transition hover:scale-110"
              style={{ background: `var(--r-mark-${c})` }}
            />
          ))}
          <span className="mx-1 h-5 w-px bg-[var(--r-line)]" />
          <button
            onClick={() => {
              props.onNote(selection.draft);
              clearSelection();
            }}
            className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium hover:bg-black/5"
          >
            <StickyNote className="size-3.5" /> Anotar
          </button>
          <button
            aria-label="Copiar"
            onClick={() => {
              void navigator.clipboard?.writeText(selection.draft.quote);
              clearSelection();
            }}
            className="rounded-lg p-1.5 hover:bg-black/5"
          >
            <Copy className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

const BlockView = memo(function BlockView({ block, index, bookId, version, marks }: { block: Block; index: number; bookId: string; version: number; marks?: Bookmark[] }) {
  if (block.type === "image" && block.image) {
    return (
      <figure data-block={index} data-page={block.page}>
        <img
          src={api.imageUrl(bookId, block.image, version)}
          width={block.width ?? undefined}
          height={block.height ?? undefined}
          loading="lazy"
          decoding="async"
          alt={`Figura da página ${block.page}`}
        />
      </figure>
    );
  }
  const text = block.text ?? "";
  const segments = segment(text, marks ? rangesForBlock(marks, index, text.length) : []);
  const content = segments.map((s, k) =>
    s.mark ? (
      <mark key={k} data-id={s.mark.id} data-color={s.mark.color} data-note={s.mark.note}>
        {s.text}
      </mark>
    ) : (
      s.text
    ),
  );
  const common = { "data-block": index, "data-page": block.page, "data-text": true } as const;
  if (block.type === "heading") {
    const level = Math.min(Math.max(block.level ?? 2, 1), 3);
    if (level === 1) return <h1 {...common}>{content}</h1>;
    if (level === 2) return <h2 {...common}>{content}</h2>;
    return <h3 {...common}>{content}</h3>;
  }
  if (block.type === "list_item") return <li {...common}>{content}</li>;
  return <p {...common}>{content}</p>;
});
