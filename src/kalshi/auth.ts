import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from '../config.js';

let privateKey: crypto.KeyObject | null = null;

function getPrivateKey(): crypto.KeyObject {
  if (!privateKey) {
    let pem: string;

    if (config.kalshi.privateKey) {
      // Base64-encoded PEM from env var (for cloud deployment)
      pem = Buffer.from(config.kalshi.privateKey, 'base64').toString('utf-8');
    } else {
      // PEM file on disk (for local development)
      pem = fs.readFileSync(config.kalshi.privateKeyPath, 'utf-8');
    }

    privateKey = crypto.createPrivateKey(pem);
  }
  return privateKey;
}

export function signRequest(method: string, path: string): {
  'KALSHI-ACCESS-KEY': string;
  'KALSHI-ACCESS-TIMESTAMP': string;
  'KALSHI-ACCESS-SIGNATURE': string;
} {
  const timestamp = Date.now().toString();
  const pathWithoutQuery = path.split('?')[0];
  const message = `${timestamp}${method.toUpperCase()}${pathWithoutQuery}`;

  const key = getPrivateKey();
  const signature = crypto.sign('sha256', Buffer.from(message), {
    key,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });

  return {
    'KALSHI-ACCESS-KEY': config.kalshi.apiKey,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
  };
}
