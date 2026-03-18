# Universal Licensing Server Setup

## Stack
- Node.js 20+
- Express REST API
- JSON state backend (portable baseline; swap with Postgres/Redis adapters for production HA)

## Environment
```bash
export ADMIN_TOKEN=466a8293caf26ce94d3d4339468d810a86ad8ddc19296c6687385379034a6d4a
export DEVICE_SALT=466a8293caf26ce94d3d4339468d810a86ad8ddc19296c6687385379034a6d4a
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
5. (Optional) issue offline token (`POST /v1/offline-token`).

## cURL examples
```bash
curl -X POST http://localhost:4000/v1/admin/products \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"DesktopPro","policy_defaults":{"max_devices":3,"offline_grace_days":14,"check_in_interval_hours":12,"features":{"tier":"pro"}}}'
```

```bash
curl -X POST http://localhost:4000/v1/admin/licenses \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
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
- Put API behind TLS-only ingress.
- Replace bearer admin token with OIDC or mTLS-signed admin tokens.
- Back state with Postgres, and move rate counters/locks to Redis.
- Rotate per-product Ed25519 keys and retain old public keys during migration windows.
- Export + archive `/v1/admin/export/audit.csv` regularly.
