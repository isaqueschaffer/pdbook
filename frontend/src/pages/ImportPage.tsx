import { AlertTriangle, CheckCircle2, FileUp, Loader2, X } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { Link } from "react-router";

import { Alert, Card, PageHeader, ProgressBar } from "../components/ui";
import { readerHref } from "../features/library/BookCard";
import { useBook, useInvalidateLibrary } from "../features/library/hooks";
import { StatusBadge } from "../features/library/StatusBadge";
import { ApiError, uploadBook } from "../services/api";
import { usePublicConfig } from "../services/config";
import { formatBytes } from "../services/format";

interface Item {
  key: string;
  file: File;
  state: "queued" | "uploading" | "done" | "error";
  progress: number;
  error?: string;
  bookId?: string;
  existingId?: string;
  abort?: AbortController;
}

export function ImportPage() {
  const { data: config } = usePublicConfig();
  const invalidate = useInvalidateLibrary();
  const [items, setItems] = useState<Item[]>([]);
  const [ocr, setOcr] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const running = useRef(false);
  const queue = useRef<Item[]>([]);

  const maxBytes = (config?.max_upload_mb ?? 50) * 1024 * 1024;

  function patch(key: string, data: Partial<Item>) {
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...data } : i)));
  }

  async function pump() {
    if (running.current) return;
    running.current = true;
    while (queue.current.length) {
      const item = queue.current.shift()!;
      const abort = new AbortController();
      patch(item.key, { state: "uploading", abort });
      try {
        const book = await uploadBook(item.file, { ocr }, (p) => patch(item.key, { progress: p }), abort.signal);
        patch(item.key, { state: "done", progress: 100, bookId: book.id });
        invalidate();
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError(0, "Falha no envio.");
        const existing =
          err.status === 409 && err.data && typeof err.data === "object"
            ? ((err.data as { detail?: { book_id?: string } }).detail?.book_id ?? undefined)
            : undefined;
        patch(item.key, { state: "error", error: err.message, existingId: existing });
      }
    }
    running.current = false;
  }

  function addFiles(files: FileList | File[]) {
    const fresh: Item[] = [];
    for (const file of Array.from(files)) {
      const key = `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`;
      const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      if (!isPdf) {
        fresh.push({ key, file, state: "error", progress: 0, error: "Apenas arquivos PDF são aceitos." });
      } else if (file.size > maxBytes) {
        fresh.push({ key, file, state: "error", progress: 0, error: `O arquivo excede o limite de ${config?.max_upload_mb ?? 50} MB.` });
      } else {
        const item: Item = { key, file, state: "queued", progress: 0 };
        fresh.push(item);
        queue.current.push(item);
      }
    }
    setItems((list) => [...fresh, ...list]);
    void pump();
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  }

  return (
    <div className="max-w-3xl">
      <PageHeader title="Importar documentos" description="Envie PDFs para sua biblioteca. A conversão acontece em segundo plano." />

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex flex-col items-center rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-colors ${
          dragging ? "border-accent bg-accent-soft" : "border-line bg-surface"
        }`}
      >
        <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent">
          <FileUp className="size-5" aria-hidden />
        </div>
        <p className="font-medium">Arraste PDFs para cá</p>
        <p className="mt-1 text-sm text-ink-soft">
          ou{" "}
          <button type="button" onClick={() => inputRef.current?.click()} className="font-medium text-accent underline-offset-2 hover:underline">
            escolha arquivos
          </button>
        </p>
        <p className="mt-4 text-xs text-ink-faint">
          Até {config?.max_upload_mb ?? 50} MB e {config?.max_pdf_pages ?? 250} páginas por arquivo. PDFs protegidos por senha não são suportados.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {config?.ocr_enabled && (
        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface p-4">
          <input type="checkbox" checked={ocr} onChange={(e) => setOcr(e.target.checked)} className="mt-0.5 size-4 accent-[var(--accent)]" />
          <span className="text-sm">
            <span className="font-medium">Reconhecer texto com OCR</span>
            <span className="mt-0.5 block text-ink-soft">
              Para documentos digitalizados (fotos ou scans de páginas). É mais lento e processa um documento por vez. Se você não marcar, o PDBook avisa
              quando o PDF parecer digitalizado e você poderá ativar o OCR depois.
            </span>
          </span>
        </label>
      )}

      {items.length > 0 && (
        <Card className="mt-8 divide-y divide-line">
          {items.map((item) => (
            <UploadRow
              key={item.key}
              item={item}
              onCancel={() => item.abort?.abort()}
              onRemove={() => setItems((l) => l.filter((i) => i.key !== item.key))}
            />
          ))}
        </Card>
      )}

      <Alert className="mt-8">
        O arquivo original é sempre preservado: mesmo que a conversão para o modo Livro não fique perfeita (tabelas, fórmulas, layouts complexos), você
        pode ler o PDF original a qualquer momento.
      </Alert>
    </div>
  );
}

function UploadRow({ item, onCancel, onRemove }: { item: Item; onCancel: () => void; onRemove: () => void }) {
  const { data: book } = useBook(item.bookId);
  return (
    <div className="flex items-center gap-4 p-4">
      <div className="shrink-0">
        {item.state === "error" ? (
          <AlertTriangle className="size-5 text-danger" />
        ) : item.state === "done" && book?.status === "ready" ? (
          <CheckCircle2 className="size-5 text-success" />
        ) : (
          <Loader2 className={`size-5 text-ink-faint ${item.state === "queued" ? "" : "animate-spin"}`} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{book?.title ?? item.file.name}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-soft">
          <span>{formatBytes(item.file.size)}</span>
          {item.state === "queued" && <span>· Na fila de envio</span>}
          {item.state === "uploading" && <span>· Enviando {item.progress}%</span>}
          {item.state === "error" && <span className="text-danger">· {item.error}</span>}
          {item.existingId && (
            <Link to={`/ler/${item.existingId}`} className="font-medium text-accent hover:underline">
              Abrir o existente
            </Link>
          )}
          {book && <StatusBadge book={book} />}
          {book?.status_message && book.status !== "ready" && <span>{book.status_message}</span>}
        </div>
        {item.state === "uploading" && <ProgressBar value={item.progress} className="mt-2" label="Progresso do envio" />}
        {book?.status === "processing" && book.job && <ProgressBar value={book.job.progress} className="mt-2" label="Progresso da conversão" />}
      </div>
      {book && (book.status === "ready" || book.status === "needs_ocr" || book.status === "failed") && (
        <Link to={readerHref(book)} className="shrink-0 text-sm font-medium text-accent hover:underline">
          Abrir
        </Link>
      )}
      {item.state === "uploading" && (
        <button onClick={onCancel} aria-label="Cancelar envio" className="rounded-md p-1 text-ink-faint hover:text-ink">
          <X className="size-4" />
        </button>
      )}
      {item.state === "error" && (
        <button onClick={onRemove} aria-label="Remover da lista" className="rounded-md p-1 text-ink-faint hover:text-ink">
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}
