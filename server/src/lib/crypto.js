/**
 * Secrets at rest. Etsy refresh tokens and third-party API keys live in the
 * local SQLite file, so they are sealed with AES-256-GCM under a key kept in
 * data/master.key (0600). Losing that file only means re-entering credentials.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let cachedKey = null;

function masterKey(dataDir) {
  if (cachedKey) return cachedKey;
  const keyPath = path.join(dataDir, 'master.key');
  if (fs.existsSync(keyPath)) {
    cachedKey = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'hex');
  } else {
    cachedKey = crypto.randomBytes(32);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(keyPath, cachedKey.toString('hex'), { mode: 0o600 });
  }
  if (cachedKey.length !== 32) throw new Error('master.key must be 32 bytes of hex');
  return cachedKey;
}

export function seal(plaintext, dataDir) {
  if (plaintext == null || plaintext === '') return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKey(dataDir), iv);
  const enc = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}

export function open(sealed, dataDir) {
  if (!sealed) return '';
  const [v, iv, tag, data] = String(sealed).split('.');
  if (v !== 'v1') return '';
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', masterKey(dataDir), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return ''; // wrong/rotated master key -- treat as "no credential stored"
  }
}

/** Show enough of a credential to recognise it, never enough to use it. */
export const maskSecret = (s) =>
  !s ? '' : s.length <= 8 ? '••••' : `${s.slice(0, 4)}${'•'.repeat(Math.min(16, s.length - 8))}${s.slice(-4)}`;

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
