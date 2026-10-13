#!/usr/bin/env bash
# Research Intelligence Platform — one-command management.
#
#   ./rip.sh start          first run: creates .env with random secrets, builds and starts everything
#   ./rip.sh start --domain research.example.org --email you@example.org
#                           same, plus a public HTTPS website (automatic Let's Encrypt certificate)
#   ./rip.sh admin          create a user account (asks for email, name, password)
#   ./rip.sh verify         live check of OpenAlex / Crossref from this machine
#   ./rip.sh status | logs | stop | backup | update
set -euo pipefail
cd "$(dirname "$0")"

env_get() { [ -f .env ] && grep "^$1=" .env | tail -1 | cut -d= -f2- || true; }

PORT="${RIP_PORT:-$(env_get RIP_PORT)}"; PORT="${PORT:-8080}"
URL="http://localhost:${PORT}"   # local address (the app listens on 127.0.0.1 only)

die() { echo "error: $*" >&2; exit 1; }
need_docker() {
  command -v docker >/dev/null || die "Docker is not installed: https://docs.docker.com/get-docker/"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose ...)"
  docker info >/dev/null 2>&1 || die "Docker is not running"
}
rand() {
  if command -v openssl >/dev/null; then openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-48
  else python3 -c "import secrets;print(secrets.token_urlsafe(36))"; fi
}
set_env() {  # set_env KEY VALUE  (replace or append in .env)
  local k="$1" v="$2"
  if grep -q "^${k}=" .env; then
    local tmp; tmp="$(mktemp)"
    awk -v k="$k" -v v="$v" -F= '$1==k {print k"="v; next} {print}' .env > "$tmp" && mv "$tmp" .env
  else
    echo "${k}=${v}" >> .env
  fi
}

init_env() {
  [ -f .env ] && return
  echo "Creating .env with fresh random secrets…"
  cp .env.example .env
  set_env RIP_ENV production
  set_env RIP_SECRET_KEY "$(rand)"
  set_env POSTGRES_PASSWORD "$(rand)"
  set_env MINIO_ROOT_USER "rip-$(rand | cut -c1-8)"
  set_env MINIO_ROOT_PASSWORD "$(rand)"
  set_env RIP_CORS_ORIGINS "[\"${URL}\"]"
  local email="${RIP_CONTACT_EMAIL:-}"
  if [ -z "$email" ] && [ -t 0 ]; then
    read -r -p "Contact email sent to OpenAlex/Crossref (recommended, Enter to skip): " email
  fi
  set_env RIP_CONTACT_EMAIL "$email"
  chmod 600 .env
  echo ".env created (keep it private; it is git-ignored)."
}

configure_domain() {  # configure_domain DOMAIN EMAIL OPEN_REGISTRATION
  local domain="$1" email="$2" open_reg="$3"
  [[ "$domain" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ || "$domain" == localhost ]] \
    || die "not a valid domain name: $domain"
  [ -n "$email" ] || email="$(env_get RIP_ACME_EMAIL)"
  [ -n "$email" ] || email="$(env_get RIP_CONTACT_EMAIL)"
  if [ -z "$email" ] && [ -t 0 ]; then read -r -p "Email for Let's Encrypt certificate notices: " email; fi
  [ -n "$email" ] || die "--email is required for the HTTPS certificate"
  if ! getent ahosts "$domain" >/dev/null 2>&1; then
    echo "warning: $domain does not resolve yet. Create a DNS A record pointing to this server's public IP;"
    echo "         the certificate is issued automatically once it resolves."
  fi
  set_env RIP_DOMAIN "$domain"
  set_env RIP_ACME_EMAIL "$email"
  set_env RIP_CORS_ORIGINS "[\"https://${domain}\"]"
  set_env COMPOSE_FILE "docker-compose.yml:docker-compose.domain.yml"
  if [ "$open_reg" = yes ]; then
    set_env RIP_ALLOW_REGISTRATION true
  else
    set_env RIP_ALLOW_REGISTRATION false
  fi
}

