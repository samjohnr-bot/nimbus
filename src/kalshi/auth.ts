import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('auth');

let privateKey: crypto.KeyObject | null = null;

export function getAuthDiagnostics(): { hasEnvKey: boolean; keyLength: number; keyStart: string; pemValid: boolean; error?: string } {
  const raw = config.kalshi.privateKey;
  const diag = {
    hasEnvKey: !!raw,
    keyLength: raw ? raw.length : 0,
    keyStart: raw ? raw.substring(0, 20) + '...' : '(none)',
    pemValid: false,
    error: undefined as string | undefined,
  };

  if (!raw) {
    diag.error = 'No KALSHI_PRIVATE_KEY env var set';
    return diag;
  }

  try {
    const pem = normalizePem(raw);
    crypto.createPrivateKey(pem);
    diag.pemValid = true;
  } catch (e) {
    diag.error = String(e);
  }

  return diag;
}

function normalizePem(raw: string): string {
  // Case 1: Already valid PEM with real newlines
  if (raw.includes('-----BEGIN') && raw.includes('\n')) {
    return raw.trim();
  }

  // Case 2: PEM with literal \n escape sequences (common in env vars)
  if (raw.includes('-----BEGIN') && raw.includes('\\n')) {
    return raw.replace(/\\n/g, '\n').trim();
  }

  // Case 3: PEM all on one line (no newlines at all)
  if (raw.includes('-----BEGIN')) {
    // Extract the base64 body between header and footer
    const match = raw.match(/-----BEGIN [^-]+-----(.*?)-----END [^-]+-----/s);
    if (match) {
      const header = raw.match(/-----BEGIN [^-]+-----/)![0];
      const footer = raw.match(/-----END [^-]+-----/)![0];
      const body = match[1].replace(/\s/g, '');
      // Re-wrap at 64 chars
      const wrapped = body.match(/.{1,64}/g)!.join('\n');
      return `${header}\n${wrapped}\n${footer}`;
    }
    return raw.trim();
  }

  // Case 4: Base64-encoded PEM
  const decoded = Buffer.from(raw, 'base64').toString('utf-8');
  if (decoded.includes('-----BEGIN')) {
    return decoded.replace(/\\n/g, '\n').trim();
  }

  // Case 5: Raw base64 DER — wrap it as PKCS8
  return `-----BEGIN PRIVATE KEY-----\n${raw.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----`;
}

function getPrivateKey(): crypto.KeyObject {
  if (!privateKey) {
    let pem: string;

    if (config.kalshi.privateKey) {
      pem = normalizePem(config.kalshi.privateKey);
      log.info({ pemStart: pem.substring(0, 40), pemLength: pem.length }, 'Loaded private key from env var');
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
