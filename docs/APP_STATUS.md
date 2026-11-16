# App PDBook — estado do projeto

Relatório do trabalho na branch `pdbook-app`: o que foi feito, como foi testado, os resultados e o
que falta para colocar o app no ar. A arquitetura e o guia de build estão em [APP.md](APP.md).

**Data:** 16/11/2026 · **Branch:** `pdbook-app` · **APK de teste:** GitHub → Releases →
[`app-v0.1.0`](https://github.com/isaqueschaffer/pdbook/releases/tag/app-v0.1.0) (pre-release)

---

## 1. Resumo

O PDBook ganhou um app Android, feito com Capacitor a partir do mesmo código React do site.

- **No celular:** o PDF, a conversão para o modo Livro e o OCR. Funciona sem internet.
- **No servidor atual (FastAPI + Neon):** a conta e a sincronização de progresso, marcadores, notas e
  preferências entre aparelhos e com o site. O servidor nunca recebe os PDFs importados pelo app.
- **O site continua funcionando como antes.** Livros enviados pelo site também abrem no app.

| Item | Estado |
|---|---|
| App Android (debug) | ✅ compilado e publicado como pre-release |
| Backend com suporte ao app | ✅ pronto na branch, **falta o deploy** |
| Testes automatizados | ✅ 51 do backend, 15 unitários do app e 17 passos de ponta a ponta, todos passando |
| Teste num celular físico | ⏳ pendente |
| Versão assinada para a Play Store | ⏳ pendente (precisa da sua chave) |
| iOS | ⏳ pendente (precisa de um Mac) |

## 2. O que foi entregue

| Commit | Conteúdo |
|---|---|
| `510adb1` | App Android: conversor em TypeScript, OCR offline, banco local, fila de sincronização, novas rotas da API, migração `0002`, documentação |
| `1425a71` | Correções dos conversores (servidor **e** app) encontradas com PDFs reais |
| `d60a5d3` | Campo "Servidor" no login do app e correções encontradas no teste de ponta a ponta |
| (este) | Teste de ponta a ponta no projeto (`npm run test:e2e`) e este relatório |

### Mudanças no servidor

O servidor precisa da migração e de uma variável nova, e é compatível com o site atual.

- **Login do app por token:** com o cabeçalho `X-PDBook-Client: app`, `/auth/login` e `/auth/register`
  devolvem `session_token`, e o app autentica com `Authorization: Bearer`. O site continua com cookie.
- **Livros do aparelho** (migração `0002_device_books`, coluna `books.storage_mode`):
  - `POST /api/books/device` registra um livro só com os metadados; o mesmo arquivo (SHA-256) devolve
    o livro existente;
  - `PUT /api/books/{id}/device-content` informa o resultado de uma conversão feita no celular;
  - esses livros não contam na cota do servidor, e `/file` e `/reprocess` respondem que o PDF está no
    aparelho.
- **Progresso** aceita `updated_at`: uma posição antiga, lida offline, não sobrescreve uma mais nova.
- **Marcadores** aceitam o `id` gerado pelo app, então o reenvio não duplica.
- **CORS** libera `Authorization`, `X-PDBook-Client` e `Range` para as origens do app.
- **Conversor do servidor**, duas melhorias que valem para livros enviados ou reprocessados daqui em
  diante:
  - as linhas são agrupadas em blocos por geometria; antes, PDFs como o Pro Git viravam um parágrafo
    por linha;
  - os títulos com numeração ("2.1 Atenção") passam a bater com o sumário.

## 3. Testes e resultados

### 3.1 Backend — 51 testes ✅

`backend/tests/`, incluindo 8 novos em `test_device_books.py`: token, registro idempotente, proteção
contra uso do id de outra conta, livros do aparelho sem cota, progresso offline, marcador idempotente
e CORS. A checagem de que a migração bate com o modelo também passa.

### 3.2 App, testes unitários — 15 testes ✅

- **Paridade com o servidor** (`parity.node.test.ts`): PDFs de teste convertidos no app geram
  exatamente os mesmos capítulos, blocos e textos do conversor do servidor.
- **Sincronização** (`sync.test.ts`): fila offline, adoção do livro de outro aparelho, operações
  rejeitadas, erro do servidor e livros excluídos em outro lugar.

### 3.3 Comparação com PDFs reais

Mesmos arquivos convertidos pelo servidor e pelo app (`scripts/compare-converters.py`):

| PDF | Páginas | Capítulos iguais | Texto igual | Blocos com texto idêntico | Tempo servidor · app* |
|---|---|---|---|---|---|
| Artigo "Attention Is All You Need" (arXiv, 2 colunas) | 15 | 8 de 8 | 96,4% | 50% | 0,5 s · 2 s |
| Livro Pro Git | 501 | 22 de 22 | 98,8% | 91% | 4 s · 18 s |
| Manual Turbo Pascal 3.0 (escaneado, com camada de texto) | 412 | 185 de 206 | 95,2% | 69% | 6 s · 20 s |

\* App medido num PC (Node). No celular, conte com algumas vezes mais.

**Como ler a tabela:** entre dois celulares o resultado é sempre idêntico, porque o código é o mesmo e
determinístico. A diferença só importa para um marcador feito no site e aberto no app num livro que o
app converteu de novo; nesse caso o leitor abre pela página.

### 3.4 Teste de ponta a ponta — 17 passos ✅

`frontend/e2e/app.e2e.mjs`: dois "celulares" (contextos de navegador) contra um servidor PDBook.

1. Cadastro pelo app, com o servidor escolhido na tela
2. Importação e conversão de 2 PDFs no aparelho
3. O servidor recebe só os metadados
4. O PDF não está no servidor
5. O modo Livro abre
6. O marcador chega ao servidor
7. O modo PDF abre o arquivo local
8. Sem internet, a biblioteca abre
9. Sem internet, o modo Livro abre
10. O progresso lido sem internet é enviado quando a conexão volta
11. O segundo aparelho vê os livros como "Em outro aparelho"
12. O segundo aparelho traz o mesmo PDF e abre no modo Livro
13. O livro não duplica no servidor
14. O marcador do aparelho A aparece no B
15. "Remover deste aparelho" funciona
16. O OCR reconhece uma página escaneada
17. O OCR não busca nada fora do app

### 3.5 Problemas encontrados pelos testes, todos corrigidos

| Problema | Onde | Achado por |
|---|---|---|
| A fila enviava marcadores com o id antigo depois de adotar o livro de outro aparelho | app | teste de sincronização |
| Gravações simultâneas podiam deixar um livro preso em "processando" | app | revisão |
| Capítulos começavam um parágrafo depois do título (numeração vs. sumário) | app **e** servidor | PDF real (arXiv) |
| Um parágrafo por linha em alguns PDFs | servidor | PDF real (Pro Git) |
| Notas de rodapé e expoentes soltos; ícones de fonte no texto | app / ambos | PDF real |
| Marcadores de outro aparelho só apareciam ao reabrir o livro | app | ponta a ponta |
| No APK, o OCR não acharia os dicionários (o Android renomeia arquivos `.gz`) | app | inspeção do APK |

## 4. Como reproduzir os testes

```bash
# Backend
cd backend && python -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt
.venv/Scripts/python -m pytest

# App: testes unitários e typecheck
cd frontend && npm install && npm test && npm run typecheck
```

### Teste de ponta a ponta

Precisa de um servidor PDBook e do app servido em modo `app`. Para rodar tudo localmente, sem Redis
nem Neon (o limite de requisições falha aberto e o app não usa a fila):

```bash
# terminal 1: backend local com SQLite
cd backend
export ENVIRONMENT=development DATABASE_URL=sqlite:///e2e.db REDIS_URL=redis://127.0.0.1:6399/0
export SESSION_SECRET=$(python -c "print('x'*48)") CORS_ORIGINS=http://localhost:5174 MIN_FREE_DISK_MB=0
export UPLOAD_DIR=./e2e-data/originals CONVERTED_DIR=./e2e-data/converted TMP_DIR=./e2e-data/tmp
.venv/Scripts/python -m alembic upgrade head
.venv/Scripts/python -m uvicorn app.main:app --port 8000

# terminal 2: o app
cd frontend && npm run dev:app

# terminal 3: o teste (BROWSER=msedge usa o Edge do Windows; sem ele, rode antes `npx playwright install chromium`)
cd frontend && BROWSER=msedge npm run test:e2e
```

### Comparar os conversores com seus PDFs

Veja "Comparar os conversores com seus próprios PDFs" em [APP.md](APP.md).

## 5. Pendências: o que falta para lançar

### 5.1 Deploy do backend (obrigatório antes de usar o app)

Na VM:

```bash
cd <pasta do pdbook>
git fetch && git checkout pdbook-app        # ou faça o merge em main primeiro
nano .env                                   # acrescente a linha abaixo
#   CORS_ORIGINS=https://localhost,capacitor://localhost
./scripts/deploy.sh                         # backup, build, migração 0002, reinício, health check
```

Para voltar atrás: `git checkout main && SKIP_PULL=1 ./scripts/deploy.sh`. A coluna nova tem valor
padrão, então o código antigo continua funcionando com o banco migrado.

### 5.2 Testar num celular

1. Baixe o `app-debug.apk` da [pre-release](https://github.com/isaqueschaffer/pdbook/releases/tag/app-v0.1.0).
2. No Android, permita "instalar apps desconhecidos" para o app que abrir o arquivo e instale.
3. No login, em **Servidor**, digite o seu domínio (por exemplo `leitura.seudominio.com`).
4. Roteiro sugerido:
   - importe um PDF grande e meça o tempo de conversão;
   - importe um PDF escaneado com OCR;
   - leia em modo avião;
   - entre com a mesma conta em outro aparelho ou no site e confira o progresso.

### 5.3 Versão assinada (Play Store ou distribuição)

```bash
keytool -genkey -v -keystore pdbook-release.jks -alias pdbook -keyalg RSA -keysize 2048 -validity 10000
```

Guarde o `.jks` e as senhas fora do repositório: sem eles não dá para publicar atualizações. Gere o
AAB ou APK assinado pelo Android Studio (**Build → Generate Signed App Bundle / APK**). Antes da
primeira publicação, confirme o identificador `br.com.pdbook.app` em `frontend/capacitor.config.ts`,
porque ele não pode mudar depois.

### 5.4 iOS

Precisa de um Mac com Xcode (passos em [APP.md](APP.md)). Ainda não foi testado.

### 5.5 Melhorias que valem considerar depois

- Abrir PDFs pelo menu "Compartilhar" / "Abrir com" do Android.
- Um botão "Baixar para ler offline" para os livros enviados pelo site.
- Medir e otimizar a conversão em celulares mais simples.

## 6. Ambiente desta máquina (para compilar de novo)

| O quê | Onde |
|---|---|
| JDK 21 | `C:\Program Files\Microsoft\jdk-21.0.13.21-hotspot` (winget) |
| Android Studio | instalado pelo winget |
| Android SDK (platform 36, build-tools 36) | `C:\Android\Sdk`, sem acento de propósito |
| Cache do Gradle | `C:\gradle` |
| Atalho do projeto sem acento | `C:\pdbook` → pasta do projeto (junction) |

Comandos para gerar o APK nesta máquina:

```powershell
cd frontend; npm run android:sync
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-21.0.13.21-hotspot'; $env:GRADLE_USER_HOME='C:\gradle'
C:\pdbook\frontend\android\gradlew.bat -p C:\pdbook\frontend\android assembleDebug
```
