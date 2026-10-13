#!/usr/bin/env bash
# Research Intelligence Platform — one-command management.
#
#   ./rip.sh start          first run: creates .env with random secrets, builds and starts everything
#   ./rip.sh admin          create a user account (asks for email, name, password)
#   ./rip.sh verify         live check of OpenAlex / Crossref from this machine
#   ./rip.sh status | logs | stop | backup | update
set -euo pipefail
cd "$(dirname "$0")"

PORT="${RIP_PORT:-8080}"
URL="http://localhost:${PORT}"

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
    need_docker; init_env
    docker compose up -d --build
    wait_healthy
    echo
    echo "Research Intelligence is running: ${URL}"
    echo "Create the first account in the browser, or run: ./rip.sh admin"
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
  status) need_docker; docker compose ps; curl -fsS "${URL}/api/v1/health" && echo ;;
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
    sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
