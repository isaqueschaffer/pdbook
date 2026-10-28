#!/usr/bin/env bash
# Prepares a fresh OCI Ampere A1 VM (Ubuntu 22.04/24.04 or Oracle Linux 8/9, ARM64) for BookFlow.
# Installs Docker Engine + Compose plugin, opens ports 80/443 in the host firewall and creates the
# data directory. It does NOT format disks and does NOT touch your OCI account.
#
#   sudo DATA_DIR=/mnt/bookflow-data ./scripts/oci-setup.sh
set -euo pipefail

DATA_DIR="${DATA_DIR:-/mnt/bookflow-data}"
APP_UID=10001   # user inside the backend image

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "execute com sudo"

ARCH="$(uname -m)"
log "Arquitetura: $ARCH"
[ "$ARCH" = "aarch64" ] || echo "AVISO: esperado aarch64 (Ampere A1). Continuando mesmo assim."

. /etc/os-release
log "Sistema: $PRETTY_NAME"
echo "CPUs: $(nproc)  |  Memória: $(free -h | awk '/Mem:/ {print $2}')  |  Disco /: $(df -h / | awk 'NR==2 {print $4}') livres"

if ! command -v docker >/dev/null 2>&1; then
  log "Instalando Docker Engine"
  case "$ID" in
    ubuntu|debian)
      apt-get update
      apt-get install -y ca-certificates curl gnupg
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
      chmod a+r /etc/apt/keyrings/docker.asc
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \
        > /etc/apt/sources.list.d/docker.list
      apt-get update
      apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    ol|rhel|centos|rocky|almalinux)
      dnf install -y dnf-plugins-core
      dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
      dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    *) die "distribuição não suportada por este script: $ID (instale o Docker manualmente)" ;;
  esac
  systemctl enable --now docker
else
  log "Docker já instalado: $(docker --version)"
fi
docker compose version >/dev/null 2>&1 || die "plugin docker compose ausente"

if [ -n "${SUDO_USER:-}" ] && ! id -nG "$SUDO_USER" | grep -qw docker; then
  usermod -aG docker "$SUDO_USER"
  echo "Usuário $SUDO_USER adicionado ao grupo docker (saia e entre novamente na sessão SSH)."
fi

log "Liberando 80/443 no firewall do sistema"
# As imagens Ubuntu da OCI vêm com regras iptables que bloqueiam tudo além do SSH.
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http --add-service=https
  firewall-cmd --permanent --add-port=443/udp
  firewall-cmd --reload
elif command -v iptables >/dev/null 2>&1; then
  for rule in "-p tcp --dport 80" "-p tcp --dport 443" "-p udp --dport 443"; do
    # shellcheck disable=SC2086
    iptables -C INPUT -m state --state NEW $rule -j ACCEPT 2>/dev/null || iptables -I INPUT 5 -m state --state NEW $rule -j ACCEPT
  done
  if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save; fi
fi
echo "Lembrete: libere 80/tcp, 443/tcp e 443/udp também na Security List (ou NSG) da VCN no console da OCI."

log "Diretório de dados: $DATA_DIR"
if ! mountpoint -q "$DATA_DIR" 2>/dev/null; then
  echo "AVISO: $DATA_DIR não é um ponto de montagem. Se você anexou um Block Volume, monte-o aqui"
  echo "       (veja docs/DEPLOY_OCI.md, passo 4). Sem isso, os dados ficam no boot volume."
fi
mkdir -p "$DATA_DIR"/{originals,converted,tmp}
chown -R "$APP_UID:$APP_UID" "$DATA_DIR"
chmod 750 "$DATA_DIR"

if [ "$(swapon --show | wc -l)" -eq 0 ]; then
  log "Criando swap de 2 GB (proteção contra picos de memória)"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "Pronto. Próximos passos: configurar o .env e executar scripts/deploy.sh (docs/DEPLOY_OCI.md)."
