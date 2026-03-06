import { LicensingClient } from '../sdk/typescript-client.js';

const client = new LicensingClient({
  baseUrl: process.env.LICENSE_SERVER || 'http://localhost:4000',
  productId: process.env.PRODUCT_ID,
  licenseKey: process.env.LICENSE_KEY,
  deviceId: process.env.DEVICE_ID || 'install-1234',
});

const activation = await client.activate();
console.log('activation', activation);

const status = await client.validate();
console.log('validate', status);

const offline = await client.offlineToken(3600);
console.log('offline', offline);
