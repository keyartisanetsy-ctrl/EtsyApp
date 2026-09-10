const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL || 'info'] ?? 20;
const COLOR = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';

function emit(level, scope, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString().slice(11, 23);
  const tail = extra === undefined ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${tail}`;
  process.stdout.write(`${COLOR[level]}${line}${RESET}\n`);
}

export const createLogger = (scope) => ({
  debug: (m, e) => emit('debug', scope, m, e),
  info: (m, e) => emit('info', scope, m, e),
  warn: (m, e) => emit('warn', scope, m, e),
  error: (m, e) => emit('error', scope, m, e),
});

export const logger = createLogger('app');
