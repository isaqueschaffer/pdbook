# Backup e restauração

## O que precisa de backup

| Dado | Onde fica | Reconstruível? | No backup |
|---|---|---|---|
| Contas, livros, progresso, marcadores, notas, preferências | Neon | Não | Sim (`pg_dump`) |
| PDFs originais | `DATA_DIR/originals` | Não | Sim |
| Conteúdo convertido e imagens extraídas | `DATA_DIR/converted` | **Sim** (reprocessando) | Opcional (`BACKUP_INCLUDE_CONVERTED=true`) |
| Fila Redis | volume `redis-data` | Sim (tarefas podem ser reenviadas) | Não |
| Certificados TLS | volume `caddy-data` | Sim (o Caddy reemite) | Não |

> Uma cópia no mesmo disco, ou num snapshot do mesmo volume, **não é backup**: ela some junto com a VM
> ou com a conta. O `backup.sh` recusa rodar sem um destino externo configurado.

O Neon também mantém um histórico próprio de restauração (*point-in-time restore*), com janela
curta no plano gratuito. Ele complementa o `pg_dump`, mas não o substitui.

## Destinos externos gratuitos

Escolha **um**:

- **rclone** (`BACKUP_RCLONE_REMOTE`): qualquer serviço suportado pelo rclone (Google Drive, OneDrive,
  Dropbox, Backblaze B2 dentro da cota gratuita, ou o **Object Storage Always Free da OCI**, que fica
  fora da VM). Configure uma vez:
  ```bash
  mkdir -p ~/.config/rclone
  docker run --rm -it -v ~/.config/rclone:/config/rclone rclone/rclone:1.68 config
  # .env: BACKUP_RCLONE_REMOTE=meuremote:bookflow-backups
  ```
  Para o Object Storage da OCI, crie um bucket *Standard* (confira o selo Always Free) e um
  *Customer Secret Key* (compatível com S3). No rclone, use o tipo `s3`, provider `Other`, endpoint
  `https://<namespace>.compat.objectstorage.<regiao>.oraclecloud.com`.
- **rsync** (`BACKUP_RSYNC_TARGET`): outro servidor ou computador acessível por SSH com chave, por
  exemplo `usuario@casa.exemplo.com:/backups/bookflow`.

## Executar e agendar

```bash
./scripts/backup.sh
```

O script faz, em ordem:

1. `pg_dump` do Neon, usando a URL direta `DATABASE_MIGRATION_URL`.
2. `tar.gz` dos PDFs, e do conteúdo convertido se você ativou essa opção.
3. Gera um manifesto e o arquivo `SHA256SUMS`.
4. Envia tudo para o destino.
5. Confere no destino: `rclone check --checksum`, ou um *dry-run* do rsync com checksum.
6. Aplica a retenção de `BACKUP_KEEP_DAYS` (apenas no rclone).
7. Apaga a cópia local temporária.

Cron diário:

```cron
30 3 * * * cd /opt/bookflow && ./scripts/backup.sh >> /var/log/bookflow-backup.log 2>&1
```

## Verificar se os backups estão sendo concluídos

- `cat backups/last-success` mostra o carimbo do último backup **verificado no destino**. O arquivo só
  é escrito depois da conferência de checksums.
- `tail -n 20 /var/log/bookflow-backup.log` deve terminar em `concluído e verificado no destino`.
- `./scripts/restore.sh --list` lista o que existe no destino.
- Alerta simples por cron, com aviso se o último backup tiver mais de 2 dias:
  ```cron
  0 9 * * * find /opt/bookflow/backups/last-success -mmin -2880 | grep -q . || echo "BookFlow: backup atrasado" | logger -t bookflow
  ```
- Faça um **teste de restauração** periódico. Por exemplo, uma vez por mês, restaure num branch do Neon
  e numa pasta temporária.

## Restaurar

```bash
./scripts/restore.sh --list
./scripts/restore.sh 20260101T033000Z            # somente arquivos
./scripts/restore.sh 20260101T033000Z --with-db  # arquivos + banco (pede confirmação)
```

O restore faz, em ordem:

1. Baixa o backup e confere o `SHA256SUMS`. Se o backup estiver corrompido, aborta antes de mexer em qualquer coisa.
2. Para a API e o worker.
3. Substitui as pastas de dados. As anteriores ficam em `*.old` até você conferir.
4. Com `--with-db`, roda `pg_restore --clean`. Antes disso, crie um branch do banco atual no Neon
   como ponto de retorno.
5. Reinicia os serviços.
6. Roda `python -m app.cli verify-files`, que lista livros sem PDF original.
7. Roda `python -m app.cli reprocess-missing`, que reenfileira a conversão dos livros cujo conteúdo
   convertido não estava no backup.

### Recuperação da VM inteira

1. Crie uma nova VM (DEPLOY_OCI.md, passos 1 a 4).
2. Clone o repositório e recrie o `.env`. Guarde uma cópia do `.env` num gerenciador de senhas:
   ele **não** entra no backup, por conter segredos.
3. Configure o rclone ou o rsync e rode `./scripts/restore.sh <stamp>`. Use `--with-db` apenas se o
   banco Neon também tiver sido perdido.
4. Rode `./scripts/deploy.sh`.
