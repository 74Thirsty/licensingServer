#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
  echo -e "${BLUE}[*]${NC} $*"
}

ok() {
  echo -e "${GREEN}[+]${NC} $*"
}

warn() {
  echo -e "${YELLOW}[!]${NC} $*"
}

fail() {
  echo -e "${RED}[-]${NC} $*"
  exit 1
}

confirm() {
  local prompt="$1"
  while true; do
    read -r -p "$prompt [y/n]: " yn
    case "$yn" in
      [Yy]*) return 0 ;;
      [Nn]*) return 1 ;;
      *) echo "Please answer y or n." ;;
    esac
  done
}

require_cmd() {
  local cmd="$1"
  local install_hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail "Missing required command: $cmd. $install_hint"
  fi
}

setup_package_json() {
  if [[ -f package.json ]]; then
    ok "package.json already exists."
    return
  fi

  log "package.json missing. Generating minimal Node project metadata."
  cat > package.json <<'JSON'
{
  "name": "licensing-server",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node license-server.js"
  }
}
JSON
  ok "Created package.json."
}

setup_env_file() {
  local env_file=".env"
  if [[ -f "$env_file" ]]; then
    ok ".env already exists."
    return
  fi

  local default_secret
  if command -v openssl >/dev/null 2>&1; then
    default_secret="$(openssl rand -hex 32)"
  else
    default_secret="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  fi

  local port="4000"

  cat > "$env_file" <<EOF2
PORT=$port
LICENSE_SECRET=$default_secret
EOF2
  ok "Created .env with PORT=$port and a generated LICENSE_SECRET."
}

install_dependencies() {
  if [[ -d node_modules/express ]]; then
    ok "express already installed."
    return
  fi
  log "Installing npm dependencies (express)."
  npm install express
  ok "Dependencies installed."
}

load_env() {
  if [[ -f .env ]]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
    ok "Loaded environment from .env"
  else
    warn ".env not found. Using shell environment/defaults."
  fi
}

run_smoke_test() {
  local port="${PORT:-4000}"
  local tmp_response tmp_key create_status validate_status revoke_status validate_after_revoke_status
  tmp_response="$(mktemp)"

  log "Starting server for smoke test on port $port"
  node license-server.js > /tmp/license-server-setup.log 2>&1 &
  local server_pid=$!

  cleanup() {
    if kill -0 "$server_pid" >/dev/null 2>&1; then
      kill "$server_pid" >/dev/null 2>&1 || true
      wait "$server_pid" 2>/dev/null || true
    fi
    rm -f "$tmp_response"
  }
  trap cleanup EXIT

  local ready=0
  for _ in {1..30}; do
    if curl -sSf "http://localhost:${port}" >/dev/null 2>&1 || curl -sS "http://localhost:${port}" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.3
  done

  if [[ "$ready" -eq 0 ]]; then
    fail "Server failed to start. See /tmp/license-server-setup.log"
  fi

  local now expires_at
  now="$(date +%s)"
  expires_at="$((now + 86400))"

  create_status="$(curl -sS -o "$tmp_response" -w '%{http_code}' -X POST "http://localhost:${port}/admin/licenses" \
    -H 'Content-Type: application/json' \
    -d "{\"productId\":\"demo-product\",\"expiresAt\":$expires_at}")"

  [[ "$create_status" == "200" ]] || fail "License create request failed with status $create_status. Response: $(cat "$tmp_response")"

  tmp_key="$(node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(!d.key)process.exit(1);console.log(d.key);" "$tmp_response")" || fail "Could not parse created license key"

  validate_status="$(curl -sS -o "$tmp_response" -w '%{http_code}' -X POST "http://localhost:${port}/licenses/validate" \
    -H 'Content-Type: application/json' \
    -d "{\"key\":\"$tmp_key\",\"productId\":\"demo-product\"}")"

  [[ "$validate_status" == "200" ]] || fail "Validate request failed with status $validate_status. Response: $(cat "$tmp_response")"

  node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(!d.valid)process.exit(1);" "$tmp_response" || fail "Validation did not return valid=true"

  revoke_status="$(curl -sS -o "$tmp_response" -w '%{http_code}' -X POST "http://localhost:${port}/admin/licenses/revoke" \
    -H 'Content-Type: application/json' \
    -d "{\"key\":\"$tmp_key\"}")"

  [[ "$revoke_status" == "200" ]] || fail "Revoke request failed with status $revoke_status. Response: $(cat "$tmp_response")"

  validate_after_revoke_status="$(curl -sS -o "$tmp_response" -w '%{http_code}' -X POST "http://localhost:${port}/licenses/validate" \
    -H 'Content-Type: application/json' \
    -d "{\"key\":\"$tmp_key\",\"productId\":\"demo-product\"}")"

  [[ "$validate_after_revoke_status" == "200" ]] || fail "Post-revoke validate failed with status $validate_after_revoke_status. Response: $(cat "$tmp_response")"

  node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(d.valid!==false||d.reason!=='revoked')process.exit(1);" "$tmp_response" || fail "Expected revoked license to return valid=false and reason=revoked"

  ok "Smoke test passed (create -> validate -> revoke -> validate)."
  cleanup
  trap - EXIT
}

show_next_steps() {
  cat <<'TXT'

Setup complete.

To run the server manually:
  source .env
  npm start

API quick checks:
  curl -X POST http://localhost:${PORT:-4000}/admin/licenses \
    -H 'Content-Type: application/json' \
    -d '{"productId":"my-product","expiresAt":1893456000}'

  curl -X POST http://localhost:${PORT:-4000}/licenses/validate \
    -H 'Content-Type: application/json' \
    -d '{"key":"<PASTE_KEY>","productId":"my-product"}'
TXT
}

main() {
  echo "Licensing Server Setup Wizard"
  echo "============================="

  require_cmd node "Install Node.js 18+ before continuing."
  require_cmd npm "Install npm before continuing."
  require_cmd curl "Install curl before continuing."

  log "Using Node $(node -v)"
  log "Using npm $(npm -v)"

  setup_package_json
  install_dependencies
  setup_env_file
  load_env

  if confirm "Run end-to-end API smoke test now?"; then
    run_smoke_test
  else
    warn "Skipped smoke test."
  fi

  show_next_steps
}

main "$@"
