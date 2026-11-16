import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `--mode app` builds the Capacitor app (see src/services/platform.ts): its own public dir with the
// on-device OCR engine (scripts/prepare-app-public.mjs) and its own output folder.
export default defineConfig(({ mode }) => {
  const app = mode === "app";
  return {
    plugins: [react(), tailwindcss()],
    publicDir: app ? ".app-public" : "public",
    server: {
      port: app ? 5174 : 5173,
      // In development the API runs on :8000; in production Caddy serves both from one origin.
      proxy: app ? undefined : { "/api": { target: "http://localhost:8000", changeOrigin: false } },
    },
    build: {
      target: "es2022",
      sourcemap: false,
      chunkSizeWarningLimit: 1500,
      outDir: app ? "dist-app" : "dist",
    },
  };
});
