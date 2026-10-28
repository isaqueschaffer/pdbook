#!/usr/bin/env bash
# Safe update: preflight -> backup -> build -> migrate -> restart -> health check.
#   ./scripts/deploy.sh            (first deploy or update)
#   SKIP_BACKUP=1 ./scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

./scripts/preflight.sh

if [ "${SKIP_BACKUP:-0}" != "1" ] && [ -n "$(docker compose ps -q backend 2>/dev/null)" ]; then
  echo "==> Backup antes da atualização"
  ./scripts/backup.sh
fi

previous=$(git rev-parse --short HEAD 2>/dev/null || echo "?")
if [ -d .git ] && [ "${SKIP_PULL:-0}" != "1" ]; then
  echo "==> Atualizando código (versão atual: $previous)"
  git pull --ff-only
fi

echo "==> Construindo imagens (ARM64 nativo na VM)"
docker compose build --pull

echo "==> Aplicando migrations no Neon"
docker compose up -d redis
docker compose run --rm backend alembic upgrade head

echo "==> Reiniciando serviços"
docker compose up -d --remove-orphans

echo "==> Aguardando health checks"
for _ in $(seq 1 40); do
  status=$(docker compose ps --format '{{.Service}} {{.Health}}' backend worker | awk '{print $2}' | sort -u | tr '\n' ' ')
  [ "$status" = "healthy " ] && break
  sleep 3
done
docker compose ps
if ! docker compose exec -T backend python -c "import urllib.request,sys;r=urllib.request.urlopen('http://127.0.0.1:8000/api/health/ready',timeout=10);print(r.read().decode())"; then
  echo "ERRO: a API não ficou pronta. Veja: docker compose logs --tail=100 backend worker"
  echo "Para voltar à versão anterior: git checkout $previous && SKIP_PULL=1 SKIP_BACKUP=1 ./scripts/deploy.sh"
  exit 1
fi

docker image prune -f >/dev/null
echo "==> Deploy concluído."
