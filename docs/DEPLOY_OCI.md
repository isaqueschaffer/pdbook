# Implantação na Oracle Cloud (Always Free) — passo a passo

Este guia leva o PDBook a uma VM **Ampere A1 (ARM64)** do plano **Always Free** da OCI, com o
banco no **Neon** e HTTPS automático pelo Caddy. Nada aqui exige recursos pagos.

> **Regras de ouro**
> - Não faça upgrade da conta para "Pay As You Go" para conseguir capacidade. Este guia não depende disso.
> - Antes de criar um recurso, confira se o console mostra o selo **"Always Free-eligible"**.
> - Os limites gratuitos mudam com o tempo e variam por região. Confira em
>   *Governance & Administration → Limits, Quotas and Usage* e na página oficial do Always Free.

---

## 1. Criar (ou verificar) a instância Ampere A1

**Verificar se já existe:** abra *Menu → Compute → Instances* (na região *home* da conta).
Se já houver uma VM `VM.Standard.A1.Flex` em execução, anote o IP público e siga para o passo 2.

**Criar uma nova:**

1. *Compute → Instances → Create instance*.
2. **Name:** `pdbook`.
3. **Placement:** use qualquer Availability Domain. Se aparecer *Out of capacity*, veja a seção
   "Sem capacidade" mais abaixo.
4. **Image:** *Change image* → **Canonical Ubuntu 24.04** (ou 22.04). Escolha a variante **aarch64**,
   que é a que aparece quando o shape é ARM. Oracle Linux 9 também é suportado pelos scripts.
5. **Shape:** *Change shape* → *Ampere* → **VM.Standard.A1.Flex**. Configure **2 OCPUs e 12 GB de
   memória**, os valores iniciais deste projeto, dentro da franquia. Confirme o selo *Always Free-eligible*.
6. **Networking:** crie (ou reutilize) uma VCN com **sub-rede pública** e marque
   *Assign a public IPv4 address*.
7. **SSH keys:** *Generate a key pair for me* (baixe as duas chaves) ou cole sua chave pública
   (`~/.ssh/id_ed25519.pub`).
8. **Boot volume:** o padrão (~47 GB) basta. Os documentos ficarão em um Block Volume separado (passo 4).
9. *Create*. Aguarde o estado **RUNNING** e anote o **Public IP address**.

**Abrir as portas na VCN:** *Networking → Virtual Cloud Networks → (sua VCN) → Security Lists →
Default Security List → Add Ingress Rules*:

| Source CIDR | Protocolo | Porta destino | Uso |
|---|---|---|---|
| 0.0.0.0/0 | TCP | 80 | HTTP (redireciona para HTTPS e emite o certificado) |
| 0.0.0.0/0 | TCP | 443 | HTTPS |
| 0.0.0.0/0 | UDP | 443 | HTTP/3 (opcional) |

A regra da porta 22 (SSH) já vem criada. Se possível, restrinja-a ao seu IP. **Não** crie regras
para 6379 (Redis), 8000 (API) ou 5432.

### Sem capacidade ("Out of host capacity")

É comum em regiões concorridas. Alternativas que continuam gratuitas:

1. Tente **outro Availability Domain** ou outro *Fault Domain* no mesmo formulário.
2. Tente um shape menor, como **1 OCPU / 6 GB**, e aumente depois (*Edit → Shape*) quando houver capacidade.
   O PDBook roda com 1 OCPU; reduza `WORKER_CPUS=0.8`, `WORKER_MEM_LIMIT=2g`, `API_WORKERS=1`.
3. Repita a tentativa em outros horários. A capacidade é liberada continuamente.
4. Último recurso: **VM.Standard.E2.1.Micro** (AMD, 1 GB RAM, Always Free). Com ela, desative o OCR
   (`OCR_ENABLED=false`), use `API_WORKERS=1`, `WORKER_MEMORY_LIMIT_MB=600`, `WORKER_MEM_LIMIT=700m`,
   `MAX_PDF_PAGES=120` e crie swap. As imagens Docker do projeto também funcionam em x86_64.

