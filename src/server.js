import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadState, saveState } from './store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..');

const PORT = Number(process.env.PORT || 4000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-admin-token-change-me';
const DEVICE_SALT = process.env.DEVICE_SALT || 'dev-device-salt-change-me';
const RATE_WINDOW_MS = 60000;
const RATE_LIMIT_IP = Number(process.env.RATE_LIMIT_IP || 60);
const RATE_LIMIT_LICENSE = Number(process.env.RATE_LIMIT_LICENSE || 30);

const state = loadState();
const rateBuckets = new Map();

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function nowIso() { return new Date().toISOString(); }
function nowSec() { return Math.floor(Date.now() / 1000); }
function hashDevice(raw) { return crypto.createHash('sha256').update(`${DEVICE_SALT}:${raw}`).digest('hex'); }
function readBody(req) { return new Promise((resolve) => { let d=''; req.on('data',(c)=>d+=c); req.on('end',()=>{try{resolve(d?JSON.parse(d):{});}catch{resolve({});}}); }); }
function authOk(req) { const a=req.headers.authorization||''; return a.startsWith('Bearer ') && a.slice(7)===ADMIN_TOKEN; }
function listActivationsForLicense(licenseId) { return Object.values(state.activations).filter((activation) => activation.license_id === licenseId); }
function activeActivationCount(licenseId) { return listActivationsForLicense(licenseId).filter((activation) => activation.status === 'active').length; }
function licenseSummary(license) {
  return {
    ...license,
    active_devices: activeActivationCount(license.id),
  };
}

function policyForProduct(product, license = null) {
  const defaults = product.policy_defaults || {};
  return {
    max_devices: license?.max_devices ?? defaults.max_devices ?? 1,
    max_seats: license?.max_seats ?? defaults.max_seats ?? null,
    offline_grace_days: defaults.offline_grace_days ?? 7,
    check_in_interval_hours: defaults.check_in_interval_hours ?? 24,
    features: license?.metadata?.features ?? defaults.features ?? {},
  };
}

function recordAudit(event_type, payload, product_id = null, license_id = null) {
  state.audit.push({ id: crypto.randomUUID(), product_id, license_id, event_type, payload, created_at: nowIso() });
  saveState(state);
}

function verifyLicense(product, license, deviceHash = null) {
  if (!product) return { valid: false, status: 'unknown_product', errorReason: 'unknown_product' };
  if (!license || license.product_id !== product.id) return { valid: false, status: 'unknown_license', errorReason: 'unknown_license' };
  if (license.status === 'revoked' || license.status === 'suspended') return { valid: false, status: license.status, errorReason: license.status };
  if (license.expires_at && Math.floor(new Date(license.expires_at).getTime() / 1000) < nowSec()) return { valid: false, status: 'expired', errorReason: 'expired' };
  const activations = Object.values(state.activations).filter((a) => a.license_id === license.id && a.status === 'active');
  const policy = policyForProduct(product, license);
  if (deviceHash && !activations.some((a) => a.device_fingerprint_hash === deviceHash) && activations.length >= policy.max_devices) return { valid: false, status: 'device_limit_reached', errorReason: 'device_limit_reached' };
  return { valid: true, status: 'active', policy };
}

function applyRateLimit(req, body) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const key = body?.license_key || 'none';
  for (const bKey of [`ip:${ip}`, `lic:${key}`]) {
    const cur = rateBuckets.get(bKey) || [];
    const cutoff = Date.now() - RATE_WINDOW_MS;
    const fresh = cur.filter((ts) => ts >= cutoff);
    fresh.push(Date.now());
    rateBuckets.set(bKey, fresh);
    const limit = bKey.startsWith('ip:') ? RATE_LIMIT_IP : RATE_LIMIT_LICENSE;
    if (fresh.length > limit) {
      state.lockouts[bKey] = { until: Date.now() + 300000, count: (state.lockouts[bKey]?.count || 0) + 1 };
      saveState(state);
      return { blocked: true, code: 429, payload: { error: 'rate_limited', retry_after_seconds: 300 } };
    }
    const lock = state.lockouts[bKey];
    if (lock && lock.until > Date.now()) return { blocked: true, code: 423, payload: { error: 'temporarily_locked', retry_after_seconds: Math.ceil((lock.until - Date.now()) / 1000) } };
  }
  return { blocked: false };
}

