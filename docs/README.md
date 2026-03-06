# Universal Licensing Server Docs

## 1) Overview
- **Product**: app scope + per-product keypair + policy defaults.
- **License**: entitlement linked to product.
- **Activation**: license-to-device binding entry.
- **Offline token**: Ed25519-signed assertion for no-network mode.
- **Policies**: max devices, check-in interval, offline grace, features.

## 2) Quickstart (Local)
```bash
npm install
ADMIN_TOKEN=dev-admin-token-change-me DEVICE_SALT=dev-device-salt-change-me npm start
```

Create product:
```bash
curl -s -X POST http://localhost:4000/v1/admin/products \
  -H 'authorization: Bearer dev-admin-token-change-me' \
  -H 'content-type: application/json' \
  -d '{"name":"MyApp","policy_defaults":{"max_devices":2,"offline_grace_days":7,"check_in_interval_hours":24,"features":{"pro":true}}}'
```

Create license:
```bash
curl -s -X POST http://localhost:4000/v1/admin/licenses \
  -H 'authorization: Bearer dev-admin-token-change-me' \
  -H 'content-type: application/json' \
  -d '{"product_id":"<PRODUCT_ID>","type":"subscription","expires_at":"2030-01-01T00:00:00.000Z"}'
```

Activate + validate:
```bash
curl -s -X POST http://localhost:4000/v1/activate -H 'content-type: application/json' -d '{"product_id":"<PRODUCT_ID>","license_key":"<LICENSE_KEY>","device_fingerprint":"devbox-1"}'
curl -s -X POST http://localhost:4000/v1/validate -H 'content-type: application/json' -d '{"product_id":"<PRODUCT_ID>","license_key":"<LICENSE_KEY>","device_fingerprint":"devbox-1","app_version":"1.0.0"}'
```

## 3) Production Setup
- Run behind TLS reverse proxy (nginx/caddy).
- Set strong `ADMIN_TOKEN`, `DEVICE_SALT`.
- Replace JSON file storage with Postgres adapter (schema is represented in persisted entities).
- Run multiple API replicas with shared DB/redis for rate-limit counters.

## 4) Security
- Ed25519 per-product signing keys generated server-side.
- Private keys never returned from API.
- Device identifiers are salted SHA-256 only.
- Admin API guarded by bearer token.
- Rate limiting + temporary lockouts per IP and per license key.

### Key Rotation
1. Create new product keypair.
2. Re-issue offline tokens with new key.
3. Keep old public key accepted during transition window.

## 5) Client Integration
- Use `sdk/typescript-client.js`.
- First run: call `/v1/activate`.
- Launch: call `/v1/validate` on check-in boundary.
- Offline: cache `/v1/offline-token`, verify with product public key.

## 6) API Reference
- OpenAPI: `/openapi.json` or `docs/openapi.json`.
- Admin UI: `/admin`.
- Docs endpoint: `/docs/README.md`.

## 7) Troubleshooting
- `device_limit_reached`: revoke or reset activations.
- `temporarily_locked`: rate-limit bucket triggered; wait lockout or admin override (remove lock from state).
- Clock drift: client should tolerate small skew and rely on `server_time`.

## 8) Testing
```bash
npm test
```

## 9) Operations
- Backup `data.json` and audit export `/v1/admin/export/audit.csv`.
- Review `rate_limited`, `activate_failed` events for abuse.
- Alert on surge in `validate` volume and lockouts.
