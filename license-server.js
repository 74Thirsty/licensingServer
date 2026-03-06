import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4000;
const PRIVATE_KEY_PATH =
  process.env.LICENSE_PRIVATE_KEY_PATH ||
  path.join(process.cwd(), 'keys', 'license-private.pem');
const PUBLIC_KEY_PATH =
  process.env.LICENSE_PUBLIC_KEY_PATH ||
  path.join(process.cwd(), 'keys', 'license-public.pem');

// Simple JSON file store for licenses
const DATA_FILE = path.join(process.cwd(), 'licenses.json');

function createLicenseKey(filePath, type) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${type} key file not found at ${filePath}`);
  }

  const rawPem = fs.readFileSync(filePath, 'utf8');
  if (!rawPem || !rawPem.trim()) {
    throw new Error(`${type} key file is empty: ${filePath}`);
  }

  try {
    return type === 'private'
      ? crypto.createPrivateKey(rawPem)
      : crypto.createPublicKey(rawPem);
  } catch (err) {
    throw new Error(`Failed to parse ${type} key PEM at ${filePath}: ${err.message}`);
  }
}

let PRIVATE_KEY;
let PUBLIC_KEY;

try {
  PRIVATE_KEY = createLicenseKey(PRIVATE_KEY_PATH, 'private');
  PUBLIC_KEY = createLicenseKey(PUBLIC_KEY_PATH, 'public');
} catch (err) {
  console.error(`Fatal key configuration error: ${err.message}`);
  process.exit(1);
}

function loadLicenses() {
  if (!fs.existsSync(DATA_FILE)) return {};

  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch (err) {
    console.error(`Failed to read ${DATA_FILE}: ${err.message}`);
    return {};
  }
}

function saveLicenses(licenses) {
  const tempFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(licenses, null, 2), 'utf8');
  fs.renameSync(tempFile, DATA_FILE);
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

function fromBase64url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'bad_payload' };
  }

  if (typeof payload.productId !== 'string' || !payload.productId.trim()) {
    return { ok: false, reason: 'bad_product_id' };
  }

  if (
    !Number.isInteger(payload.expiresAt) ||
    payload.expiresAt <= 0 ||
    !Number.isFinite(payload.expiresAt)
  ) {
    return { ok: false, reason: 'bad_expiry' };
  }

  return { ok: true };
}

function signPayload(payloadObj) {
  const payloadValidation = validatePayload(payloadObj);
  if (!payloadValidation.ok) {
    throw new Error(payloadValidation.reason);
  }

  const payload = JSON.stringify(payloadObj);
  const payloadB64 = base64url(payload);
  const signature = crypto.sign('sha256', Buffer.from(payload, 'utf8'), {
    key: PRIVATE_KEY,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  const sigB64 = base64url(signature);
  return `${payloadB64}.${sigB64}`;
}

function verifyKey(key) {
  if (typeof key !== 'string') {
    return { ok: false, reason: 'bad_format' };
  }

  const parts = key.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'bad_format' };

  const [payloadB64, sigB64] = parts;
  let payloadJson;
  let signature;
  try {
    payloadJson = fromBase64url(payloadB64).toString('utf8');
    signature = fromBase64url(sigB64);
  } catch {
    return { ok: false, reason: 'bad_format' };
  }

  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }

  const payloadValidation = validatePayload(payload);
  if (!payloadValidation.ok) {
    return { ok: false, reason: payloadValidation.reason };
  }

  const isValid = crypto.verify('sha256', Buffer.from(payloadJson, 'utf8'), {
    key: PUBLIC_KEY,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  }, signature);

  if (!isValid) {
    return { ok: false, reason: 'bad_signature' };
  }

  return { ok: true, payload };
}

// --- routes ---

// Admin: create license
app.post('/admin/licenses', (req, res) => {
  const { productId, expiresAt } = req.body;
  const payload = { productId, expiresAt };
  const payloadValidation = validatePayload(payload);

  if (!payloadValidation.ok) {
    return res.status(400).json({ error: payloadValidation.reason });
  }

  let key;
  try {
    key = signPayload(payload);
  } catch (err) {
    return res.status(500).json({ error: `failed_to_sign: ${err.message}` });
  }

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