function signOfflineToken({ product, license, deviceHash, durationSeconds }) {
  const header = { alg: 'EdDSA', typ: 'OLT' };
  const payload = { product_id: product.id, license_id: license.id, device_fingerprint_hash: deviceHash, issued_at: nowSec(), expires_at: nowSec() + durationSeconds, status: license.status, features: policyForProduct(product, license).features };
  const msg = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const sig = crypto.sign(null, Buffer.from(msg), product.signing_private_key_pem);
  return `${msg}.${base64url(sig)}`;
}

function serveStatic(res, filepath, contentType='text/plain') {
  if (!fs.existsSync(filepath)) return json(res, 404, { error: 'not_found' });
  res.writeHead(200, { 'content-type': contentType });
  res.end(fs.readFileSync(filepath));
}

function sanitizeProduct(product) {
  if (!product) return null;
  const { signing_private_key_pem, ...safe } = product;
  return safe;
}

function activeDeviceCount(licenseId) {
  return Object.values(state.activations).filter((activation) => activation.license_id === licenseId && activation.status === 'active').length;
}

function activationWithLicense(activation) {
  const license = Object.values(state.licenses).find((entry) => entry.id === activation.license_id);
  return {
    ...activation,
    license_key: license?.license_key || null,
    product_id: license?.product_id || null,
  };
}

