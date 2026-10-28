import { ChevronLeft, ChevronRight, LibraryBig, Search, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";

import { Alert, Button, Card, EmptyState, PageHeader, Spinner } from "../components/ui";
import { BookCard } from "../features/library/BookCard";
import { useBooks } from "../features/library/hooks";
import { usePublicConfig } from "../services/config";

const PAGE_SIZE = 24;
const FILTERS = [
  { value: "", label: "Todos" },
  { value: "ready", label: "Prontos" },
  { value: "active", label: "Processando" },
  { value: "needs_ocr", label: "Digitalizados" },
  { value: "failed", label: "Com falha" },
];

export function LibraryPage() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("pagina")) || 1);
  const status = params.get("status") ?? "";
  const sort = params.get("ordem") ?? "recent";
  const q = params.get("q") ?? "";
  const [search, setSearch] = useState(q);
  const { data: config } = usePublicConfig();
  const { data, isLoading, isError, isFetching, refetch } = useBooks({ page, page_size: PAGE_SIZE, q, status, sort });

  // Debounce the search box into the URL.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (search !== q) update({ q: search, pagina: "" });
    }, 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  function update(next: Record<string, string>) {
    const p = new URLSearchParams(params);
    Object.entries(next).forEach(([k, v]) => (v ? p.set(k, v) : p.delete(k)));
    setParams(p, { replace: true });
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const filtered = !!(q || status);

  return (
    <div>
      <PageHeader
        title="Biblioteca"
        description={data ? `${data.total} ${data.total === 1 ? "livro" : "livros"}` : undefined}
        actions={
          <Link to="/importar">
            <Button icon={<Upload className="size-4" />}>Importar</Button>
          </Link>
        }
      />

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="relative flex-1">
          <span className="sr-only">Buscar na biblioteca</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por título, autor ou arquivo"
            className="h-10 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-sm outline-none placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </label>
        <select
          aria-label="Ordenar"
          value={sort}
          onChange={(e) => update({ ordem: e.target.value === "recent" ? "" : e.target.value, pagina: "" })}
          className="h-10 rounded-lg border border-line bg-surface px-3 text-sm outline-none focus:border-accent"
        >
          <option value="recent">Adicionados recentemente</option>
          <option value="opened">Lidos recentemente</option>
          <option value="title">Título (A–Z)</option>
        </select>
      </div>

      <div className="mb-6 flex flex-wrap gap-2" role="group" aria-label="Filtrar por estado">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => update({ status: f.value, pagina: "" })}
            aria-pressed={status === f.value}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              status === f.value ? "border-accent bg-accent text-accent-ink" : "border-line bg-surface text-ink-soft hover:text-ink"
            }`}
          >
            {f.label}
          </button>
        ))}
        {isFetching && !isLoading && <Spinner className="ml-1 size-4" />}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Spinner className="size-6" />
        </div>
      ) : isError || !data ? (
        <Alert tone="danger">
          Não foi possível carregar a biblioteca.{" "}
          <button className="underline" onClick={() => refetch()}>
            Tentar novamente
          </button>
        </Alert>
      ) : data.items.length === 0 ? (
        <Card>
          {filtered ? (
            <EmptyState icon={<Search className="size-5" />} title="Nenhum livro encontrado">
              Ajuste a busca ou os filtros.
            </EmptyState>
          ) : (
            <EmptyState
              icon={<LibraryBig className="size-5" />}
              title="Nenhum livro ainda"
              action={
                <Link to="/importar">
                  <Button icon={<Upload className="size-4" />}>Importar PDF</Button>
                </Link>
              }
            >
              Os PDFs que você importar aparecem aqui.
            </EmptyState>
          )}
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {data.items.map((b) => (
              <BookCard key={b.id} book={b} config={config} />
            ))}
          </div>
          {totalPages > 1 && (
            <nav className="mt-10 flex items-center justify-center gap-3" aria-label="Paginação">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => update({ pagina: String(page - 1) })} icon={<ChevronLeft className="size-4" />}>
                Anterior
              </Button>
              <span className="text-sm tabular-nums text-ink-soft">
                {page} de {totalPages}
              </span>
              <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => update({ pagina: String(page + 1) })}>
                Próxima <ChevronRight className="size-4" />
              </Button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
