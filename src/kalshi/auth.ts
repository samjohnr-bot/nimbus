import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('auth');

let privateKey: crypto.KeyObject | null = null;

function getPrivateKey(): crypto.KeyObject {
  if (!privateKey) {
    let pem: string;

    if (config.kalshi.privateKey) {
      const raw = config.kalshi.privateKey;

      if (raw.includes('-----BEGIN')) {
        // Already PEM format (pasted directly into env var)
        pem = raw;
      } else {
        // Base64-encoded PEM
        pem = Buffer.from(raw, 'base64').toString('utf-8');
      }

      // Ensure proper line endings
      pem = pem.replace(/\\n/g, '\n').trim();

      log.debug({ pemStart: pem.substring(0, 30) }, 'Loaded private key from env var');
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
