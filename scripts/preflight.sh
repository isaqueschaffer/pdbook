#!/usr/bin/env bash
# Verifies the host and the .env before (re)deploying. Exits non-zero on blocking problems.
#   ./scripts/preflight.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

fail=0
ok()   { printf '  [ok]    %s\n' "$*"; }
warn() { printf '  [aviso] %s\n' "$*"; }
bad()  { printf '  [ERRO]  %s\n' "$*"; fail=1; }

echo "Host"
arch="$(uname -m)"; [ "$arch" = "aarch64" ] && ok "arquitetura $arch" || warn "arquitetura $arch (esperado aarch64 na OCI A1)"
command -v docker >/dev/null && ok "$(docker --version)" || bad "docker não instalado"
docker compose version >/dev/null 2>&1 && ok "$(docker compose version)" || bad "docker compose ausente"
docker info >/dev/null 2>&1 && ok "daemon Docker acessível" || bad "sem acesso ao daemon Docker (grupo docker?)"
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
[ "$mem_mb" -ge 3500 ] && ok "memória ${mem_mb} MB" || warn "memória ${mem_mb} MB — reduza WORKER_MEM_LIMIT/WORKER_MEMORY_LIMIT_MB"

echo ".env"
[ -f .env ] || { bad ".env não encontrado (cp .env.example .env)"; exit 1; }
set -a; . ./.env; set +a
for v in DATABASE_URL SESSION_SECRET REDIS_PASSWORD REDIS_URL SITE_ADDRESS FRONTEND_URL DATA_DIR; do
  [ -n "${!v:-}" ] && ok "$v definido" || bad "$v não definido"
done
case "${SESSION_SECRET:-}" in troque*|"") bad "SESSION_SECRET ainda é o valor de exemplo";; esac
case "${REDIS_PASSWORD:-}" in troque*|"") bad "REDIS_PASSWORD ainda é o valor de exemplo";; esac
case "${DATABASE_URL:-}" in *ep-exemplo*) bad "DATABASE_URL ainda é o exemplo";; *sslmode=require*) ok "DATABASE_URL com sslmode=require";; *) warn "DATABASE_URL sem sslmode=require";; esac
[[ "${REDIS_URL:-}" == *"${REDIS_PASSWORD:-x}"* ]] && ok "REDIS_URL usa REDIS_PASSWORD" || bad "REDIS_URL não contém REDIS_PASSWORD"

echo "Armazenamento"
if [ -d "${DATA_DIR:-/nonexistent}" ]; then
  mountpoint -q "$DATA_DIR" && ok "$DATA_DIR é um volume montado" || warn "$DATA_DIR não é um ponto de montagem (dados no boot volume)"
  owner=$(stat -c %u "$DATA_DIR"); [ "$owner" = "10001" ] && ok "dono uid 10001" || bad "$DATA_DIR deve pertencer ao uid 10001 (sudo chown -R 10001:10001 $DATA_DIR)"
  free_mb=$(df -Pm "$DATA_DIR" | awk 'NR==2 {print $4}')
  [ "$free_mb" -gt "${MIN_FREE_DISK_MB:-1024}" ] && ok "${free_mb} MB livres" || bad "apenas ${free_mb} MB livres"
else
  bad "DATA_DIR ($DATA_DIR) não existe"
fi

echo "Rede"
if [ "${SITE_ADDRESS:-:80}" != ":80" ] && command -v getent >/dev/null; then
  dns=$(getent ahostsv4 "$SITE_ADDRESS" | awk 'NR==1 {print $1}')
  pub=$(curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || true)
  if [ -z "$dns" ]; then bad "$SITE_ADDRESS não resolve no DNS"
  elif [ -n "$pub" ] && [ "$dns" != "$pub" ]; then warn "$SITE_ADDRESS aponta para $dns, mas o IP público desta VM é $pub"
  else ok "$SITE_ADDRESS -> $dns"; fi
fi

[ $fail -eq 0 ] && echo "Preflight OK." || echo "Corrija os itens [ERRO] antes de continuar."
exit $fail
