import { GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

/** Assets copied to public/pdfjs by scripts/copy-pdfjs-assets.mjs: served from our own origin (or
 * from inside the app bundle), never from a CDN. */
export const PDFJS_ASSETS = {
  cMapUrl: "/pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/pdfjs/standard_fonts/",
  wasmUrl: "/pdfjs/wasm/",
  iccUrl: "/pdfjs/iccs/",
} as const;
