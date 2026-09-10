import { AppError } from './errors.js';

/** Wrap an async handler so rejections reach the error middleware. */
export const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const TRUE = /^(1|true|yes|on)$/i;
const FALSE = /^(0|false|no|off)$/i;

/** Query params arrive as strings; "" means "not filtered". */
export function tri(value) {
  if (value === undefined || value === null || value === '') return null;
  if (TRUE.test(String(value))) return true;
  if (FALSE.test(String(value))) return false;
  return null;
}

export const bool = (value, fallback = false) => {
  const t = tri(value);
  return t === null ? fallback : t;
};

export const num = (value, fallback = null) => {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const int = (value, fallback = null) => {
  const n = num(value, null);
  return n === null ? fallback : Math.trunc(n);
};

/** Accept an array, a JSON array string, or a comma-separated string. */
export function list(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value;
  const s = String(value).trim();
  if (s.startsWith('[')) {
    try { const p = JSON.parse(s); if (Array.isArray(p)) return p; } catch { /* fall through */ }
  }
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

export const ids = (value) => list(value).map(Number).filter((n) => Number.isFinite(n));

export function required(body, keys) {
  const missing = keys.filter((k) => body[k] === undefined || body[k] === null || body[k] === '');
  if (missing.length) throw new AppError(400, `Missing required field(s): ${missing.join(', ')}`);
}