wait_public() {  # best effort: certificate issuance needs working DNS and open ports 80/443
  local domain="$1"
  echo -n "Checking https://${domain} "
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 5 "https://${domain}/api/v1/health" >/dev/null 2>&1; then echo " ready."; return 0; fi
    echo -n "."; sleep 3
  done
  echo
  echo "warning: https://${domain} is not reachable yet. Check that:"
  echo "  - the DNS A record for ${domain} points to this server"
  echo "  - ports 80 and 443 are open (e.g. ufw allow 80,443/tcp; and your cloud firewall)"
  echo "  - certificate progress: ./rip.sh logs caddy"
  return 1
}

wait_healthy() {
  echo -n "Waiting for the app at ${URL} "
  for _ in $(seq 1 90); do
    if curl -fsS "${URL}/api/v1/health" >/dev/null 2>&1; then echo " ready."; return 0; fi
    echo -n "."; sleep 2
  done
  echo; docker compose ps; die "the app did not become healthy; see ./rip.sh logs"
}

case "${1:-help}" in
  start)
    shift
    domain="" email="" open_reg=no
    while [ $# -gt 0 ]; do
      case "$1" in
        --domain) domain="${2:-}"; shift 2 ;;
        --email) email="${2:-}"; shift 2 ;;
        --open-registration) open_reg=yes; shift ;;
        *) die "unknown option: $1" ;;
      esac
    done
    need_docker; init_env
    if [ -n "$domain" ]; then configure_domain "$domain" "$email" "$open_reg"; fi
    docker compose up -d --build --remove-orphans
    wait_healthy
    domain="$(env_get RIP_DOMAIN)"
    echo
    if [ -n "$domain" ]; then
      wait_public "$domain" || true
      echo "Research Intelligence website: https://${domain}"
      if [ "$(env_get RIP_ALLOW_REGISTRATION)" = false ]; then
        echo "Self-registration is OFF. Create accounts with: ./rip.sh admin"
      fi
    else
      echo "Research Intelligence is running on this machine: ${URL}"
      echo "Create the first account in the browser, or run: ./rip.sh admin"
      echo "To publish it on your domain with HTTPS: ./rip.sh start --domain your.domain --email you@example.org"
    fi
    ;;
  admin)
    need_docker
    read -r -p "Email: " email; read -r -p "Display name: " name
    read -r -s -p "Password (min 10 chars): " pw; echo
    docker compose exec -T -e RIP_NEW_USER_PASSWORD="$pw" api python -m app.cli create-user "$email" "$name"
    ;;
  verify)
    need_docker
    docker compose exec api sh -c 'RIP_VERIFY_REPORT=/tmp/report.json python -m app.cli verify-connectors'
    ;;
  status)
    need_docker; docker compose ps
    if curl -fs "${URL}/api/v1/health" >/dev/null; then echo "local ${URL}: healthy"; else echo "local ${URL}: NOT responding"; fi
    d="$(env_get RIP_DOMAIN)"
    if [ -n "$d" ]; then
      if curl -fs --max-time 5 "https://${d}/api/v1/health" >/dev/null; then echo "https://${d}: healthy"
      else echo "https://${d}: NOT reachable (DNS, ports 80/443 or certificate; see ./rip.sh logs caddy)"; fi
    fi
    ;;
  logs)   need_docker; docker compose logs -f --tail=200 "${@:2}" ;;
  stop)   need_docker; docker compose down; echo "Stopped. Data is kept in Docker volumes." ;;
  update) need_docker; git pull --ff-only; docker compose up -d --build; wait_healthy ;;
  backup)
    need_docker
    dir="backups/$(date +%Y%m%d-%H%M%S)"; mkdir -p "$dir"
    docker compose exec -T db pg_dump -U rip -Fc rip > "$dir/rip.dump"
    mu="$(grep '^MINIO_ROOT_USER=' .env | cut -d= -f2-)"; mp="$(grep '^MINIO_ROOT_PASSWORD=' .env | cut -d= -f2-)"
    docker run --rm --network research-intel_default -v "$PWD/$dir/objects:/backup" \
      -e MC_HOST_local="http://${mu}:${mp}@minio:9000" \
      minio/mc:RELEASE.2024-11-05T11-29-45Z mirror --quiet local/rip-private /backup
    echo "Backup written to $dir (database dump + PDF/export objects). See docs/OPERATIONS.md to restore."
    ;;
  *)
    sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
    ;;
esac
