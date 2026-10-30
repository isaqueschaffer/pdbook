#!/usr/bin/env bash
# Restores a backup produced by scripts/backup.sh.
#   ./scripts/restore.sh <stamp>              restore files only (PDFs [+ converted])
#   ./scripts/restore.sh <stamp> --with-db    also restore the database (overwrites Neon data!)
#   ./scripts/restore.sh --list               list available backups
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

REMOTE="${BACKUP_RCLONE_REMOTE:-}"
RSYNC_TARGET="${BACKUP_RSYNC_TARGET:-}"
RCLONE_CONF_DIR="${RCLONE_CONFIG_DIR:-$HOME/.config/rclone}"
DB_URL="${DATABASE_MIGRATION_URL:-$DATABASE_URL}"
rclone() { docker run --rm --network host -v "$RCLONE_CONF_DIR:/config/rclone" -v "${MOUNT:-/tmp}:/data" rclone/rclone:1.68 "$@"; }

if [ "${1:-}" = "--list" ]; then
  if [ -n "$REMOTE" ]; then rclone lsf "$REMOTE" --dirs-only; else rsync --list-only "$RSYNC_TARGET/"; fi
  exit 0
fi

stamp="${1:?uso: restore.sh <stamp> [--with-db] | --list}"
with_db="${2:-}"
work="$(mktemp -d /var/tmp/pdbook-restore.XXXX)"
trap 'rm -rf "$work"' EXIT

echo "==> Baixando backup $stamp"
if [ -n "$REMOTE" ]; then MOUNT="$work" rclone copy "$REMOTE/$stamp" /data; else rsync -a "$RSYNC_TARGET/$stamp/" "$work/"; fi
(cd "$work" && sha256sum -c SHA256SUMS) || { echo "ERRO: checksums não conferem; backup corrompido"; exit 1; }
cat "$work/manifest.txt"

if [ "$with_db" = "--with-db" ]; then
  echo
  echo "ATENÇÃO: isto SUBSTITUI os dados atuais do banco Neon pelo conteúdo de $stamp."
  echo "Dica: no Neon, crie antes um branch do banco atual (Branches > Create) como ponto de retorno."
  answer="${RESTORE_CONFIRM:-}"
  [ -n "$answer" ] || read -r -p "Digite RESTAURAR para continuar: " answer
  [ "$answer" = "RESTAURAR" ] || { echo "Cancelado."; exit 1; }
fi

if [ "${RESTORE_NO_COMPOSE:-0}" != "1" ]; then
  echo "==> Parando API e worker"
  docker compose stop backend worker caddy
fi

echo "==> Restaurando arquivos em $DATA_DIR"
staging="$DATA_DIR/.restore-$stamp"
mkdir -p "$staging"
tar -C "$staging" -xzf "$work/files.tar.gz"
for d in originals converted; do
  if [ -d "$staging/$d" ]; then
    rm -rf "$DATA_DIR/$d.old" && { [ -d "$DATA_DIR/$d" ] && mv "$DATA_DIR/$d" "$DATA_DIR/$d.old" || true; }
    mv "$staging/$d" "$DATA_DIR/$d"
  fi
done
rm -rf "$staging"
mkdir -p "$DATA_DIR"/{originals,converted,tmp}
chown -R 10001:10001 "$DATA_DIR" 2>/dev/null || sudo chown -R 10001:10001 "$DATA_DIR"

if [ "$with_db" = "--with-db" ]; then
  echo "==> Restaurando banco"
  args=(--clean --if-exists --no-owner --no-privileges --dbname="$DB_URL")
  if command -v pg_restore >/dev/null && [ "$(pg_restore --version | grep -oE '[0-9]+' | head -1)" -ge 17 ]; then
    pg_restore "${args[@]}" "$work/database.dump"
  else
    docker run --rm --network host -v "$work:/in:ro" postgres:17-alpine pg_restore "${args[@]}" /in/database.dump
  fi
fi

[ "${RESTORE_NO_COMPOSE:-0}" = "1" ] && { echo "Arquivos restaurados (serviços não reiniciados)."; exit 0; }
echo "==> Subindo serviços"
docker compose up -d
sleep 10
echo "==> Verificando arquivos x banco"
docker compose exec -T backend python -m app.cli verify-files || echo "Há livros sem o PDF original (veja acima)."
echo "==> Reprocessando livros cujo conteúdo convertido não estava no backup"
docker compose exec -T backend python -m app.cli reprocess-missing
echo "Cópias anteriores ficaram em $DATA_DIR/*.old — remova-as após conferir a restauração."
