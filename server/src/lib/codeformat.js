/**
 * The pure parts of order codes (26-0710-01), kept free of the database so the
 * migration that runs while the database is still starting can use them too.
 */

// Matches the codes already in these sheets: 26-0316-25, 25-1216-01,
// 26-0105-40. Those are year-month-day; read as day-month the first would be
// month 16, which cannot happen.
export const DEFAULT_TEMPLATE = '{YY}-{MM}{DD}-{NN}';

/** Where "today" is decided for a new code. Everything else in the app is UTC; a code stamped with the wrong day for a few hours a night would look like a bug. */
export const DEFAULT_TIMEZONE = 'Europe/Istanbul';

const pad = (n, width) => String(n).padStart(width, '0');

/**
 * Fill the template for a given day and sequence number.
 *   {YY} {YYYY} two/four digit year   {DD} day   {MM} month   {NN} the
 *   number within its day (01, 02, ...), width set by how many Ns.
 */
export function formatCode(day, seq, pattern = DEFAULT_TEMPLATE) {
  const [y, m, d] = String(day).slice(0, 10).split('-');
  return pattern
    .replace(/\{YYYY\}/g, y)
    .replace(/\{YY\}/g, y.slice(2))
    .replace(/\{MM\}/g, m)
    .replace(/\{DD\}/g, d)
    .replace(/\{N+\}/g, (match) => pad(seq, match.length - 2));
}

/** Today's date (YYYY-MM-DD) on the calendar of the given IANA time zone; UTC when the zone is not one. */
export function todayInZone(timeZone = DEFAULT_TIMEZONE, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}
