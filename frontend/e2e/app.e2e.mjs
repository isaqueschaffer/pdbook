// End-to-end test of the app build: two "phones" (browser contexts) against one PDBook server.
// How to run: docs/APP_STATUS.md → "Teste de ponta a ponta".
//
//   APP_URL      app served with `vite --mode app` (default http://localhost:5174)
//   API_URL      PDBook server (default http://localhost:8000)
//   BROWSER      playwright channel, e.g. "msedge" or "chrome" (default: Playwright's Chromium)
import { join } from "node:path";
import { chromium } from "playwright";

const APP = process.env.APP_URL ?? "http://localhost:5174";
const SERVER = process.env.API_URL ?? "http://localhost:8000";
const API = `${SERVER}/api`;
const HERE = import.meta.dirname;
const BOOK = join(HERE, "..", "src", "device", "convert", "__fixtures__", "book-with-outline.pdf");
const TWO_COLUMNS = join(HERE, "..", "src", "device", "convert", "__fixtures__", "two-columns.pdf");
const SCANNED = join(HERE, "fixtures", "digitalizado.pdf");

const email = `e2e${Date.now()}@example.com`;
const password = "senha-segura-1";
const ok = (...a) => console.log("✓", ...a);
let failures = 0;
const fail = (m) => {
  failures++;
  console.log("✗ FALHOU:", m);
};

async function api(path, token) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, "X-PDBook-Client": "app" } });
  return res.status === 200 ? res.json() : { status: res.status };
}

async function login() {
  const r = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "PDBook", "X-PDBook-Client": "app" },
    body: JSON.stringify({ email, password }),
  });
  return (await r.json()).session_token;
}

const browser = await chromium.launch(process.env.BROWSER ? { channel: process.env.BROWSER } : {});
const pageErrors = [];

async function phone(name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`[${name}] ${e.message}`));
  // In the APK the app's own files are inside the package. Here they come from the dev server, so
  // while offline the test navigates inside the app (as a user does) instead of reloading.
  const nav = (path) => page.evaluate((p) => (history.pushState({}, "", p), dispatchEvent(new PopStateEvent("popstate"))), path);
  return { ctx, page, nav };
}

async function signUp(page) {
  await page.goto(`${APP}/cadastro`);
  await page.getByLabel("Servidor").fill(SERVER);
  await page.getByLabel("Nome").fill("Teste E2E");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await page.getByLabel("Confirmar senha").fill(password);
  await page.getByRole("button", { name: "Criar conta" }).click();
  await page.waitForURL(`${APP}/`, { timeout: 15000 });
}

