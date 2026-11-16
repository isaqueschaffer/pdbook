import { ArrowRight, BookOpen, HardDrive, Library, Loader2, Upload } from "lucide-react";
import { Link } from "react-router";

import { Alert, Button, Card, EmptyState, PageLoader, ProgressBar } from "../components/ui";
import { useMe } from "../features/auth/auth";
import { BookCard, readerHref } from "../features/library/BookCard";
import { BookCover } from "../features/library/BookCover";
import { useDashboard } from "../features/library/hooks";
import { usePublicConfig } from "../services/config";
import { formatBytes, formatRelative } from "../services/format";
import { IS_APP } from "../services/platform";

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}

export function DashboardPage() {
  const { data: user } = useMe();
  const { data, isLoading, isError, refetch } = useDashboard();
  const { data: config } = usePublicConfig();

  if (isLoading) return <PageLoader />;
  if (isError || !data)
    return (
      <Alert tone="danger">
        Não foi possível carregar o painel.{" "}
        <button className="underline" onClick={() => refetch()}>
          Tentar novamente
        </button>
      </Alert>
    );

  const firstName = user?.display_name.split(" ")[0];
  const storagePct = data.storage.limit_bytes ? (data.storage.used_bytes / data.storage.limit_bytes) * 100 : 0;

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          {greeting()}, {firstName}
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          {data.total_books === 0 ? "Comece importando seu primeiro PDF." : "Que tal continuar a leitura?"}
        </p>
      </div>

      {data.storage.warn && (
        <Alert tone={data.storage.full ? "danger" : "warning"} className="mb-6">
          {IS_APP
            ? data.storage.full
              ? "O aparelho está sem espaço. Remova livros deste aparelho para importar novos."
              : "O espaço livre no aparelho está acabando."
            : data.storage.full
              ? "O armazenamento do servidor está cheio. Novos envios estão bloqueados até que espaço seja liberado."
              : "O armazenamento do servidor está próximo do limite configurado."}
        </Alert>
      )}

      {data.total_books === 0 ? (
        <Card>
          <EmptyState
            icon={<BookOpen className="size-5" />}
            title="Sua biblioteca está vazia"
            action={
              <Link to="/importar">
                <Button icon={<Upload className="size-4" />}>Importar PDF</Button>
              </Link>
            }
          >
            Envie um PDF e o PDBook o transforma em um livro com fonte ajustável, temas de leitura e marcadores.
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-10">
          {data.continue_reading.length > 0 && (
            <section aria-labelledby="continue">
              <h2 id="continue" className="mb-4 text-sm font-semibold uppercase tracking-wider text-ink-faint">
                Continuar lendo
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {data.continue_reading.map((b) => (
                  <Link
                    key={b.id}
                    to={readerHref(b)}
                    className="flex gap-4 rounded-xl border border-line bg-surface p-4 transition-colors hover:border-accent/40"
                  >
                    <BookCover id={b.id} title={b.title} className="w-16 shrink-0 !p-1.5 [&_p]:text-[7px]" />
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 font-medium leading-snug">{b.title}</p>
                      <p className="mt-1 text-xs text-ink-faint">Lido {formatRelative(b.progress?.updated_at)}</p>
                      <div className="mt-3 flex items-center gap-3">
                        <ProgressBar value={b.progress?.percent ?? 0} className="flex-1" label="Progresso de leitura" />
                        <span className="text-xs tabular-nums text-ink-soft">{Math.round(b.progress?.percent ?? 0)}%</span>
                      </div>
                    </div>
                    <ArrowRight className="mt-1 size-4 shrink-0 text-ink-faint" aria-hidden />
                  </Link>
                ))}
              </div>
            </section>
          )}

          <section aria-labelledby="stats" className="grid gap-4 sm:grid-cols-3">
            <h2 id="stats" className="sr-only">
              Resumo
            </h2>
            <Stat icon={<Library className="size-4" />} label="Livros" value={data.total_books} sub={data.ready_books === 1 ? "1 pronto para ler" : `${data.ready_books} prontos para ler`} />
            <Stat
              icon={<Loader2 className={`size-4 ${data.processing_books ? "animate-spin" : ""}`} />}
              label="Em processamento"
              value={data.processing_books}
              sub={data.processing_books ? "Atualizando automaticamente" : "Nenhuma conversão na fila"}
            />
            <Stat
              icon={<HardDrive className="size-4" />}
              label={IS_APP ? "Neste aparelho" : "Seu armazenamento"}
              value={formatBytes(data.storage.user_used_bytes ?? 0)}
              sub={
                IS_APP
                  ? data.storage.limit_bytes
                    ? `${formatBytes(data.storage.disk_free_bytes)} livres`
                    : "Livros guardados no aparelho"
                  : data.storage.user_limit_bytes
                  ? `de ${formatBytes(data.storage.user_limit_bytes)}`
                  : `Servidor: ${Math.round(storagePct)}% de ${formatBytes(data.storage.limit_bytes)}`
              }
            />
          </section>

          <section aria-labelledby="recent">
            <div className="mb-4 flex items-center justify-between">
              <h2 id="recent" className="text-sm font-semibold uppercase tracking-wider text-ink-faint">
                Adicionados recentemente
              </h2>
              <Link to="/biblioteca" className="text-sm font-medium text-accent hover:underline">
                Ver biblioteca
              </Link>
            </div>
            <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 lg:grid-cols-6">
              {data.recent.map((b) => (
                <BookCard key={b.id} book={b} config={config} />
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub: string }) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-xs font-medium text-ink-faint">
        {icon}
        {label}
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs text-ink-soft">{sub}</p>
    </Card>
  );
}
