import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";

import { ConfirmDialog } from "../components/Dialog";
import { useToast } from "../components/toast";
import { Alert, Button, Card, PageHeader, ProgressBar, TextField } from "../components/ui";
import { ME_KEY, useMe } from "../features/auth/auth";
import { SettingsPanel } from "../features/reader/SettingsPanel";
import { usePreferences, readerStyle } from "../features/reader/usePreferences";
import { ApiError, api } from "../services/api";
import { formatBytes } from "../services/format";

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card className="p-6">
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="mt-1 text-sm text-ink-soft">{description}</p>}
      <div className="mt-5">{children}</div>
    </Card>
  );
}

export function AccountSettingsPage() {
  const { data: user } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const storage = useQuery({ queryKey: ["storage"], queryFn: api.storage });

  const [name, setName] = useState(user?.display_name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [emailPassword, setEmailPassword] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [savingPw, setSavingPw] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const emailChanged = !!user && email.trim().toLowerCase() !== user.email;

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    setSavingProfile(true);
    try {
      const updated = await api.updateAccount({ display_name: name, ...(emailChanged ? { email, current_password: emailPassword } : {}) });
      qc.setQueryData(ME_KEY, updated);
      setEmailPassword("");
      toast("Perfil atualizado.", "success");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Não foi possível salvar.", "error");
    } finally {
      setSavingProfile(false);
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setSavingPw(true);
    setPwError(null);
    try {
      await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      toast("Senha alterada. As outras sessões foram encerradas.", "success");
    } catch (err) {
      setPwError(err instanceof ApiError ? err.message : "Não foi possível alterar a senha.");
    } finally {
      setSavingPw(false);
    }
  }

  async function logoutAll() {
    await api.logoutAll().catch(() => {});
    qc.clear();
    qc.setQueryData(ME_KEY, null);
    navigate("/entrar");
  }

  async function deleteAccount() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteAccount(deletePassword);
      qc.clear();
      qc.setQueryData(ME_KEY, null);
      navigate("/cadastro");
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Não foi possível excluir a conta.");
    } finally {
      setDeleting(false);
    }
  }

  const st = storage.data;
  const userLimit = st?.user_limit_bytes ?? null;

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Conta" description="Gerencie seu perfil, sua senha e seus dados." />

      <Section title="Perfil">
        <form onSubmit={saveProfile} className="space-y-4">
          <TextField label="Nome" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
          <TextField label="E-mail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          {emailChanged && (
            <TextField
              label="Senha atual"
              type="password"
              autoComplete="current-password"
              value={emailPassword}
              onChange={(e) => setEmailPassword(e.target.value)}
              hint="Necessária para alterar o e-mail."
            />
          )}
          <Button type="submit" loading={savingProfile} disabled={!name.trim() || (emailChanged && !emailPassword)}>
            Salvar perfil
          </Button>
        </form>
      </Section>

      <Section title="Senha" description="Ao alterar a senha, todas as outras sessões abertas são encerradas.">
        <form onSubmit={changePassword} className="space-y-4">
          {pwError && <Alert tone="danger">{pwError}</Alert>}
          <TextField label="Senha atual" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          <TextField
            label="Nova senha"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            hint="Mínimo de 8 caracteres, com letras e números ou símbolos."
          />
          <Button type="submit" loading={savingPw} disabled={!current || next.length < 8}>
            Alterar senha
          </Button>
        </form>
      </Section>

      <Section title="Armazenamento">
        {st ? (
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-ink-soft">Usado pelos seus livros</span>
              <span className="font-medium tabular-nums">
                {formatBytes(st.user_used_bytes ?? 0)}
                {userLimit ? ` de ${formatBytes(userLimit)}` : ""}
              </span>
            </div>
            {userLimit && <ProgressBar value={((st.user_used_bytes ?? 0) / userLimit) * 100} label="Uso da sua cota" />}
            <div className="flex justify-between">
              <span className="text-ink-soft">Servidor</span>
              <span className="tabular-nums">
                {formatBytes(st.used_bytes)} de {formatBytes(st.limit_bytes)}
              </span>
            </div>
            <ProgressBar value={(st.used_bytes / st.limit_bytes) * 100} label="Uso do servidor" />
            {st.warn && (
              <Alert tone={st.full ? "danger" : "warning"}>
                {st.full ? "O armazenamento está cheio; novos envios estão bloqueados." : "O armazenamento está próximo do limite."}
              </Alert>
            )}
          </div>
        ) : (
          <p className="text-sm text-ink-faint">Carregando…</p>
        )}
      </Section>

      <Section title="Sessões">
        <Button variant="secondary" onClick={logoutAll}>
          Sair de todos os dispositivos
        </Button>
      </Section>

      <Section title="Excluir conta" description="Remove permanentemente sua conta, todos os livros, arquivos, progresso e anotações.">
        <Button variant="danger" onClick={() => setConfirmDelete(true)}>
          Excluir minha conta
        </Button>
      </Section>

      <ConfirmDialog
        open={confirmDelete}
        danger
        title="Excluir conta definitivamente?"
        confirmLabel="Excluir conta"
        loading={deleting}
        onClose={() => setConfirmDelete(false)}
        onConfirm={deleteAccount}
        message={
          <div className="space-y-3">
            <p>Todos os seus livros e arquivos serão apagados do servidor. Esta ação não pode ser desfeita.</p>
            {deleteError && <Alert tone="danger">{deleteError}</Alert>}
            <TextField label="Confirme com sua senha" type="password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} />
          </div>
        }
      />
    </div>
  );
}

const SAMPLE = [
  "Capítulo 1",
  "Era uma manhã clara quando ela abriu o livro pela primeira vez. As páginas tinham o cheiro de papel antigo e de promessas guardadas por muito tempo.",
  "Cada parágrafo se ajustava ao tamanho da tela, como se o texto tivesse sido escrito para aquele momento. Ela aumentou um pouco a fonte, escolheu o tom sépia e continuou lendo, sem pressa.",
];

export function ReadingSettingsPage() {
  const { prefs, update, reset, isLoading } = usePreferences();
  return (
    <div>
      <PageHeader title="Configurações de leitura" description="Aplicadas a todos os livros no modo Livro e salvas na sua conta." />
      <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
        <Card className="h-fit p-6">{isLoading ? <p className="text-sm text-ink-faint">Carregando…</p> : <SettingsPanel prefs={prefs} update={update} reset={reset} />}</Card>
        <div className="reader overflow-hidden rounded-xl border border-line" data-theme={prefs.theme}>
          <p className="border-b border-[var(--r-line)] px-5 py-2.5 font-sans text-xs opacity-60">Pré-visualização</p>
          <div className="book-text py-8" data-font={prefs.font_family} data-justify={prefs.justify} style={readerStyle(prefs)}>
            <h1>{SAMPLE[0]}</h1>
            <p>{SAMPLE[1]}</p>
            <p>{SAMPLE[2]}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
