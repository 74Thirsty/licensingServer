import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4000;
const LICENSE_SECRET = process.env.LICENSE_SECRET || 'change-me-in-prod';

// Simple JSON file store for licenses
const DATA_FILE = path.join(process.cwd(), 'licenses.json');

function loadLicenses() {
  if (!fs.existsSync(DATA_FILE)) return {};
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveLicenses(licenses) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(licenses, null, 2), 'utf8');
}

let licenses = loadLicenses();

// --- helpers ---

function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signPayload(payloadObj) {
  const payload = JSON.stringify(payloadObj);
  const payloadB64 = base64url(payload);
  const hmac = crypto
    .createHmac('sha256', LICENSE_SECRET)
    .update(payload)
    .digest();
  const sigB64 = base64url(hmac);
  return `${payloadB64}.${sigB64}`;
}

function verifyKey(key) {
  const parts = key.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'bad_format' };

  const [payloadB64, sigB64] = parts;
  const payloadJson = Buffer.from(
    payloadB64.replace(/-/g, '+').replace(/_/g, '/'),
    'base64'
  ).toString('utf8');

  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }

  const expectedSig = crypto
    .createHmac('sha256', LICENSE_SECRET)
    .update(payloadJson)
    .digest();
  const expectedSigB64 = base64url(expectedSig);

  if (!crypto.timingSafeEqual(Buffer.from(sigB64), Buffer.from(expectedSigB64))) {
    return { ok: false, reason: 'bad_signature' };
  }

  return { ok: true, payload };
}

// --- routes ---

// Admin: create license
app.post('/admin/licenses', (req, res) => {
  const { productId, expiresAt } = req.body;

  if (!productId || !expiresAt) {
    return res.status(400).json({ error: 'productId and expiresAt required' });
  }

  const payload = { productId, expiresAt };
  const key = signPayload(payload);

  licenses[key] = {
    key,
    productId,
    expiresAt,
    revoked: false,
  };
  saveLicenses(licenses);

  res.json({ key, productId, expiresAt });
});

// Admin: revoke license
app.post('/admin/licenses/revoke', (req, res) => {
  const { key } = req.body;
  if (!key || !licenses[key]) {
    return res.status(404).json({ error: 'license_not_found' });
  }
  licenses[key].revoked = true;
  saveLicenses(licenses);
  res.json({ ok: true });
});

// Client: validate license
app.post('/licenses/validate', (req, res) => {
  const { key, productId } = req.body;
  if (!key || !productId) {
    return res.status(400).json({ valid: false, reason: 'missing_fields' });
  }

  const verified = verifyKey(key);
  if (!verified.ok) {
    return res.status(200).json({ valid: false, reason: verified.reason });
  }

  const { payload } = verified;
  if (payload.productId !== productId) {
    return res.status(200).json({ valid: false, reason: 'wrong_product' });
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.expiresAt && payload.expiresAt < now) {
    return res.status(200).json({ valid: false, reason: 'expired' });
  }

  const stored = licenses[key];
  if (!stored) {
    return res.status(200).json({ valid: false, reason: 'unknown_key' });
  }
  if (stored.revoked) {
    return res.status(200).json({ valid: false, reason: 'revoked' });
  }

  res.status(200).json({
    valid: true,
    productId: payload.productId,
    expiresAt: payload.expiresAt,
  });
});

app.listen(PORT, () => {
  console.log(`License server listening on http://localhost:${PORT}`);
});
