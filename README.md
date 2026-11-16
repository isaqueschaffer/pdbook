# PDBook

Transforma PDFs em uma experiência de leitura de livro digital, com:

- fonte ajustável, temas claro, escuro e sépia;
- progresso sincronizado entre dispositivos;
- marcadores, destaques, anotações e busca;
- o **PDF original** sempre disponível, com a paginação, as imagens e as tabelas preservadas.

Feito para rodar numa VM **Oracle Cloud Always Free (Ampere A1, ARM64)**, com o banco de dados
no **Neon PostgreSQL**.

- Implantação: [docs/DEPLOY_OCI.md](docs/DEPLOY_OCI.md)
- Backup e restauração: [docs/BACKUP.md](docs/BACKUP.md)
- **App para celular** (Android, com Capacitor): [docs/APP.md](docs/APP.md). No app, o PDF, a conversão e
  o OCR ficam no aparelho e funcionam offline; o servidor guarda a conta e sincroniza o progresso, os
  marcadores e as preferências.
  Estado do projeto, testes e pendências: [docs/APP_STATUS.md](docs/APP_STATUS.md).

---

## Funcionalidades

| Área | O que faz |
|---|---|
| Conta | Cadastro, login, logout, "sair de todos os dispositivos", troca de senha (encerra as outras sessões), troca de e-mail com confirmação por senha, exclusão da conta com todos os arquivos |
| Biblioteca | Grade paginada, busca por título, autor ou arquivo, filtros por estado, ordenação, capas tipográficas, edição de título e autor, reprocessamento, OCR sob demanda, exclusão |
| Importação | Arrastar e soltar, vários arquivos em fila, barra de progresso do envio, validação no navegador e no servidor, detecção de duplicados, estado da conversão em tempo real |
| Modo PDF | PDF.js com renderização sob demanda (libera a memória das páginas distantes), zoom, ajuste à largura e retomada da página |
| Modo Livro | Texto refluído (não é zoom). Fonte serifada ou sem serifa, tamanho, entrelinha, espaço entre parágrafos, margens, largura da coluna, texto justificado, temas, restauração do padrão. Tudo é aplicado na hora, sem reconverter |
| Navegação | Sumário automático (outline do PDF ou títulos detectados, com subseções), capítulos anterior e próximo, carregamento progressivo de capítulos com pré-busca do próximo |
| Anotações | Marcadores de posição, destaques em 4 cores (inclusive entre parágrafos), notas, painel com tudo e salto direto ao trecho |
| Busca | No texto extraído, sem diferenciar maiúsculas nem acentos, com trecho em destaque |
| Progresso | Posição estável (capítulo + bloco + deslocamento + página do PDF), salva com *debounce* e ao sair da página. Retomada após recarregar ou em nova sessão. Sobrevive a reconversões, porque é mapeada pela página |
| Preferências | Salvas no Neon e recuperadas em qualquer sessão |
| Painel | Continuar lendo, estatísticas, uso de armazenamento com alertas |

## Arquitetura

```
             Internet (80/443)
                    │
             ┌──────▼──────┐   arquivos estáticos do React (Vite)
             │    Caddy    │   HTTPS automático (Let's Encrypt), CSP e cabeçalhos de segurança
             └──────┬──────┘
         /api/*     │  rede interna do Docker (sem portas publicadas)
             ┌──────▼──────┐        ┌──────────────┐
             │   FastAPI   │◄──────►│    Redis     │  rede "internal": sem rota para a internet
             │  (uvicorn)  │  RQ    │  (fila RQ)   │
             └──┬───────┬──┘        └──────▲───────┘
                │       │                  │
      Neon ◄────┘       │           ┌──────┴───────┐
   (PostgreSQL, TLS)    │           │  Worker RQ   │  PyMuPDF + Tesseract OCR
                ▲       │           │ (1 conversão │  limites de tempo, memória
                │       ▼           │   pesada)    │  e número de tentativas
                │   /data (Block    └──────┬───────┘
                └── Volume): originals/ converted/ tmp/
```

**Fluxo da conversão:**

1. **Upload em streaming.** Valida a assinatura `%PDF-`, o tamanho, o número de páginas, criptografia e espaço em disco.
2. **Gravação do original.** O arquivo é salvo como `originals/<uuid>.pdf` (nunca com o nome enviado) e a linha é criada em `books`.
3. **Enfileiramento.** Cria a tarefa em `conversion_jobs` e a coloca no Redis.
4. **Processamento no worker,** página a página com PyMuPDF:
   - remove cabeçalhos, rodapés e números de página;
   - reconstrói a ordem de leitura em duas colunas;
   - detecta títulos pelo tamanho e peso da fonte;
   - refaz os parágrafos, desfaz a hifenização e junta parágrafos quebrados entre páginas;
   - extrai imagens relevantes, descartando logos repetidos;
   - divide em capítulos: outline do PDF, senão títulos detectados, senão faixas de páginas.
