import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');

dotenv.config({ path: path.join(ROOT, '.env') });

const int = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
const bool = (v, d) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 4317),
  host: process.env.HOST || '127.0.0.1',

  dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
  get dbFile() { return process.env.DB_FILE || path.join(this.dataDir, 'etsy-command-center.db'); },
  get uploadDir() { return process.env.UPLOAD_DIR || path.join(this.dataDir, 'uploads'); },
  get exportDir() { return process.env.EXPORT_DIR || path.join(this.dataDir, 'exports'); },

  etsy: {
    base: process.env.ETSY_API_BASE || 'https://openapi.etsy.com',
    connectUrl: 'https://www.etsy.com/oauth/connect',
    tokenUrl: 'https://api.etsy.com/v3/public/oauth/token',
    keystring: process.env.ETSY_KEYSTRING || '',
    sharedSecret: process.env.ETSY_SHARED_SECRET || '',
    redirectUri: process.env.ETSY_REDIRECT_URI || '',
    // Etsy's published ceiling is 10 req/s and 10k/day per app.
    maxRequestsPerSecond: int(process.env.ETSY_MAX_RPS, 8),
    maxRetries: int(process.env.ETSY_MAX_RETRIES, 4),
  },

  ai: {
    defaultProvider: process.env.AI_PROVIDER || 'manus',
    manus: {
      base: process.env.MANUS_API_BASE || 'https://api.manus.ai',
      apiKey: process.env.MANUS_API_KEY || '',
      agentProfile: process.env.MANUS_AGENT_PROFILE || 'manus-1.6',
      pollIntervalMs: int(process.env.MANUS_POLL_MS, 4000),
      timeoutMs: int(process.env.MANUS_TIMEOUT_MS, 900_000),
    },
    anthropic: {
      base: process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com',
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
      version: '2023-06-01',
    },
    openai: {
      base: process.env.OPENAI_API_BASE || 'https://api.openai.com',
      apiKey: process.env.OPENAI_API_KEY || '',
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      imageModel: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
    },
  },

  tracking: {
    provider: process.env.TRACKING_PROVIDER || 'yuntrack',
    // Every tracking number is deep-linked here, per the shop's workflow.
    publicUrlTemplate: process.env.TRACKING_URL_TEMPLATE || 'https://www.yuntrack.com/parcelTracking?id={code}',
    yuntrackApi: process.env.YUNTRACK_API || 'https://services.yuntrack.com/Track/Query',
    seventeentrackKey: process.env.SEVENTEENTRACK_KEY || '',
    // "No movement for N days" raises the stale alert the shop runs on.
    staleAfterDays: int(process.env.TRACKING_STALE_DAYS, 4),
    autoSyncMinutes: int(process.env.TRACKING_SYNC_MINUTES, 180),
  },

  pricing: {
    // "Non-discount price" vs the sale price the shop advertises.
    discountPercent: int(process.env.DISCOUNT_PERCENT, 30),
  },

  security: {
    // Local-first tool: bind to loopback. Set an app password to expose it.
    appPassword: process.env.APP_PASSWORD || '',
    sessionTtlHours: int(process.env.SESSION_TTL_HOURS, 720),
  },

  features: {
    autoSyncOnStart: bool(process.env.AUTO_SYNC_ON_START, false),
  },
};

for (const dir of [config.dataDir, config.uploadDir, config.exportDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

export default config;
