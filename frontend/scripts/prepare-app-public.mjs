// Builds the public directory of the app (vite --mode app): the website's public/ plus the
// on-device OCR engine (tesseract.js worker, WebAssembly core, Portuguese and English data).
// Kept out of the website build, where OCR runs on the server and these ~16 MB would be dead weight.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, "..");
const target = join(root, ".app-public");
const pkg = (name) => dirname(require.resolve(`${name}/package.json`));

rmSync(target, { recursive: true, force: true });
cpSync(join(root, "public"), target, { recursive: true });

const ocr = join(target, "tesseract");
mkdirSync(join(ocr, "core"), { recursive: true });
mkdirSync(join(ocr, "lang"), { recursive: true });
cpSync(join(pkg("tesseract.js"), "dist", "worker.min.js"), join(ocr, "worker.min.js"));
// LSTM-only engines (the app uses OEM.LSTM_ONLY); tesseract.js picks one by WebAssembly SIMD support.
const core = pkg("tesseract.js-core");
for (const variant of ["tesseract-core-lstm", "tesseract-core-simd-lstm", "tesseract-core-relaxedsimd-lstm"]) {
  cpSync(join(core, `${variant}.wasm.js`), join(ocr, "core", `${variant}.wasm.js`));
}
for (const lang of ["por", "eng"]) {
  const file = join(pkg(`@tesseract.js-data/${lang}`), "4.0.0_best_int", `${lang}.traineddata.gz`);
  if (!existsSync(file)) throw new Error(`missing OCR data: ${file}`);
  cpSync(file, join(ocr, "lang", `${lang}.traineddata.gz`));
}
console.log("app public dir ready at .app-public (with OCR assets)");
