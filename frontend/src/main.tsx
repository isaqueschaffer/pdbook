import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import { App } from "./App";
import { ToastProvider } from "./components/toast";
import { ApiError } from "./services/api";
import { IS_APP } from "./services/platform";
import "./index.css";

if (IS_APP) void import("./device/native").then((m) => m.setupNative());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // The app reads from the phone's database: work even when the browser thinks it is offline.
      networkMode: IS_APP ? "always" : "online",
      // Do not retry client errors (401/403/404/409...).
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
    },
    mutations: { networkMode: IS_APP ? "always" : "online" },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
