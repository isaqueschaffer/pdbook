// Copies PDF.js character maps, standard fonts and wasm decoders into public/ so they are served
// from our own origin (no CDN, compatible with the Content-Security-Policy).
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = dirname(require.resolve("pdfjs-dist/package.json"));
const target = join(import.meta.dirname, "..", "public", "pdfjs");
mkdirSync(target, { recursive: true });
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  const src = join(root, dir);
  if (existsSync(src)) cpSync(src, join(target, dir), { recursive: true });
}
console.log("pdfjs assets copied to public/pdfjs");