Não troque o tipo de conta para obter capacidade.

---

## 2. Conectar por SSH

```bash
chmod 600 ~/Downloads/ssh-key-*.key
ssh -i ~/Downloads/ssh-key-*.key ubuntu@IP_PUBLICO      # Oracle Linux: usuário "opc"
```

No Windows (PowerShell): `ssh -i C:\caminho\ssh-key.key ubuntu@IP_PUBLICO`.

Confirme a arquitetura e os recursos **antes** de instalar qualquer coisa:

```bash
uname -m            # deve mostrar aarch64
nproc; free -h; df -h /; lsblk
```

---

## 3. Instalar dependências e preparar o ARM64

```bash
sudo apt-get update && sudo apt-get install -y git     # Oracle Linux: sudo dnf install -y git
sudo git clone <URL-DO-SEU-REPOSITORIO> /opt/pdbook
sudo chown -R "$USER" /opt/pdbook
cd /opt/pdbook
sudo DATA_DIR=/mnt/pdbook-data ./scripts/oci-setup.sh
exit    # saia e entre de novo para o grupo "docker" valer
```

O `oci-setup.sh`:

- verifica a arquitetura;
- instala Docker Engine e o plugin Compose a partir do repositório oficial (com pacotes arm64);
- libera 80/443 no firewall do sistema. As imagens Ubuntu da OCI bloqueiam tudo além do SSH via iptables;
- cria o diretório de dados com o dono correto (uid 10001);
- cria 2 GB de swap.

Ele **não formata discos**.

---

## 4. Block Volume para os documentos (recomendado)

O plano Always Free inclui armazenamento em bloco gratuito, somando boot e block volumes. Confira
o total da sua conta.

1. *Storage → Block Volumes → Create Block Volume*: nome `pdbook-data`, mesmo AD da VM, tamanho
   **50 GB** (ajuste ao que sobra da franquia), *Volume performance*: Balanced.
2. Na instância: *Attached block volumes → Attach block volume* → selecione o volume →
   *Attachment type*: **Paravirtualized**, que não exige comandos iSCSI.
3. Na VM:

```bash
lsblk                                # identifique o novo disco, ex.: /dev/sdb (sem partições)
sudo mkfs.ext4 -L pdbook /dev/sdb  # SOMENTE em um volume novo e vazio — apaga o conteúdo!
sudo mkdir -p /mnt/pdbook-data
echo 'LABEL=pdbook /mnt/pdbook-data ext4 defaults,_netdev,nofail 0 2' | sudo tee -a /etc/fstab
sudo mount -a && df -h /mnt/pdbook-data
sudo mkdir -p /mnt/pdbook-data/{originals,converted,tmp}
sudo chown -R 10001:10001 /mnt/pdbook-data
```

Ajuste `STORAGE_LIMIT_MB` no `.env` para algo abaixo do tamanho do volume, por exemplo 45000 para 50 GB.

---

## 5. Configurar o Neon

1. Em <https://console.neon.tech>, crie um projeto (*Free plan*). Escolha a região mais próxima da VM.
   Ex.: VM em `sa-saopaulo-1` → Neon em `aws-sa-east-1`.
2. Crie o banco `pdbook`, ou use o padrão `neondb` e ajuste as URLs.
3. *Connect*: copie **duas** connection strings:
   - **Pooled** (host com `-pooler`) → `DATABASE_URL`
   - **Direct** (sem `-pooler`, opção *Connection pooling* desligada) → `DATABASE_MIGRATION_URL`
4. Mantenha `sslmode=require`. O PDBook converte `postgresql://` para o driver psycopg automaticamente.

O plano gratuito do Neon suspende o banco quando ocioso. A primeira requisição depois disso leva
alguns segundos, e o pool da aplicação já está preparado para isso (`pool_pre_ping`, `pool_recycle`).

---

## 6. Variáveis de ambiente e migrations

