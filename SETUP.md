# Universal Licensing Server Setup

## Stack
- Node.js 20+
- HTTP API served by `src/server.js`
- JSON state backend (`data.json` by default)

## Environment
```bash
export ADMIN_TOKEN=$(openssl rand -hex 32)
export DEVICE_SALT=$(openssl rand -hex 32)
export PORT=4000
```

## Install + Run
```bash
npm install
npm start
```

## Bootstrapping
1. Create product (`POST /v1/admin/products`).
2. Create license (`POST /v1/admin/licenses`).
3. Activate device (`POST /v1/activate`).
4. Validate on launch (`POST /v1/validate`).
5. Optional: issue offline token (`POST /v1/offline-token`).

## cURL examples
```bash
curl -X POST http://localhost:4000/v1/admin/products \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"DesktopPro","policy_defaults":{"max_devices":3,"offline_grace_days":14,"check_in_interval_hours":12,"features":{"tier":"pro"}}}'
```

```bash
curl -X POST http://localhost:4000/v1/admin/licenses \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"product_id":"<PRODUCT_ID>","type":"subscription","expires_at":"2031-01-01T00:00:00.000Z","metadata":{"features":{"tier":"pro"}},"customer":{"email":"dev@example.com"}}'
```

```bash
curl -X POST http://localhost:4000/v1/activate -H 'content-type: application/json' \
  -d '{"product_id":"<PRODUCT_ID>","license_key":"<LICENSE_KEY>","device_fingerprint":"install-id-abc"}'
```

```bash
curl -X POST http://localhost:4000/v1/validate -H 'content-type: application/json' \
  -d '{"product_id":"<PRODUCT_ID>","license_key":"<LICENSE_KEY>","device_fingerprint":"install-id-abc","app_version":"2.4.0"}'
```

## Production notes
- Put the API behind TLS-only ingress.
- Replace bearer admin auth with OIDC or mTLS if you need operator identity and revocation.
- Move persisted state to Postgres and centralized rate-limit counters/lockouts to Redis.
- Rotate per-product Ed25519 keys with public-key overlap during migration windows.
- Export and archive `/v1/admin/export/audit.csv` regularly.