5. **Gravação versionada.** Grava `converted/<uuid>/v<N>/` (manifest + `chapters/NNNN.json` + `images/`) e atualiza `book_chapters` e o estado do livro.
6. **Leitura.** O leitor carrega capítulo a capítulo.

**PDFs digitalizados:**

- Se a maioria das páginas não tem texto extraível, o livro fica como **"Digitalizado"**. O modo PDF continua funcionando, e o usuário pode pedir **OCR** (na importação ou depois).
- O OCR roda numa fila separada, consumida por **um único processo**. Ele processa uma página por vez com `OMP_THREAD_LIMIT=1` e tem timeout por página.

## Estrutura

```
backend/
  app/api/          rotas: auth, account (conta + preferências), books, reader, system
  app/core/         configuração validada, segurança (Argon2id, sessões), rate limit, logs sem segredos
  app/db/           SQLAlchemy (engine com pool conservador para o Neon)
  app/models/       users, user_sessions, books, conversion_jobs, book_chapters, reading_progress, bookmarks, reader_preferences
  app/schemas/      Pydantic
  app/services/     armazenamento (anti path traversal, cotas), fila RQ, exclusão, leitura do conteúdo
  app/converters/   pdf.py (PyMuPDF → livro estruturado), ocr.py (Tesseract)
  app/tasks.py      tarefa do worker (tentativas, limites, versionamento)
  app/cli.py        check-config, storage, cleanup-orphans, verify-files, reprocess-missing
  alembic/          migrations
  worker.py         processos do worker RQ (+ --check para health check)
  tests/            pytest (PDFs de teste gerados em tempo de execução)
frontend/
  src/pages/        login/cadastro, painel, biblioteca, importação, leitor, conta, leitura
  src/features/     auth, library, reader (BookView, PdfViewer, painéis, posições, preferências)
  src/components/   UI reutilizável (botões, campos, diálogos, menus, toasts, layout)
  src/services/     cliente da API, tipos, formatação
caddy/              Dockerfile (build do frontend + Caddy) e Caddyfile
scripts/            oci-setup, preflight, deploy, backup, restore
docs/               DEPLOY_OCI.md, BACKUP.md
compose.yaml        caddy, backend, worker, redis
```

## Desenvolvimento local

Requisitos: Python 3.12, Node 22+, Docker (só para o Redis).

```bash
# Redis só para desenvolvimento
docker run -d --name pdbook-redis -p 127.0.0.1:6379:6379 redis:7.4-alpine

# Backend
cd backend
python -m venv .venv && . .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
cat > .env <<'EOF'
ENVIRONMENT=development
DATABASE_URL=sqlite:///./dev.db        # ou a URL de um branch de desenvolvimento do Neon
SESSION_SECRET=dev-only-0123456789abcdef0123456789abcdef
REDIS_URL=redis://localhost:6379/0
UPLOAD_DIR=./data/originals
CONVERTED_DIR=./data/converted
TMP_DIR=./data/tmp
FRONTEND_URL=http://localhost:5173
EOF
alembic upgrade head
uvicorn app.main:app --reload --port 8000     # terminal 1
python worker.py                              # terminal 2 (no Windows o RQ precisa de WSL; use Docker)

# Frontend
cd frontend
npm install
npm run dev                                   # http://localhost:5173 (proxy /api -> :8000)
```

SQLite só é aceito fora de produção. Em produção, a configuração exige o Neon.

O worker RQ depende de `fork()`, então no Windows rode-o pelo Docker:
`docker compose up worker redis`.

## Testes

```bash
cd backend && pytest                 # 41 testes: auth, permissões, upload, PDF inválido, extração,
                                     # fila RQ real (fakeredis), capítulos, progresso, preferências,
                                     # marcadores/notas, busca, exclusão, falhas e tentativas, migrations
cd frontend && npm run typecheck && npm test && npm run build
```

- O teste de OCR real é pulado se o `tesseract` não estiver instalado. Ele está presente na imagem Docker.
- Para rodar a suíte contra PostgreSQL: `TEST_DATABASE_URL=postgresql://... pytest`.

## Configuração e ajuste de limites

Todas as variáveis estão documentadas em [.env.example](.env.example). A configuração é validada na
inicialização. Se faltar algo, o processo encerra com uma mensagem clara, como
`DATABASE_URL: obrigatória e não definida`. Para conferir:

```bash
docker compose run --rm backend python -m app.cli check-config
```

