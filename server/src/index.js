import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import config, { ROOT } from './config.js';
import { initDb } from './db/index.js';
import { createLogger } from './lib/logger.js';
import { AppError } from './lib/errors.js';
import { OPERATION_COUNT } from './etsy/operations.generated.js';

import authRoutes from './routes/auth.js';
import settingsRoutes from './routes/settings.js';
import dashboardRoutes from './routes/dashboard.js';
import listingRoutes from './routes/listings.js';
import skuRoutes from './routes/skus.js';
import orderRoutes from './routes/orders.js';
import trackingRoutes from './routes/tracking.js';
import aiRoutes from './routes/ai.js';
import bulkRoutes from './routes/bulk.js';
import researchRoutes from './routes/research.js';
import shopRoutes from './routes/shop.js';
import financeRoutes from './routes/finance.js';
import exportRoutes from './routes/exports.js';
import etsyRoutes from './routes/etsy.js';

import { startScheduler } from './scheduler.js';
import { openBrowser, shouldOpenBrowser } from './lib/open-browser.js';
import http from 'node:http';

const log = createLogger('server');
const app = express();

app.disable('x-powered-by');
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(cookieParser());

// Concise request log; skips the noisy polling endpoints.
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api') && !/\/(dashboard|counters|summary)$/.test(req.path)) {
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
      log[level](`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });
  next();
});

/** Optional shared password when the app is exposed beyond loopback. */
if (config.security.appPassword) {
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth/callback') || req.path === '/health') return next();
    const supplied = req.get('x-app-password') || req.cookies?.app_password;
    if (supplied === config.security.appPassword) return next();
    res.status(401).json({ error: 'App password required' });
  });
  app.post('/api/login', (req, res) => {
    if (req.body?.password !== config.security.appPassword) return res.status(401).json({ error: 'Wrong password' });
    res.cookie('app_password', req.body.password, { httpOnly: true, sameSite: 'lax', maxAge: config.security.sessionTtlHours * 3600_000 });
    res.json({ ok: true });
  });
}

app.get('/api/health', (req, res) => res.json({
  ok: true, version: '1.0.0', env: config.env, operations: OPERATION_COUNT, uptime: Math.round(process.uptime()),
}));

app.use('/api/auth', authRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/listings', listingRoutes);
app.use('/api/skus', skuRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/tracking', trackingRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/bulk', bulkRoutes);
app.use('/api/research', researchRoutes);
app.use('/api/shop', shopRoutes);
app.use('/api/finance', financeRoutes);
app.use('/api/exports', exportRoutes);
app.use('/api/etsy', etsyRoutes);

// Serve the built frontend when it exists, so `npm start` runs the whole app.
const webDist = path.join(ROOT, 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  // Client-side routes fall through to the SPA. The lookahead must be anchored
  // to /api/ (or exactly /api) so a page route like /api-explorer still works.
  app.get(/^(?!\/api(?:\/|$)).*/, (req, res) => res.sendFile(path.join(webDist, 'index.html')));
} else {
  app.get('/', (req, res) => res.status(200).send(
    '<h1>Etsy Command Center API</h1><p>The web build is missing. Run <code>npm run build</code>, or use <code>npm run dev</code> for the dev server.</p>',
  ));
}

app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }));

// Central error translation: Etsy failures keep their upstream body.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err instanceof AppError ? err.status : err.status ?? 500;
  if (status >= 500) log.error(`${req.method} ${req.path}: ${err.message}`, err.stack?.split('\n')[1]?.trim());
  else log.warn(`${req.method} ${req.path}: ${err.message}`);
  res.status(status).json({
    error: err.message,
    ...(err.details ? { details: err.details } : {}),
    ...(err.operationId ? { operationId: err.operationId } : {}),
    ...(err.body ? { etsy: err.body } : {}),
  });
});

await initDb();

// The URL shown to the user, and the one registered with Etsy, uses a
// hostname ("localhost") because Etsy's app dashboard rejects an IP-literal
// redirect URI outright ("IP addresses are not allowed"). But which loopback
// address "localhost" actually resolves to varies by OS -- some Windows
// configurations prefer the IPv6 ::1 -- so if the server only bound the IPv4
// address a user could get ERR_CONNECTION_REFUSED depending on their machine.
// When the bind host is the untouched default, listen on both loopback
// addresses; a custom HOST (LAN exposure, a container, etc.) is honoured as a
// single explicit bind instead.
const url = `http://${config.publicHost}:${config.port}`;
const usingDefaultHost = config.host === '127.0.0.1' && !process.env.HOST;

const primary = http.createServer(app);
const servers = [primary];

function announceReady() {
  log.info(`Etsy Command Center on ${url}`);
  log.info(`${OPERATION_COUNT} Etsy operations available | data: ${config.dataDir}`);
  startScheduler();

  // Only now is at least one bind actually accepting connections, so this is
  // the earliest moment a browser will get a page instead of a refusal.
  if (shouldOpenBrowser()) {
    log.info('opening your browser...');
    openBrowser(url);
  }
  process.stdout.write(
    `\n  Ready. Open  ${url}\n`
    + '  Keep this window open while you use the app.\n\n',
  );
}

let announced = false;
primary.listen(config.port, config.host, () => {
  if (!announced) { announced = true; announceReady(); }
});

primary.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`Port ${config.port} is already in use.`);
    process.stdout.write(
      `\n  Something else is using port ${config.port}.\n`
      + `  The app may already be running - try opening ${url} first.\n`
      + '  Otherwise start it on another port:  PORT=4400 npm start\n\n',
    );
    process.exit(1);
  } else {
    log.error(`Server could not start on ${config.host}: ${err.message}`);
    process.exit(1);
  }
});

if (usingDefaultHost) {
  const secondary = http.createServer(app);
  servers.push(secondary);
  secondary.listen(config.port, '::1', () => {
    if (!announced) { announced = true; announceReady(); }
  });
  // IPv6 loopback can be unavailable (disabled stack, some containers) --
  // that is not an error worth stopping for, since the primary IPv4 bind
  // still serves "localhost" wherever it resolves to 127.0.0.1.
  secondary.on('error', (err) => {
    log.debug(`IPv6 loopback bind skipped: ${err.message}`);
  });
}

const shutdown = (signal) => {
  log.info(`${signal} received, shutting down`);
  Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))).then(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
