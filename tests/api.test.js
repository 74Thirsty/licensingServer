import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  fs.rmSync('test-data.json', { force: true });
  proc = spawn('node', ['src/server.js'], {
    env: { ...process.env, PORT: '4100', ADMIN_TOKEN: 'test-admin', DEVICE_SALT: 'test-salt', DATA_FILE: 'test-data.json' },
    stdio: 'ignore',
  });
  await waitForServer();

  t.after(() => {
    proc.kill('SIGTERM');
    fs.rmSync('test-data.json', { force: true });
  });

  const adminHeaders = { authorization: 'Bearer test-admin', 'content-type': 'application/json' };

  const adminUi = await fetch(`${BASE}/admin`).then((r) => r.text());
  assert.match(adminUi, /Universal Licensing Admin/);

  const p = await fetch(`${BASE}/v1/admin/products`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ name: 'AppA' }),
  }).then((r) => r.json());
  assert.ok(p.id.startsWith('prd_'));

  const productList = await fetch(`${BASE}/v1/admin/products`, {
    headers: { authorization: 'Bearer test-admin' },
  }).then((r) => r.json());
  assert.equal(productList.products.length, 1);
  assert.equal(productList.products[0].license_count, 0);

  const l = await fetch(`${BASE}/v1/admin/licenses`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ product_id: p.id, type: 'subscription', expires_at: '2030-01-01T00:00:00.000Z' }),
  }).then((r) => r.json());
  assert.ok(l.license_key);

  const a = await fetch(`${BASE}/v1/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ product_id: p.id, license_key: l.license_key, device_fingerprint: 'dev1' }),
  }).then((r) => r.json());
  assert.equal(a.valid, true);

  const licenseList = await fetch(`${BASE}/v1/admin/licenses`, {
    headers: { authorization: 'Bearer test-admin' },
  }).then((r) => r.json());
  assert.equal(licenseList.licenses.length, 1);
  assert.equal(licenseList.licenses[0].active_devices, 1);

  const detail = await fetch(`${BASE}/v1/admin/licenses/${encodeURIComponent(l.license_key)}`, {
    headers: { authorization: 'Bearer test-admin' },
  }).then((r) => r.json());
  assert.equal(detail.activations.length, 1);
  assert.equal(detail.activations[0].status, 'active');

  const revokeActivation = await fetch(`${BASE}/v1/admin/activations/${detail.activations[0].id}/revoke`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-admin' },
  }).then((r) => r.json());
  assert.equal(revokeActivation.ok, true);

  const v = await fetch(`${BASE}/v1/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ product_id: p.id, license_key: l.license_key, device_fingerprint: 'dev1' }),
  }).then((r) => r.json());
  assert.equal(v.valid, true);

  const token = await fetch(`${BASE}/v1/offline-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ product_id: p.id, license_key: l.license_key, device_fingerprint: 'dev1', requested_duration_seconds: 3600 }),
  }).then((r) => r.json());
  assert.equal(token.algorithm, 'Ed25519');

  const audit = await fetch(`${BASE}/v1/admin/audit`, {
    headers: { authorization: 'Bearer test-admin' },
  }).then((r) => r.json());
  assert.ok(audit.events.some((event) => event.event_type === 'activation_revoked'));
});