| Variável | Padrão | Quando ajustar |
|---|---|---|
| `MAX_UPLOAD_MB` / `MAX_REQUEST_BODY` | 50 / 52MB | Mantenha o do proxy um pouco acima do da aplicação |
| `MAX_PDF_PAGES` | 250 | Aumente com cautela. O tempo e a memória da conversão crescem com o número de páginas |
| `WORKER_CONCURRENCY` | 1 | 2 em VMs com 4 OCPUs. O OCR continua serializado em um único processo |
| `JOB_TIMEOUT_SECONDS` / `OCR_JOB_TIMEOUT_SECONDS` | 900 / 3600 | OCR leva de 2 a 6 s por página no A1 |
| `WORKER_MEMORY_LIMIT_MB` | 1536 | Limite de memória por conversão. PDFs com muitas imagens grandes podem precisar de mais |
| `WORKER_MEM_LIMIT` / `WORKER_CPUS` | 3g / 1.5 | Teto do container. Deixe ao menos 1 OCPU livre para a API |
| `JOB_MAX_RETRIES` | 2 | Apenas falhas temporárias são repetidas. PDF inválido, timeout e falta de memória não |
| `DB_POOL_SIZE` / `DB_MAX_OVERFLOW` / `API_WORKERS` | 3 / 2 / 2 | Total de conexões ≈ API_WORKERS×(pool+overflow) + worker. Respeite o limite do plano Neon |
| `STORAGE_LIMIT_MB` / `STORAGE_WARN_PERCENT` / `MIN_FREE_DISK_MB` | 40000 / 85 / 1024 | Abaixo do tamanho do Block Volume |
| `USER_QUOTA_MB` | 0 | Defina uma cota por usuário se a instância tiver várias pessoas |
| `OCR_DPI` | 200 | 300 melhora textos pequenos, mas é cerca de 2× mais lento |

## Segurança

- **Senhas** em Argon2id. **Sessões** opacas (256 bits) em cookie `HttpOnly`, `SameSite=Lax` e `Secure`
  em produção, com `path=/api`. O banco guarda só o HMAC do token. A expiração é deslizante, e a sessão
  pode ser revogada no logout, na troca de senha ou em "sair de todos".
- **CSRF:** toda requisição que altera estado exige o cabeçalho `X-Requested-With: PDBook`, que outro
  site não consegue enviar sem passar pelo CORS.
- **Rate limiting** em Redis: login (por IP e por conta), cadastro, upload e reautenticação.
- **Controle de acesso:** todo acesso a livro, arquivo, imagem, capítulo, progresso ou marcador verifica
  o dono. Livros de outra pessoa retornam 404, então os IDs não são enumeráveis.
- **Arquivos:**
  - nomes internos aleatórios (UUID);
  - caminhos validados por lista de caracteres permitidos e confinados ao diretório base, contra path traversal;
  - nenhum caminho físico na API;
  - `/data` nunca é servido como pasta estática: os PDFs passam pela API autenticada.
- **Validação do upload:** assinatura, tamanho em streaming (recusa antes de ler o corpo inteiro),
  abertura com PyMuPDF, criptografia e número de páginas.
- **Conteúdo** renderizado como texto pelo React. Não há `dangerouslySetInnerHTML`, e há uma CSP restritiva.
- **SQL** só via SQLAlchemy, com parâmetros vinculados.
- **Rede:**
  - apenas o Caddy publica portas;
  - o Redis exige senha e fica numa rede sem rota externa;
  - o Neon só é acessado pelo backend, com TLS.
- **Logs** sem senhas, tokens, cookies nem query strings. Há um filtro de redação no backend e no
  Caddy. Erros internos chegam ao usuário só com um `request_id`.
- **Política de exclusão de livros:** remoção definitiva.
  1. Cancela as tarefas pendentes.
  2. Apaga em cascata capítulos, tarefas, progresso e marcadores.
  3. Remove o PDF e todas as versões convertidas depois do commit.
  4. Sobras de falhas são varridas por `python -m app.cli cleanup-orphans`.
  
  A exclusão da conta faz o mesmo para todos os livros da pessoa.

## Limitações conhecidas

- **Reconstrução heurística:** layouts complexos podem sair imperfeitos no modo Livro. Isso inclui
  revistas, várias colunas irregulares, notas de rodapé no meio do texto, tabelas, fórmulas e texto
  em curvas. Cada livro mostra os avisos da conversão, e o modo PDF continua disponível.
- Tabelas e fórmulas viram texto corrido no modo Livro.
- O modo PDF não tem camada de texto selecionável. Destaques e notas existem só no modo Livro.
- Destaques ficam ligados à versão do conteúdo. Depois de reprocessar um livro, as anotações antigas
  aparecem no painel e abrem pela página, mas não são remarcadas no novo texto.
- O OCR depende da qualidade do scan. Ele usa os idiomas `por+eng` por padrão; outros pacotes
  `tesseract-ocr-*` podem ser adicionados ao Dockerfile.
- Sem recuperação de senha por e-mail, porque o projeto não depende de serviço de e-mail externo.
