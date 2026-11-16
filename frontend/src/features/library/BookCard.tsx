import { BookOpen, FileText, HardDriveDownload, MoreHorizontal, Pencil, RefreshCw, ScanText, Smartphone, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";

import { ConfirmDialog, Dialog } from "../../components/Dialog";
import { Menu } from "../../components/Menu";
import { useToast } from "../../components/toast";
import { Button, ProgressBar, TextField } from "../../components/ui";
import { ApiError } from "../../services/api";
import { formatBytes } from "../../services/format";
import { IS_APP } from "../../services/platform";
import type { Book, PublicConfig } from "../../services/types";
import { hasBookMode, whereIs } from "./availability";
import { BookCover } from "./BookCover";
import { isActive, useDeleteBook, useRemoveFromDevice, useReprocess, useUpdateBook } from "./hooks";
import { StatusBadge } from "./StatusBadge";

export function readerHref(book: Book) {
  return hasBookMode(book) || whereIs(book) === "elsewhere" ? `/ler/${book.id}` : `/ler/${book.id}?modo=pdf`;
}

/** Tells where the PDF is when it cannot be opened here. */
export function LocationBadge({ book }: { book: Book }) {
  if (whereIs(book) !== "elsewhere") return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-soft">
      <Smartphone className="size-3" /> {IS_APP ? "Em outro aparelho" : "No app"}
    </span>
  );
}

export function BookCard({ book, config }: { book: Book; config?: PublicConfig }) {
  const percent = book.progress?.percent ?? 0;
  return (
    <article className="group relative flex flex-col">
      <Link to={readerHref(book)} className="block rounded-md focus-visible:outline-offset-4" aria-label={`Abrir ${book.title}`}>
        <BookCover id={book.id} title={book.title} author={book.author} className="transition-transform duration-200 group-hover:-translate-y-0.5" />
      </Link>
      <div className="mt-3 flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <Link to={readerHref(book)} className="line-clamp-2 text-sm font-medium leading-snug text-ink hover:underline">
            {book.title}
          </Link>
          {book.author && <p className="mt-0.5 truncate text-xs text-ink-faint">{book.author}</p>}
        </div>
        <BookActions book={book} config={config} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <StatusBadge book={book} />
        <LocationBadge book={book} />
        {book.status === "ready" && percent > 0 && <span className="text-[11px] text-ink-faint">{Math.round(percent)}%</span>}
      </div>
      {book.status === "processing" && book.job && <ProgressBar value={book.job.progress} className="mt-2" label="Progresso da conversão" />}
      {book.status === "ready" && percent > 0 && <ProgressBar value={percent} className="mt-2" label="Progresso de leitura" />}
    </article>
  );
}

export function BookActions({ book, config, onDeleted }: { book: Book; config?: PublicConfig; onDeleted?: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const del = useDeleteBook();
  const reprocess = useReprocess();
  const update = useUpdateBook();
  const removeLocal = useRemoveFromDevice();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author ?? "");

  const busy = isActive(book);
  const where = whereIs(book);
  // Reprocessing needs the PDF: on the server for website uploads, on this phone for app imports.
  const canReprocess = where === "server" || (IS_APP && !!book.device?.file);

  async function runReprocess(ocr: boolean) {
    try {
      await reprocess.mutateAsync({ id: book.id, ocr });
      toast(
        where === "here" ? (ocr ? "OCR iniciado neste aparelho. Isso pode levar alguns minutos." : "Reprocessando neste aparelho.") : ocr ? "OCR agendado. Isso pode levar alguns minutos." : "Reprocessamento agendado.",
        "success",
      );
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Não foi possível reprocessar.", "error");
    }
  }

  async function remove() {
    try {
      await del.mutateAsync(book.id);
      setConfirmDelete(false);
      toast("Livro excluído.", "success");
      onDeleted?.();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Não foi possível excluir.", "error");
    }
  }

  async function freeSpace() {
    try {
      await removeLocal.mutateAsync(book.id);
      toast("PDF removido deste aparelho. O livro, o progresso e as anotações continuam na sua conta.", "success");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Não foi possível remover.", "error");
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await update.mutateAsync({ id: book.id, title, author: author.trim() || null });
      setEditing(false);
      toast("Informações atualizadas.", "success");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Não foi possível salvar.", "error");
    }
  }

  return (
    <>
      <Menu
        label={`Ações para ${book.title}`}
        trigger={<MoreHorizontal className="size-4" />}
        items={[
          { label: "Ler no modo Livro", icon: <BookOpen className="size-4" />, onSelect: () => navigate(`/ler/${book.id}`), hidden: !hasBookMode(book) },
          { label: "Ver PDF original", icon: <FileText className="size-4" />, onSelect: () => navigate(`/ler/${book.id}?modo=pdf`), hidden: where === "elsewhere" },
          {
            label: "Editar título e autor",
            icon: <Pencil className="size-4" />,
            onSelect: () => {
              setTitle(book.title);
              setAuthor(book.author ?? "");
              setEditing(true);
            },
          },
          { label: "Reprocessar texto", icon: <RefreshCw className="size-4" />, onSelect: () => runReprocess(false), disabled: busy, hidden: !canReprocess },
          {
            label: "Processar com OCR",
            icon: <ScanText className="size-4" />,
            onSelect: () => runReprocess(true),
            disabled: busy,
            hidden: !config?.ocr_enabled || !canReprocess,
          },
          {
            label: "Remover deste aparelho",
            icon: <HardDriveDownload className="size-4" />,
            onSelect: freeSpace,
            disabled: busy,
            hidden: !(IS_APP && where === "here" && book.device?.registered),
          },
          { label: "Excluir livro", icon: <Trash2 className="size-4" />, onSelect: () => setConfirmDelete(true), danger: true },
        ]}
      />
      <ConfirmDialog
        open={confirmDelete}
        title="Excluir livro?"
        danger
        loading={del.isPending}
        confirmLabel="Excluir definitivamente"
        onConfirm={remove}
        onClose={() => setConfirmDelete(false)}
        message={
          <>
            <strong className="text-ink">{book.title}</strong> será removido permanentemente da sua conta
            {book.storage_mode === "device" ? " e de todos os aparelhos" : ""}, junto com o PDF original ({formatBytes(book.file_size)}), o conteúdo convertido, o
            progresso, os marcadores e as anotações. Esta ação não pode ser desfeita.
          </>
        }
      />
      <Dialog open={editing} onClose={() => setEditing(false)} title="Editar informações">
        <form onSubmit={save} className="space-y-4">
          <TextField label="Título" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} required />
          <TextField label="Autor" value={author} onChange={(e) => setAuthor(e.target.value)} maxLength={300} />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={update.isPending} disabled={!title.trim()}>
              Salvar
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
