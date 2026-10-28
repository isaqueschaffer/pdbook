import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, Home, LibraryBig, LogOut, Settings2, Type, Upload } from "lucide-react";
import { NavLink, Outlet, useNavigate } from "react-router";

import { ME_KEY, useMe } from "../features/auth/auth";
import { api } from "../services/api";
import { Logo } from "./Logo";
import { useToast } from "./toast";
import { cx } from "./ui";

const NAV = [
  { to: "/", label: "Início", icon: Home, end: true },
  { to: "/biblioteca", label: "Biblioteca", icon: LibraryBig },
  { to: "/importar", label: "Importar", icon: Upload },
  { to: "/configuracoes/leitura", label: "Leitura", icon: Type },
  { to: "/configuracoes/conta", label: "Conta", icon: Settings2 },
];

export function AppLayout() {
  const { data: user } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  async function logout() {
    try {
      await api.logout();
    } catch {
      /* the session is gone either way */
    }
    qc.clear();
    qc.setQueryData(ME_KEY, null);
    toast("Você saiu da sua conta.", "info");
    navigate("/entrar");
  }

  return (
    <div className="min-h-screen md:flex">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-surface px-4 py-6 md:flex">
        <NavLink to="/" className="mb-8 px-2">
          <Logo />
        </NavLink>
        <nav className="flex flex-1 flex-col gap-1" aria-label="Principal">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cx(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                  isActive ? "bg-accent-soft font-medium text-accent" : "text-ink-soft hover:bg-surface-2 hover:text-ink",
                )
              }
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line pt-4">
          <p className="truncate px-3 text-sm font-medium text-ink">{user?.display_name}</p>
          <p className="truncate px-3 text-xs text-ink-faint">{user?.email}</p>
          <button onClick={logout} className="mt-3 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-ink-soft hover:bg-surface-2 hover:text-ink">
            <LogOut className="size-4" aria-hidden /> Sair
          </button>
        </div>
      </aside>

      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-surface/90 px-4 backdrop-blur md:hidden">
        <NavLink to="/">
          <Logo />
        </NavLink>
        <button onClick={logout} aria-label="Sair" className="rounded-lg p-2 text-ink-soft hover:bg-surface-2">
          <LogOut className="size-5" />
        </button>
      </header>

      <main className="min-w-0 flex-1 px-4 pb-24 pt-6 sm:px-6 md:px-10 md:pb-12 md:pt-10">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
      </main>

      <nav aria-label="Principal" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => cx("flex flex-col items-center gap-1 py-2.5 text-[11px]", isActive ? "text-accent" : "text-ink-faint")}
          >
            <Icon className="size-5" aria-hidden />
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <div className="mb-8 flex flex-col items-center gap-3 text-center">
        <Logo />
        <p className="flex items-center gap-2 text-sm text-ink-soft">
          <BookOpen className="size-4" aria-hidden /> Seus PDFs, com a leitura de um livro.
        </p>
      </div>
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 shadow-sm sm:p-8">{children}</div>
    </div>
  );
}
