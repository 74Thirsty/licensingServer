# licensingServer

Simple license issuing/validation service.

## Key requirements

This server now signs licenses with an RSA private key and verifies them with the matching RSA public key.
Both PEM files are required at boot.

- `LICENSE_PRIVATE_KEY_PATH` (default: `./keys/license-private.pem`)
- `LICENSE_PUBLIC_KEY_PATH` (default: `./keys/license-public.pem`)

If either key is missing/invalid, the server exits with a fatal configuration error.

## Generate test keys

```bash
mkdir -p keys
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out keys/license-private.pem
openssl rsa -pubout -in keys/license-private.pem -out keys/license-public.pem
```
