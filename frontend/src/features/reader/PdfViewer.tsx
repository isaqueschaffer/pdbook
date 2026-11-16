import { Minus, Plus, ScanLine } from "lucide-react";
import { getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import { useEffect, useMemo, useRef, useState } from "react";

import { Spinner } from "../../components/ui";
import { ApiError, api } from "../../services/api";
import { PDFJS_ASSETS } from "../../services/pdfjs";

interface Props {
  bookId: string;
  initialPage: number;
  onPageChange: (page: number, total: number) => void;
  topOffset: number;
}

/**
 * Original-layout viewer. Pages are rendered lazily as they approach the viewport and their canvases
 * are released when far away, so long documents stay light on memory (important on phones).
 */
export function PdfViewer({ bookId, initialPage, onPageChange, topOffset }: Props) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [baseSize, setBaseSize] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [containerWidth, setContainerWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const restored = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    let release: (() => void) | undefined;
    api
      .pdfSource(bookId)
      .then(async (source) => {
        release = source.release;
        if (cancelled) return release?.();
        task = getDocument({ url: source.url, httpHeaders: source.httpHeaders, withCredentials: source.withCredentials, ...PDFJS_ASSETS });
        const pdf = await task.promise;
        if (cancelled) return;
        const first = await pdf.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        setBaseSize({ w: vp.width, h: vp.height });
        setDoc(pdf);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof ApiError ? e.message : "Não foi possível abrir o PDF original."));
    return () => {
      cancelled = true;
      void task?.destroy();
      release?.();
    };
  }, [bookId]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = useMemo(() => {
    if (!baseSize || !containerWidth) return 1;
    if (zoom === "fit") return Math.min(2.5, (containerWidth - 32) / baseSize.w);
    return zoom;
  }, [baseSize, containerWidth, zoom]);

  // Restore the initial page once the layout is known.
  useEffect(() => {
    if (!doc || !baseSize || !containerWidth || restored.current) return;
    restored.current = true;
    const el = document.getElementById(`pdf-page-${initialPage}`);
    if (el) window.scrollTo({ top: el.offsetTop - topOffset - 8 });
  }, [doc, baseSize, containerWidth, initialPage, topOffset]);

  // Report the page at the top of the viewport.
  useEffect(() => {
    if (!doc) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const pages = containerRef.current?.querySelectorAll<HTMLElement>("[data-page]");
        if (!pages) return;
        const probe = topOffset + window.innerHeight * 0.25;
        for (const p of pages) {
          const r = p.getBoundingClientRect();
          if (r.bottom > probe) {
            onPageChange(Number(p.dataset.page), doc.numPages);
            break;
          }
        }
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [doc, onPageChange, topOffset]);

  const step = (dir: 1 | -1) => setZoom((z) => Math.max(0.5, Math.min(3, Math.round(((z === "fit" ? scale : z) + dir * 0.25) * 4) / 4)));

  return (
    <div ref={containerRef} className="relative mx-auto w-full max-w-[1400px] px-2 pb-24 sm:px-4">
      {error && <p className="py-20 text-center text-sm opacity-75">{error}</p>}
      {!doc && !error && (
        <div className="flex justify-center py-24">
          <Spinner className="size-6" />
        </div>
      )}
      {doc && baseSize && (
        <div className="flex flex-col items-center gap-4 py-4">
          {Array.from({ length: doc.numPages }, (_, i) => (
            <PdfPage key={i + 1} doc={doc} number={i + 1} scale={scale} base={baseSize} />
          ))}
        </div>
      )}
      {doc && (
        <div className="fixed bottom-16 right-4 z-20 flex items-center gap-1 rounded-full border border-[var(--r-line)] bg-[var(--r-panel)] p-1 shadow-lg sm:bottom-6">
          <button className="rounded-full p-2 hover:bg-black/5" onClick={() => step(-1)} aria-label="Diminuir zoom">
            <Minus className="size-4" />
          </button>
          <button className="rounded-full px-2 py-1 text-xs tabular-nums hover:bg-black/5" onClick={() => setZoom("fit")} aria-label="Ajustar à largura">
            {zoom === "fit" ? <ScanLine className="size-4" /> : `${Math.round(scale * 100)}%`}
          </button>
          <button className="rounded-full p-2 hover:bg-black/5" onClick={() => step(1)} aria-label="Aumentar zoom">
            <Plus className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}

function PdfPage({ doc, number, scale, base }: { doc: PDFDocumentProxy; number: number; scale: number; base: { w: number; h: number } }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [size, setSize] = useState<{ w: number; h: number }>(base);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: "150% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible || !canvas) return;
    let task: RenderTask | null = null;
    let cancelled = false;
    doc.getPage(number).then((page) => {
      if (cancelled) return;
      const vp1 = page.getViewport({ scale: 1 });
      setSize({ w: vp1.width, h: vp1.height });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale: scale * ratio });
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      task = page.render({ canvas, viewport: vp });
      task.promise.catch(() => {});
    });
    return () => {
      cancelled = true;
      task?.cancel();
      // Free the bitmap memory of pages that scrolled far away.
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [visible, doc, number, scale]);

  return (
    <div
      ref={wrapRef}
      id={`pdf-page-${number}`}
      data-page={number}
      className="relative bg-white shadow-[0_1px_3px_rgba(0,0,0,.15),0_8px_24px_-12px_rgba(0,0,0,.3)]"
      style={{ width: size.w * scale, height: size.h * scale }}
    >
      <canvas ref={canvasRef} className="block size-full" aria-label={`Página ${number}`} />
      <span className="absolute -left-10 top-1 hidden text-xs tabular-nums opacity-50 lg:block">{number}</span>
    </div>
  );
}
