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

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
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
  "name": "universal-licensing-server",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test"
  }
}
JSON
  ok "Created package.json."
}

setup_env_file() {
  local env_file=".env"
  local port="4000"
  local admin_token="$(generate_secret)"
  local device_salt="$(generate_secret)"

  if [[ -f "$env_file" ]]; then
    ok ".env already exists."
    return
  fi

  cat > "$env_file" <<EOF2
PORT=$port
ADMIN_TOKEN=$admin_token
DEVICE_SALT=$device_salt
EOF2
  ok "Created .env with PORT, ADMIN_TOKEN, and DEVICE_SALT."
}

install_dependencies() {
  if [[ -d node_modules ]]; then
    ok "node_modules already present."
    return
  fi
  log "Installing npm dependencies."
  npm install
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
  local admin_token="${ADMIN_TOKEN:-dev-admin-token-change-me}"
  local tmp_product tmp_license tmp_response
  tmp_product="$(mktemp)"
  tmp_license="$(mktemp)"
  tmp_response="$(mktemp)"

  log "Starting server for smoke test on port $port"
  node src/server.js > /tmp/license-server-setup.log 2>&1 &
  local server_pid=$!

  cleanup() {
    if kill -0 "$server_pid" >/dev/null 2>&1; then
      kill "$server_pid" >/dev/null 2>&1 || true
      wait "$server_pid" 2>/dev/null || true
    fi
    rm -f "$tmp_product" "$tmp_license" "$tmp_response"
  }
  trap cleanup EXIT

  local ready=0
  for _ in {1..30}; do
    if curl -sSf "http://localhost:${port}/healthz" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.3
  done

  if [[ "$ready" -eq 0 ]]; then
    fail "Server failed to start. See /tmp/license-server-setup.log"
  fi

  local product_status product_id license_status license_key activation_status revoke_status validate_status

  product_status="$(curl -sS -o "$tmp_product" -w '%{http_code}' -X POST "http://localhost:${port}/v1/admin/products" \
    -H "Authorization: Bearer ${admin_token}" \
    -H 'Content-Type: application/json' \
    -d '{"name":"Setup Smoke Test","policy_defaults":{"max_devices":1,"offline_grace_days":7,"check_in_interval_hours":24}}')"

  [[ "$product_status" == "201" ]] || fail "Product create request failed with status $product_status. Response: $(cat "$tmp_product")"

  product_id="$(node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(!d.id)process.exit(1);console.log(d.id);" "$tmp_product")" || fail "Could not parse created product id"

  license_status="$(curl -sS -o "$tmp_license" -w '%{http_code}' -X POST "http://localhost:${port}/v1/admin/licenses" \
    -H "Authorization: Bearer ${admin_token}" \
    -H 'Content-Type: application/json' \
    -d "{\"product_id\":\"${product_id}\",\"type\":\"subscription\",\"expires_at\":\"2031-01-01T00:00:00.000Z\"}")"

  [[ "$license_status" == "201" ]] || fail "License create request failed with status $license_status. Response: $(cat "$tmp_license")"

  license_key="$(node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(!d.license_key)process.exit(1);console.log(d.license_key);" "$tmp_license")" || fail "Could not parse created license key"

  activation_status="$(curl -sS -o "$tmp_response" -w '%{http_code}' -X POST "http://localhost:${port}/v1/activate" \
    -H 'Content-Type: application/json' \
    -d "{\"product_id\":\"${product_id}\",\"license_key\":\"${license_key}\",\"device_fingerprint\":\"setup-device-1\",\"app_version\":\"1.0.0\"}")"

  [[ "$activation_status" == "200" ]] || fail "Activation request failed with status $activation_status. Response: $(cat "$tmp_response")"

  node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(d.valid!==true||d.status!=='active')process.exit(1);" "$tmp_response" || fail "Activation did not return valid=true and status=active"

  revoke_status="$(curl -sS -o "$tmp_response" -w '%{http_code}' -X POST "http://localhost:${port}/v1/admin/licenses/${license_key}/revoke" \
    -H "Authorization: Bearer ${admin_token}")"

  [[ "$revoke_status" == "200" ]] || fail "Revoke request failed with status $revoke_status. Response: $(cat "$tmp_response")"

  validate_status="$(curl -sS -o "$tmp_response" -w '%{http_code}' -X POST "http://localhost:${port}/v1/validate" \
    -H 'Content-Type: application/json' \
    -d "{\"product_id\":\"${product_id}\",\"license_key\":\"${license_key}\",\"device_fingerprint\":\"setup-device-1\",\"app_version\":\"1.0.0\"}")"

  [[ "$validate_status" == "200" ]] || fail "Post-revoke validate failed with status $validate_status. Response: $(cat "$tmp_response")"

  node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(d.valid!==false||d.status!=='revoked'||d.errorReason!=='revoked')process.exit(1);" "$tmp_response" || fail "Expected revoked license to return valid=false, status=revoked, and errorReason=revoked"

  ok "Smoke test passed (create product -> issue license -> activate -> revoke -> validate)."
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
  curl -X POST http://localhost:${PORT:-4000}/v1/admin/products \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d '{"name":"My Product","policy_defaults":{"max_devices":2}}'

  curl -X POST http://localhost:${PORT:-4000}/v1/validate \
    -H 'Content-Type: application/json' \
    -d '{"product_id":"<PRODUCT_ID>","license_key":"<LICENSE_KEY>","device_fingerprint":"devbox-1"}'
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