function serializeLicense(license) {
  const product = state.products[license.product_id];
  return {
    ...license,
    active_devices: activeDeviceCount(license.id),
    policy: product ? policyForProduct(product, license) : null,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/openapi.json') return serveStatic(res, path.join(root, 'docs', 'openapi.json'), 'application/json');
  if (req.method === 'GET' && url.pathname === '/docs/README.md') return serveStatic(res, path.join(root, 'docs', 'README.md'), 'text/markdown');
  if (req.method === 'GET' && url.pathname === '/admin') return serveStatic(res, path.join(root, 'public', 'index.html'), 'text/html');

  if (req.method === 'POST' && ['/v1/validate','/v1/activate','/v1/deactivate','/v1/offline-token'].includes(url.pathname)) {
    const body = await readBody(req);
    const rl = applyRateLimit(req, body);
    if (rl.blocked) return json(res, rl.code, rl.payload);

    if (url.pathname === '/v1/validate') {
      const { product_id, license_key, device_fingerprint, app_version } = body;
      if (!product_id || !license_key || !device_fingerprint) return json(res, 400, { error: 'missing_fields' });
      const product = state.products[product_id];
      const license = state.licenses[license_key];
      const deviceHash = hashDevice(device_fingerprint);
      const result = verifyLicense(product, license, deviceHash);
      if (result.valid) {
        const m = Object.values(state.activations).find((a)=>a.license_id===license.id && a.device_fingerprint_hash===deviceHash && a.status==='active');
        if (m) { m.last_seen_at = nowIso(); m.app_version_last = app_version || null; saveState(state); }
      }
      recordAudit('validate', { product_id, license_key, app_version, valid: result.valid, status: result.status }, product_id, license?.id || null);
      const policy = product && license ? policyForProduct(product, license) : { features: {}, max_devices: 0, check_in_interval_hours: 24 };
      return json(res, 200, { valid: result.valid, status: result.status, expires_at: license?.expires_at || null, features: policy.features, max_devices: policy.max_devices, server_time: nowIso(), next_check_seconds: policy.check_in_interval_hours * 3600, errorReason: result.errorReason || null });
    }

    if (url.pathname === '/v1/activate') {
      const { product_id, license_key, device_fingerprint, app_version } = body;
      if (!product_id || !license_key || !device_fingerprint) return json(res, 400, { error: 'missing_fields' });
      const product = state.products[product_id];
      const license = state.licenses[license_key];
      const deviceHash = hashDevice(device_fingerprint);
      const check = verifyLicense(product, license, deviceHash);
      if (!check.valid) return json(res, 200, { valid: false, status: check.status, errorReason: check.errorReason });
      let activation = Object.values(state.activations).find((a)=>a.license_id===license.id && a.device_fingerprint_hash===deviceHash);
      if (!activation) {
        activation = { id: crypto.randomUUID(), license_id: license.id, device_fingerprint_hash: deviceHash, first_seen_at: nowIso(), last_seen_at: nowIso(), status: 'active', ip_last: req.socket.remoteAddress, app_version_last: app_version || null };
        state.activations[activation.id] = activation;
      } else { activation.status='active'; activation.last_seen_at=nowIso(); }
      saveState(state);
      recordAudit('activate', { product_id, license_key, activation_id: activation.id }, product_id, license.id);
      const active_devices = Object.values(state.activations).filter((a)=>a.license_id===license.id && a.status==='active').length;
      return json(res, 200, { valid: true, status: 'active', activation_id: activation.id, active_devices, policy: policyForProduct(product, license) });
    }

    if (url.pathname === '/v1/deactivate') {
      const { product_id, license_key, device_fingerprint } = body;
      if (!product_id || !license_key || !device_fingerprint) return json(res, 400, { error: 'missing_fields' });
      const license = state.licenses[license_key];
      const d = hashDevice(device_fingerprint);
      const a = Object.values(state.activations).find((x)=>x.license_id===license?.id && x.device_fingerprint_hash===d && x.status==='active');
      if (!a) return json(res, 404, { error: 'activation_not_found' });
      a.status='revoked'; a.last_seen_at=nowIso(); saveState(state); recordAudit('deactivate',{product_id,license_key,activation_id:a.id},product_id,license.id);
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/v1/offline-token') {
      const { product_id, license_key, device_fingerprint, requested_duration_seconds } = body;
      if (!product_id || !license_key || !device_fingerprint) return json(res, 400, { error: 'missing_fields' });
      const product = state.products[product_id];
      const license = state.licenses[license_key];
      const d = hashDevice(device_fingerprint);
      const check = verifyLicense(product, license, d);
      if (!check.valid) return json(res, 200, { valid:false, status: check.status, errorReason: check.errorReason });
      const maxDur = policyForProduct(product, license).offline_grace_days * 86400;
      const duration = Math.max(60, Math.min(requested_duration_seconds || maxDur, maxDur));
      const token = signOfflineToken({ product, license, deviceHash: d, durationSeconds: duration });
      recordAudit('offline_token_issued',{product_id,license_key,duration},product_id,license.id);
      return json(res, 200, { token, algorithm: 'Ed25519', expires_in_seconds: duration, public_key: product.offline_public_key });
    }
  }

  if (url.pathname.startsWith('/v1/admin/')) {
    if (!authOk(req)) return json(res, 401, { error: 'unauthorized' });

    if (req.method === 'GET' && url.pathname === '/v1/admin/products') {
      const products = Object.values(state.products)
        .map((product) => ({
          ...sanitizeProduct(product),
          license_count: Object.values(state.licenses).filter((license) => license.product_id === product.id).length,
        }))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return json(res, 200, { products });
    }

    if (req.method === 'GET' && url.pathname === '/v1/admin/products') {
      return json(res, 200, { products: Object.values(state.products).map(sanitizeProduct) });
    }

    if (req.method === 'GET' && url.pathname === '/v1/admin/licenses') {
      let licenses = Object.values(state.licenses);
      const product_id = url.searchParams.get('product_id');
      const status = url.searchParams.get('status');
      if (product_id) licenses = licenses.filter((license) => license.product_id === product_id);
      if (status) licenses = licenses.filter((license) => license.status === status);
      return json(res, 200, { licenses: licenses.map(serializeLicense) });
    }

    if (req.method === 'GET' && url.pathname === '/v1/admin/activations') {
      let activations = Object.values(state.activations);
      const licenseRef = url.searchParams.get('license_key') || url.searchParams.get('license_id');
      const status = url.searchParams.get('status');
      if (licenseRef) {
        const license = Object.values(state.licenses).find((entry) => entry.license_key === licenseRef || entry.id === licenseRef);
        activations = license ? activations.filter((activation) => activation.license_id === license.id) : [];
      }
      if (status) activations = activations.filter((activation) => activation.status === status);
      return json(res, 200, { activations: activations.map(activationWithLicense) });
    }

    if (req.method === 'POST' && url.pathname === '/v1/admin/products') {
      const body = await readBody(req);
      if (!body.name) return json(res, 400, { error: 'name_required' });
      const id = `prd_${crypto.randomUUID()}`;
      const kp = crypto.generateKeyPairSync('ed25519');
      const product = { id, name: body.name, created_at: nowIso(), offline_public_key: kp.publicKey.export({format:'pem',type:'spki'}).toString(), signing_private_key_pem: kp.privateKey.export({format:'pem',type:'pkcs8'}).toString(), policy_defaults: { max_devices: body.policy_defaults?.max_devices ?? 1, max_seats: body.policy_defaults?.max_seats ?? null, offline_grace_days: body.policy_defaults?.offline_grace_days ?? 7, check_in_interval_hours: body.policy_defaults?.check_in_interval_hours ?? 24, trial_length_days: body.policy_defaults?.trial_length_days ?? 14, features: body.policy_defaults?.features ?? {}, privacy_mode: body.policy_defaults?.privacy_mode ?? 'fingerprint' } };
      state.products[id] = product; saveState(state); recordAudit('product_created',{id,name:product.name},id,null);
      return json(res, 201, sanitizeProduct(product));
    }

    if (req.method === 'POST' && url.pathname === '/v1/admin/licenses') {
      const body = await readBody(req);
      const product = state.products[body.product_id];
      if (!product) return json(res, 404, { error: 'product_not_found' });
      const id = `lic_${crypto.randomUUID()}`;
      const rand = crypto.randomBytes(10).toString('hex').toUpperCase();
      const license_key = `${body.product_id.slice(0,8).toUpperCase()}-${rand.match(/.{1,5}/g).join('-')}`;
      const license = { id, product_id: body.product_id, license_key, type: body.type || 'subscription', expires_at: body.expires_at || null, max_devices: body.max_devices ?? null, max_seats: body.max_seats ?? null, status: 'active', metadata: body.metadata || {}, customer: body.customer || null, created_at: nowIso() };
      state.licenses[license_key]=license; saveState(state); recordAudit('license_created',{id,product_id:body.product_id,type:license.type},body.product_id,id);
      return json(res, 201, licenseSummary(license));
    }

    if (req.method === 'GET' && url.pathname.startsWith('/v1/admin/licenses/')) {
      const id = decodeURIComponent(url.pathname.split('/')[4] || '');
      if (url.pathname.endsWith('/revoke') || url.pathname.endsWith('/reset-activations')) { /* skip */ }
      else {
        const license = Object.values(state.licenses).find((l)=>l.id===id || l.license_key===id);
        if (!license) return json(res, 404, { error: 'license_not_found' });
        const activations = Object.values(state.activations).filter((a)=>a.license_id===license.id);
        return json(res, 200, { ...serializeLicense(license), activations: activations.map(activationWithLicense) });
      }
    }

    if (req.method === 'POST' && /\/v1\/admin\/licenses\/[^/]+\/revoke$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/')[4]);
      const license = Object.values(state.licenses).find((l)=>l.id===id || l.license_key===id);
      if (!license) return json(res, 404, { error: 'license_not_found' });
      license.status='revoked'; saveState(state); recordAudit('license_revoked',{license_id:license.id},license.product_id,license.id);
      return json(res, 200, { ok:true, status:'revoked' });
    }

    if (req.method === 'POST' && /\/v1\/admin\/licenses\/[^/]+\/reset-activations$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/')[4]);
      const license = Object.values(state.licenses).find((l)=>l.id===id || l.license_key===id);
      if (!license) return json(res, 404, { error: 'license_not_found' });
      for (const a of Object.values(state.activations)) if (a.license_id===license.id) a.status='revoked';
      saveState(state); recordAudit('activations_reset',{license_id:license.id},license.product_id,license.id);
      return json(res, 200, { ok:true });
    }

    if (req.method === 'POST' && /\/v1\/admin\/activations\/[^/]+\/revoke$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/')[4]);
      const activation = state.activations[id];
      if (!activation) return json(res, 404, { error: 'activation_not_found' });
      const license = Object.values(state.licenses).find((entry) => entry.id === activation.license_id);
      activation.status = 'revoked';
      activation.last_seen_at = nowIso();
      saveState(state);
      recordAudit('activation_revoked', { activation_id: activation.id }, license?.product_id || null, license?.id || null);
      return json(res, 200, { ok: true, activation: activationWithLicense(activation) });
    }

    if (req.method === 'GET' && url.pathname === '/v1/admin/audit') {
      let events = state.audit;
      const product_id = url.searchParams.get('product_id');
      const license_id = url.searchParams.get('license_id');
      if (product_id) events = events.filter((e)=>e.product_id===product_id);
      if (license_id) events = events.filter((e)=>e.license_id===license_id);
      return json(res, 200, { events: events.sort((a, b) => b.created_at.localeCompare(a.created_at)) });
    }

    if (req.method === 'GET' && url.pathname === '/v1/admin/export/audit.csv') {
      const lines = ['id,product_id,license_id,event_type,created_at,payload'];
      for (const e of state.audit) lines.push(`${e.id},${e.product_id||''},${e.license_id||''},${e.event_type},${e.created_at},"${JSON.stringify(e.payload).replaceAll('"','""')}"`);
      res.writeHead(200, { 'content-type': 'text/csv' });
      return res.end(lines.join('\n'));
    }
  }

  return json(res, 404, { error: 'not_found' });
});

server.listen(PORT, () => {
  console.log(`Licensing API listening on http://localhost:${PORT}`);
});
