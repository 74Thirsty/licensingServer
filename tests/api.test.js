import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const BASE = 'http://localhost:4100';
let proc;

async function waitForServer() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server_not_ready');
}

test('licensing flow', async (t) => {
  proc = spawn('node', ['src/server.js'], {
    env: { ...process.env, PORT: '4100', ADMIN_TOKEN: 'test-admin', DEVICE_SALT: 'test-salt', DATA_FILE: 'test-data.json' },
    stdio: 'ignore',
  });
  await waitForServer();

  t.after(() => {
    proc.kill('SIGTERM');
  });

  const p = await fetch(`${BASE}/v1/admin/products`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-admin', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'AppA' }),
  }).then((r) => r.json());
  assert.ok(p.id.startsWith('prd_'));

  const l = await fetch(`${BASE}/v1/admin/licenses`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-admin', 'content-type': 'application/json' },
    body: JSON.stringify({ product_id: p.id, type: 'subscription', expires_at: '2030-01-01T00:00:00.000Z' }),
  }).then((r) => r.json());
  assert.ok(l.license_key);

  const a = await fetch(`${BASE}/v1/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ product_id: p.id, license_key: l.license_key, device_fingerprint: 'dev1' }),
  }).then((r) => r.json());
  assert.equal(a.valid, true);

  const v = await fetch(`${BASE}/v1/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ product_id: p.id, license_key: l.license_key, device_fingerprint: 'dev1' }),
  }).then((r) => r.json());
  assert.equal(v.valid, true);
});