```bash
cd /opt/pdbook
cp .env.example .env
openssl rand -hex 32     # -> SESSION_SECRET
openssl rand -hex 24     # -> REDIS_PASSWORD (repita o valor dentro de REDIS_URL)
nano .env                # preencha DATABASE_URL, DATABASE_MIGRATION_URL, SITE_ADDRESS, FRONTEND_URL, ACME_EMAIL, DATA_DIR
chmod 600 .env
./scripts/preflight.sh   # valida host, .env, permissões e DNS
```

Migrations (cria as tabelas no Neon):

```bash
docker compose build
docker compose up -d redis
docker compose run --rm backend python -m app.cli check-config
docker compose run --rm backend alembic upgrade head
```

---

## 7. Construir e iniciar os containers

```bash
docker compose up -d
docker compose ps        # backend/worker/redis devem ficar "healthy"
```

Para atualizações futuras, use sempre `./scripts/deploy.sh`. Ele faz preflight, backup, build,
migrations, reinício e verificação de saúde (passo 11).

Somente o Caddy publica portas. Confira com `sudo ss -tlnp | grep -E ':(80|443|6379|8000)\b'`:
devem aparecer só 80 e 443.

---

## 8. Domínio e HTTPS

1. No seu provedor de DNS, crie um registro **A** para o subdomínio (ex.: `leitura.seudominio.com`)
   apontando para o IP público da VM.
2. No `.env`: `SITE_ADDRESS=leitura.seudominio.com`, `FRONTEND_URL=https://leitura.seudominio.com`,
   `ACME_EMAIL=seu@email`, `COOKIE_SECURE=true`.
3. `docker compose up -d caddy`. O Caddy obtém e renova o certificado Let's Encrypt sozinho. As portas
   80 e 443 precisam estar abertas na Security List e no firewall do host (passos 1 e 3).
4. Acompanhe: `docker compose logs -f caddy` (procure por `certificate obtained successfully`).

**Sem domínio ainda?** Use `SITE_ADDRESS=:80`, `FRONTEND_URL=http://IP_PUBLICO` e `COOKIE_SECURE=false`
apenas para teste. Não use em produção: as senhas trafegariam sem criptografia.

---

## 9. Logs e health checks

```bash
docker compose ps                                   # estado e saúde de cada serviço
docker compose logs --tail=100 backend worker       # API e conversões
docker compose logs -f worker                       # acompanhar conversões ao vivo
curl -s https://leitura.seudominio.com/api/health   # liveness
docker compose exec backend python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8000/api/health/ready').read().decode())"
docker compose exec backend python -m app.cli storage   # uso de disco
docker stats --no-stream                            # CPU/memória por container
```

`/api/health/ready` informa o estado do banco, do Redis e o número de workers ativos, sem expor
endereços. Os logs não contêm senhas, tokens, cookies nem termos de busca.

---

## 10. Backup e restauração

Veja [BACKUP.md](BACKUP.md). Resumo:

```bash
./scripts/backup.sh                    # banco + PDFs -> destino externo, com verificação
./scripts/restore.sh --list
./scripts/restore.sh 20260101T033000Z  [--with-db]
```

Agende no cron: `30 3 * * * cd /opt/pdbook && ./scripts/backup.sh >> /var/log/pdbook-backup.log 2>&1`

---

## 11. Atualizar a aplicação com segurança

```bash
cd /opt/pdbook
./scripts/deploy.sh
```

O script, em ordem:

1. Roda o preflight.
2. Faz backup.
3. Executa `git pull --ff-only`.
4. Reconstrói as imagens.
5. Aplica as migrations.
6. Reinicia os serviços.
7. Espera os health checks.

Se a API não ficar pronta, ele mostra o comando para voltar à versão anterior:

```bash
git checkout <versao-anterior> && SKIP_PULL=1 SKIP_BACKUP=1 ./scripts/deploy.sh
```

Se uma migration alterar dados de forma incompatível, crie antes um **branch** do banco no Neon
(*Branches → Create branch*). Ele serve de ponto de retorno instantâneo.

Atualizações do sistema operacional: `sudo apt-get update && sudo apt-get upgrade -y`, depois
`sudo reboot`. Os containers voltam sozinhos (`restart: unless-stopped`).
