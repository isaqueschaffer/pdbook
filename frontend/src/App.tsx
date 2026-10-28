import { lazy, Suspense } from "react";
import { Link, Route, Routes } from "react-router";

import { AppLayout } from "./components/AppLayout";
import { Button, PageLoader } from "./components/ui";
import { RedirectIfAuthenticated, RequireAuth, SessionWatcher } from "./features/auth/auth";
import { LoginPage, RegisterPage } from "./pages/AuthPages";
import { DashboardPage } from "./pages/DashboardPage";
import { ImportPage } from "./pages/ImportPage";
import { LibraryPage } from "./pages/LibraryPage";
import { AccountSettingsPage, ReadingSettingsPage } from "./pages/SettingsPages";

// The reader pulls in PDF.js (~400 kB); load it only when a book is opened.
const ReaderPage = lazy(() => import("./pages/ReaderPage").then((m) => ({ default: m.ReaderPage })));

export function App() {
  return (
    <>
      <SessionWatcher />
      <Routes>
        <Route
          path="/entrar"
          element={
            <RedirectIfAuthenticated>
              <LoginPage />
            </RedirectIfAuthenticated>
          }
        />
        <Route
          path="/cadastro"
          element={
            <RedirectIfAuthenticated>
              <RegisterPage />
            </RedirectIfAuthenticated>
          }
        />
        <Route
          path="/ler/:id"
          element={
            <RequireAuth>
              <Suspense fallback={<PageLoader />}>
                <ReaderPage />
              </Suspense>
            </RequireAuth>
          }
        />
        <Route
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="biblioteca" element={<LibraryPage />} />
          <Route path="importar" element={<ImportPage />} />
          <Route path="configuracoes/conta" element={<AccountSettingsPage />} />
          <Route path="configuracoes/leitura" element={<ReadingSettingsPage />} />
        </Route>
        <Route
          path="*"
          element={
            <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
              <p className="text-4xl font-semibold text-ink-faint">404</p>
              <p className="text-ink-soft">Página não encontrada.</p>
              <Link to="/">
                <Button variant="secondary">Ir para o início</Button>
              </Link>
            </div>
          }
        />
      </Routes>
    </>
  );
}
