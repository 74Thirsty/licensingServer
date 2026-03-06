import crypto from 'crypto';

export class LicensingClient {
  constructor({ baseUrl, productId, licenseKey, deviceId }) {
    this.baseUrl = baseUrl;
    this.productId = productId;
    this.licenseKey = licenseKey;
    this.deviceId = deviceId;
    this.cache = null;
  }

  async activate() {
    return this.#call('/v1/activate', {
      product_id: this.productId,
      license_key: this.licenseKey,
      device_fingerprint: this.deviceId,
    });
  }

  async validate() {
    const res = await this.#call('/v1/validate', {
      product_id: this.productId,
      license_key: this.licenseKey,
      device_fingerprint: this.deviceId,
      app_version: '1.0.0',
    });
    if (res.valid) {
      this.cache = {
        ...res,
        nextCheckAt: Date.now() + res.next_check_seconds * 1000,
      };
    }
    return {
      isValid: !!res.valid,
      status: res.status,
      expiresAt: res.expires_at,
      features: res.features || {},
      nextCheckAt: this.cache?.nextCheckAt || null,
      errorReason: res.errorReason || null,
    };
  }

  async offlineToken(requestedDurationSeconds = 3600) {
    return this.#call('/v1/offline-token', {
      product_id: this.productId,
      license_key: this.licenseKey,
      device_fingerprint: this.deviceId,
      requested_duration_seconds: requestedDurationSeconds,
    });
  }

  verifyOfflineToken(token, publicKeyPem) {
    const [h, p, s] = token.split('.');
    const msg = `${h}.${p}`;
    const sig = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const ok = crypto.verify(null, Buffer.from(msg), publicKeyPem, sig);
    if (!ok) return { valid: false, reason: 'bad_signature' };
    const payload = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (payload.product_id !== this.productId) return { valid: false, reason: 'wrong_product' };
    if (payload.device_fingerprint_hash !== crypto.createHash('sha256').update(`${process.env.DEVICE_SALT || 'dev-device-salt-change-me'}:${this.deviceId}`).digest('hex')) {
      return { valid: false, reason: 'wrong_device' };
    }
    if (payload.expires_at < Math.floor(Date.now() / 1000)) return { valid: false, reason: 'expired' };
    return { valid: true, payload };
  }

  async #call(path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }
}
