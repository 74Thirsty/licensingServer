# Universal Licensing Server

Multi-product licensing API with activation, validation, offline Ed25519 tokens, admin endpoints, audit logging, rate limiting, and a reference client SDK.

## Run
```bash
npm install
npm start
```

There is no external vendor API key required to boot this repo. The only required secret is the local `ADMIN_TOKEN` used for `/v1/admin/*` and the `/admin` UI. If you generated `.env` with `./scripts/setup.sh`, `npm start` now loads it automatically.

Default local runtime values:
- `PORT=4000`
- `ADMIN_TOKEN=dev-admin-token-change-me`
- `DEVICE_SALT=dev-device-salt-change-me`
- `DATA_FILE=./data.json`

Endpoints:
- API: `http://localhost:4000`
- Admin UI: `http://localhost:4000/admin`
- Docs: `http://localhost:4000/docs/README.md`
- OpenAPI: `http://localhost:4000/openapi.json`

Full setup guide: [SETUP.md](./SETUP.md)

## Environment
Use strong values outside local dev.

- `PORT`: listen port.
- `ADMIN_TOKEN`: bearer token for `/v1/admin/*`.
- `DEVICE_SALT`: salt applied before hashing `device_fingerprint`.
- `DATA_FILE`: optional path for persisted JSON state.

Example:

```bash
export ADMIN_TOKEN=$(openssl rand -hex 32)
export DEVICE_SALT=$(openssl rand -hex 32)
export PORT=4000
npm start
```

## Complete setup walkthrough
Run the setup wizard from repo root:

```bash
./scripts/setup.sh
```

What it does:
- Verifies required tooling (`node`, `npm`, `curl`).
- Creates `package.json` if missing.
- Installs npm dependencies.
- Creates `.env` with `PORT`, `ADMIN_TOKEN`, and `DEVICE_SALT` if missing.
- Optionally runs a full API smoke test against the current `/v1/*` surface using a temporary server process.

After setup:

```bash
npm start
```

If you want the setup script to leave the backend running, use:

```bash
./scripts/setup.sh --start
```

Setup script flags:
- `--smoke-test`: force the smoke test.
- `--skip-smoke-test`: skip the smoke test.
- `--start`: start the backend after setup finishes.
