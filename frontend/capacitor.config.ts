import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "br.com.pdbook.app",
  appName: "PDBook",
  // Output of `npm run build:app` (vite --mode app).
  webDir: "dist-app",
  android: {
    // PDFs and their conversion stay inside the app; the WebView only talks to the PDBook API.
    allowMixedContent: false,
  },
};

export default config;
