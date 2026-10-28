import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { AuthShell } from "../components/AppLayout";
import { Alert, Button, TextField } from "../components/ui";
import { ME_KEY, safeNext } from "../features/auth/auth";
import { ApiError, api } from "../services/api";

function fieldErrors(e: unknown): Record<string, string> {
  if (e instanceof ApiError && e.data && typeof e.data === "object" && "errors" in e.data) {
    const out: Record<string, string> = {};
    for (const err of (e.data as { errors: { field: string | null; message: string }[] }).errors) {
      if (err.field && !out[err.field]) out[err.field] = err.message;
    }
    return out;
  }
  return {};
}

export function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const user = await api.login(email, password);
      qc.setQueryData(ME_KEY, user);
      navigate(safeNext(params.get("next")), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível entrar.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell>
      <h1 className="text-xl font-semibold">Entrar</h1>
      <p className="mt-1 text-sm text-ink-soft">Continue de onde parou.</p>
      <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <TextField label="E-mail" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        <TextField label="Senha" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button type="submit" loading={loading} className="w-full" disabled={!email || !password}>
          Entrar
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-ink-soft">
        Ainda não tem conta?{" "}
        <Link to="/cadastro" className="font-medium text-accent hover:underline">
          Criar conta
        </Link>
      </p>
    </AuthShell>
  );
}

export function RegisterPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFields({});
    if (password !== confirm) {
      setFields({ confirm: "As senhas não coincidem." });
      return;
    }
    setLoading(true);
    try {
      const user = await api.register(name, email, password);
      qc.setQueryData(ME_KEY, user);
      navigate("/", { replace: true });
    } catch (err) {
      const fe = fieldErrors(err);
      setFields(fe);
      if (!Object.keys(fe).length) setError(err instanceof ApiError ? err.message : "Não foi possível criar a conta.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell>
      <h1 className="text-xl font-semibold">Criar conta</h1>
      <p className="mt-1 text-sm text-ink-soft">Sua biblioteca pessoal, em qualquer dispositivo.</p>
      <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <TextField label="Nome" autoComplete="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} error={fields.display_name} autoFocus />
        <TextField label="E-mail" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={fields.email} />
        <TextField
          label="Senha"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fields.password}
          hint="Mínimo de 8 caracteres, com letras e números ou símbolos."
        />
        <TextField label="Confirmar senha" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} error={fields.confirm} />
        <Button type="submit" loading={loading} className="w-full" disabled={!name || !email || !password}>
          Criar conta
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-ink-soft">
        Já tem conta?{" "}
        <Link to="/entrar" className="font-medium text-accent hover:underline">
          Entrar
        </Link>
      </p>
    </AuthShell>
  );
}