try {
  // ---- Phone A: sign up on the chosen server, import, convert on the device ----
  const A = await phone("A");
  await signUp(A.page);
  ok("cadastro pelo app, com o servidor escolhido na tela");

  await A.page.goto(`${APP}/importar`);
  let t0 = Date.now();
  await A.page.locator('input[type="file"]').setInputFiles([BOOK, TWO_COLUMNS]);
  await A.page.getByText("Pronto").nth(1).waitFor({ timeout: 120000 });
  ok(`2 PDFs importados e convertidos no aparelho em ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  await A.page.waitForTimeout(2500); // sync queue
  const token = await login();
  let books = (await api("/books?page_size=60", token)).items;
  const book = books.find((b) => b.title === "Livro de Teste");
  if (books.length !== 2 || books.some((b) => b.storage_mode !== "device")) fail(`o servidor deveria ter 2 livros do aparelho (tem ${books.length})`);
  else ok("o servidor recebeu os 2 livros, só com os metadados:", books.map((b) => `${b.title} [${b.chapter_count} cap.]`).join(" · "));
  if ((await api(`/books/${book.id}/file`, token)).status !== 404) fail("o PDF não deveria estar no servidor");
  else ok("o PDF não está no servidor (/file → 404)");

  // ---- Reading, bookmark, PDF mode ----
  await A.page.goto(`${APP}/ler/${book.id}`);
  await A.page.locator(".book-text p").first().waitFor({ timeout: 20000 });
  ok("o modo Livro abre com o conteúdo convertido no aparelho");
  await A.page.getByRole("button", { name: "Marcar esta posição" }).click();
  await A.page.waitForTimeout(2500);
  let marks = await api(`/books/${book.id}/bookmarks`, token);
  if (marks.length !== 1) fail(`o marcador não chegou ao servidor (${marks.length})`);
  else ok("marcador sincronizado com o servidor");
  await A.page.goto(`${APP}/ler/${book.id}?modo=pdf`);
  await A.page.locator("canvas").first().waitFor({ timeout: 20000 });
  ok("o modo PDF abre o arquivo guardado no aparelho");

  // ---- Offline reading ----
  await A.page.goto(`${APP}/ler/${book.id}`); // loads the reader's code from the dev server
  await A.page.locator(".book-text p").first().waitFor({ timeout: 20000 });
  await A.nav("/biblioteca");
  await A.page.getByText(book.title).first().waitFor({ timeout: 15000 });
  await A.ctx.setOffline(true);
  await A.nav("/");
  await A.nav("/biblioteca");
  await A.page.getByText(book.title).first().waitFor({ timeout: 15000 });
  ok("sem internet: a biblioteca abre");
  await A.nav(`/ler/${book.id}`);
  await A.page.locator(".book-text p").first().waitFor({ timeout: 20000 });
  ok("sem internet: o modo Livro abre");
  await A.page.mouse.wheel(0, 3000);
  await A.page.waitForTimeout(2500);
  await A.nav("/biblioteca");
  const before = await api(`/books/${book.id}/progress`, token);
  await A.ctx.setOffline(false);
  await A.page.evaluate(() => window.dispatchEvent(new Event("online")));
  await A.page.waitForTimeout(4000);
  const after = await api(`/books/${book.id}/progress`, token);
  if (!after || (before && after.updated_at === before.updated_at)) fail("o progresso lido sem internet não sincronizou");
  else ok(`de volta à internet: o progresso foi enviado (${Math.round(after.percent)}%)`);

  // ---- Phone B: same account, brings the same PDF ----
  const B = await phone("B");
  await B.page.goto(`${APP}/entrar`);
  await B.page.getByLabel("Servidor").fill(SERVER);
  await B.page.getByLabel("E-mail").fill(email);
  await B.page.getByLabel("Senha").fill(password);
  await B.page.getByRole("button", { name: "Entrar" }).click();
  await B.page.waitForURL(`${APP}/`, { timeout: 15000 });
  await B.page.goto(`${APP}/biblioteca`);
  await B.page.getByText("Em outro aparelho").first().waitFor({ timeout: 15000 });
  ok("o aparelho B vê os livros como 'Em outro aparelho'");
  await B.page.goto(`${APP}/ler/${book.id}`);
  await B.page.getByRole("button", { name: "Escolher o PDF" }).waitFor();
  await B.page.locator('input[type="file"]').setInputFiles(BOOK);
  await B.page.locator(".book-text p").first().waitFor({ timeout: 60000 });
  ok("o aparelho B trouxe o mesmo PDF e abriu no modo Livro");
  await B.page.waitForTimeout(3500);
  books = (await api("/books?page_size=60", token)).items;
  if (books.length !== 2) fail(`o livro não deveria duplicar no servidor (tem ${books.length})`);
  else ok("o servidor continua com 2 livros: o aparelho B adotou o mesmo registro (SHA-256)");
  marks = await api(`/books/${book.id}/bookmarks`, token);
  const localMarks = await B.page.evaluate(async (id) => {
    const user = JSON.parse(localStorage.getItem("pdbook.session")).user.id;
    return new Promise((res) => {
      const req = indexedDB.open(`pdbook-${user}`);
      req.onsuccess = () => {
        const q = req.result.transaction("bookmarks").objectStore("bookmarks").index("book").getAll(id);
        q.onsuccess = () => res(q.result.length);
      };
    });
  }, book.id);
  if (localMarks !== marks.length) fail(`o aparelho B tem ${localMarks} marcadores; o servidor, ${marks.length}`);
  else ok(`o marcador criado no aparelho A aparece no aparelho B (${localMarks})`);

  await B.page.goto(`${APP}/biblioteca`);
  await B.page.getByRole("button", { name: `Ações para ${book.title}` }).click();
  await B.page.getByRole("menuitem", { name: "Remover deste aparelho" }).click();
  await B.page.getByText("Em outro aparelho").first().waitFor({ timeout: 10000 });
  ok("'Remover deste aparelho' liberou o espaço e manteve o livro na conta");

  // ---- OCR on the device, offline assets only ----
  const assets = new Set();
  B.page.on("request", (r) => /tesseract|traineddata|cdn\./.test(r.url()) && assets.add(r.url().replace(APP, "")));
  await B.page.goto(`${APP}/importar`);
  await B.page.getByText("Reconhecer texto com OCR").click();
  t0 = Date.now();
  await B.page.locator('input[type="file"]').setInputFiles(SCANNED);
  await B.page.getByRole("link", { name: "Abrir" }).waitFor({ timeout: 180000 });
  await B.page.getByRole("link", { name: "Abrir" }).click();
  await B.page.locator(".book-text").waitFor({ timeout: 20000 });
  const text = await B.page.locator(".book-text").innerText();
  if (!/digitalizado para teste de OCR/i.test(text)) fail(`o OCR não reconheceu o texto: ${JSON.stringify(text.slice(0, 80))}`);
  else ok(`OCR no aparelho reconheceu a página escaneada em ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if ([...assets].some((u) => /^https?:/.test(u) && !u.startsWith(APP))) fail(`o OCR buscou arquivos fora do app: ${[...assets].join(", ")}`);
  else ok("o OCR usou só os arquivos embutidos no app (funciona sem internet)");
} catch (e) {
  fail(e.message.split("\n")[0]);
} finally {
  if (pageErrors.length) {
    failures++;
    console.log("✗ erros de JavaScript na página:\n  " + [...new Set(pageErrors)].slice(0, 10).join("\n  "));
  }
  await browser.close();
  console.log(failures ? `\n${failures} falha(s).` : "\nTudo certo.");
  process.exitCode = failures ? 1 : 0;
}
