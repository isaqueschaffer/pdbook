# PDBook no celular (app com Capacitor)

O app usa o mesmo código React do site, empacotado como aplicativo nativo pelo
[Capacitor](https://capacitorjs.com). A diferença está em **onde cada coisa acontece**:

| | Site | App |
|---|---|---|
| PDF original | enviado ao servidor (`/data/originals`) | fica no celular (IndexedDB) |
| Conversão para o modo Livro | worker no servidor (PyMuPDF) | no celular (pdf.js) |
| OCR | servidor (Tesseract) | no celular (tesseract.js, offline) |
| Conta, login | servidor | servidor |
| Progresso, marcadores, notas, preferências | servidor | no celular **e** sincronizados com o servidor |
| Funciona sem internet | não | sim (depois do primeiro login) |

O servidor continua sendo o mesmo (FastAPI + Neon). Para os livros importados pelo app, ele guarda só
os metadados: título, autor, tamanho, número de páginas, hash SHA-256 do arquivo e o resultado da
conversão. Os livros enviados pelo site também aparecem no app e abrem quando há conexão; os capítulos
já lidos ficam em cache para leitura offline.

## Como a sincronização funciona

- **Tudo é gravado primeiro no celular.** Cada mudança (progresso, marcador, título, exclusão) entra numa
  fila local (`outbox`) que é enviada em ordem quando há conexão: ao abrir o app, ao voltar a conexão,
  ao trazer o app para a frente e a cada 3 minutos.
- **Reenviar é seguro.** O app gera os ids dos livros e dos marcadores, e o servidor aceita esses ids.
  Se uma requisição se perde no meio do caminho, o reenvio não duplica nada.
- **O progresso mais recente vence.** O app envia o horário real da leitura (`updated_at`). Uma posição
  antiga, lida offline, nunca sobrescreve uma mais nova feita em outro aparelho.
- **O mesmo PDF em dois celulares vira o mesmo livro.** O servidor identifica o arquivo pelo SHA-256
  (`POST /api/books/device`). O segundo celular adota o livro existente, com o progresso e as anotações.
- **Os marcadores batem entre aparelhos.** A conversão no celular é determinística e é uma tradução das
  mesmas heurísticas do servidor (`frontend/src/device/convert/heuristics.ts` ↔
  `backend/app/converters/pdf.py`). O mesmo arquivo gera os mesmos blocos em qualquer aparelho.
  Quando as versões não batem (por exemplo, um aparelho usou OCR e o outro não), o leitor cai para a
  navegação por página, como já acontecia nas reconversões do servidor.
- **Livro importado em outro celular:** aparece na biblioteca como "Em outro aparelho". Basta escolher
  o mesmo PDF para lê-lo aqui. No site, esses livros aparecem como "No app".

### Novas rotas da API

| Rota | Para quê |
|---|---|
| `POST /api/auth/login`, `/register` com `X-PDBook-Client: app` | devolvem `session_token` (o app usa `Authorization: Bearer`, não cookie) |
| `POST /api/books/device` | registra um livro do celular; idempotente pelo SHA-256 |
| `PUT /api/books/{id}/device-content` | informa o resultado de uma (re)conversão feita no celular |
| `PUT /api/books/{id}/progress` com `updated_at` | ignora posições mais antigas que a salva |
| `POST /api/books/{id}/bookmarks` com `id` | idempotente (reenvio da fila) |

A migração `0002_device_books` adiciona a coluna `books.storage_mode` (`server` | `device`). Livros
`device` não contam na cota de armazenamento do servidor, e `/file` e `/reprocess` respondem que o
PDF está no aparelho.

## Configurar o servidor

1. Faça o deploy desta versão. O `scripts/deploy.sh` já roda `alembic upgrade head`.
2. No `.env` do servidor, libere as origens do app:

   ```
   CORS_ORIGINS=https://localhost,capacitor://localhost
   ```

   `https://localhost` é a origem do app no Android; `capacitor://localhost`, no iOS. Para testar o
   app no navegador (`npm run dev:app`), acrescente `http://localhost:5174`.

## Gerar o app Android

Pré-requisitos: [Android Studio](https://developer.android.com/studio) (traz o SDK e o JDK) e Node 22
ou mais recente.

```bash
cd frontend
cp .env.app.example .env.app      # ajuste VITE_API_URL para o endereço do seu servidor
npm install
npm run android:sync              # build do app (dist-app/) + cópia para android/
npm run android:open              # abre o projeto no Android Studio
```

No Android Studio, use **Run** para instalar num celular conectado ou num emulador. Para gerar o
arquivo de instalação: **Build → Generate Signed App Bundle / APK**. Use APK para distribuir
diretamente e AAB para a Play Store. Guarde a chave de assinatura: sem ela não é possível publicar
atualizações.

Depois de mudar o código, rode `npm run android:sync` de novo antes de compilar.

**Endereço do servidor.** `VITE_API_URL` é só o valor que já vem preenchido. Na tela de login e de
cadastro, o app tem o campo **Servidor**, então o mesmo APK funciona com qualquer instalação do
PDBook. Trocar o servidor encerra a sessão anterior.

### Compilar pela linha de comando (sem abrir o Android Studio)

Requer o JDK 21 e o SDK com `platforms;android-36` e `build-tools;36.0.0`.

**Windows com acento no caminho** (por exemplo `C:\Users\Usuário\...`): as ferramentas do Android
falham com caminhos fora do ASCII. Use o SDK e o cache do Gradle em pastas sem acento e compile por
um atalho de pasta (junction):

```powershell
New-Item -ItemType Junction -Path C:\pdbook -Target "<pasta do projeto>"
Set-Content C:\pdbook\frontend\android\local.properties 'sdk.dir=C\:\\Android\\Sdk' -Encoding ascii
$env:JAVA_HOME = 'C:\Program Files\Microsoft\jdk-21.0.13.21-hotspot'
$env:GRADLE_USER_HOME = 'C:\gradle'
C:\pdbook\frontend\android\gradlew.bat -p C:\pdbook\frontend\android assembleDebug
# APK em C:\pdbook\frontend\android\app\build\outputs\apk\debug\app-debug.apk
```

O APK de debug serve para instalar e testar (`adb install app-debug.apk` ou copiando para o celular
com "instalar apps desconhecidos" liberado). Para distribuir, gere a versão assinada (`assembleRelease`
com uma chave de assinatura, ou pelo Android Studio).

O identificador do app é `br.com.pdbook.app` (`frontend/capacitor.config.ts`). Troque-o antes da
primeira publicação, se quiser outro: ele não pode mudar depois.

### iOS

O Capacitor também gera o projeto iOS, mas compilar exige um Mac com Xcode:

```bash
npm install @capacitor/ios
npx cap add ios
npm run build:app && npx cap sync ios && npx cap open ios
```

O app ainda não foi testado no iOS.

## Desenvolvimento

- `npm run dev:app` roda o app no navegador (porta 5174) falando com o servidor de `VITE_API_URL`.
  Os dados ficam no IndexedDB do navegador.
- `npm run build` continua gerando o site, igual a antes. O código do app só é carregado quando
  `VITE_APP_MODE=app`, e o motor de OCR (cerca de 16 MB) só entra no build do app
  (`scripts/prepare-app-public.mjs`).
- O código do app fica em `frontend/src/device/`:
  - `convert/`: conversor de PDF (heurísticas, extração com pdf.js, OCR);
  - `db.ts`: banco local (um por conta);
  - `importer.ts`: importação e fila de conversão;
  - `sync.ts`: fila de envio e sincronização;
  - `library.ts`: implementação local da API usada pelas telas.

### Comparar os conversores com seus próprios PDFs

```bash
backend/.venv/Scripts/python frontend/scripts/compare-converters.py server <pasta-com-pdfs>
cd frontend && PARITY_DIR=<pasta-com-pdfs> npx vitest run src/device/convert/compare.node.test.ts
cd .. && backend/.venv/Scripts/python -X utf8 frontend/scripts/compare-converters.py report <pasta-com-pdfs>
```

O relatório mostra, por PDF, os capítulos, os blocos e a semelhança do texto de cada lado, além das
primeiras diferenças encontradas.

### Teste de paridade do conversor

`src/device/convert/parity.node.test.ts` converte PDFs de teste com o conversor do celular e exige o
mesmo resultado do conversor do servidor. Ao mudar as heurísticas de qualquer um dos dois lados,
regenere as referências e rode os testes:

```bash
backend/.venv/Scripts/python frontend/scripts/make-parity-fixtures.py   # Windows
backend/.venv/bin/python frontend/scripts/make-parity-fixtures.py       # Linux/macOS
cd frontend && npm test
```

Uma mudança que altere a estrutura convertida deve incrementar `CONVERTER_VERSION`
(`src/device/convert/index.ts`), para que os aparelhos saibam que as posições antigas não valem mais.

## Limitações conhecidas

- **Desempenho no celular:** PDFs grandes levam mais tempo que no servidor, e o OCR leva alguns
  segundos por página. A conversão pausa se o app for para segundo plano e continua ao voltar. Se o
  app for fechado, ela recomeça na próxima abertura.
- **PDFs reais diferem um pouco do servidor.** O pdf.js e o PyMuPDF leem as linhas de forma ligeiramente
  diferente. Medido com `scripts/compare-converters.py` (veja abaixo): num artigo do arXiv, no livro
  Pro Git (501 páginas) e num manual escaneado de 412 páginas, os capítulos batem em 100% nos livros com
  sumário, e o texto é de 95% a 99% igual. Isso só afeta marcadores entre um livro convertido no servidor
  e o mesmo arquivo convertido no app; entre celulares o resultado é idêntico (mesmo código). Quando não
  batem, o leitor abre pela página.
- **Detecção de logos repetidos:** o servidor compara os objetos internos do PDF; o celular compara uma
  "impressão digital" da imagem (tamanho + miniatura 8×8).
- **Espaço:** os PDFs ocupam o armazenamento do celular. Use "Remover deste aparelho" para liberar
  espaço sem perder o livro, o progresso e as anotações.
- **Sem internet não dá para** entrar na conta pela primeira vez, mudar a senha, excluir a conta nem
  abrir pela primeira vez um livro enviado pelo site.
