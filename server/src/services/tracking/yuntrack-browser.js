/**
 * YunTrack via a real browser.
 *
 * Loads the same page the operator would open by hand —
 * https://www.yuntrack.com/parcelTracking?id=<code> — and reads the tracking
 * data the page fetches for itself. Because it is a genuine browser session it
 * carries normal headers and cookies, so it gets through the WAF that rejects
 * direct server-side calls from some networks.
 *
 * Playwright is an optional dependency: this provider reports a clear setup
 * message rather than crashing when it is not installed.
 *
 *   npm install playwright && npx playwright install chromium
 */
import { STATUS } from './status.js';
import { normalise, API_ROOT } from './yuntrack.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('yuntrack-browser');
const PAGE_URL = 'https://www.yuntrack.com/parcelTracking?id=';

let chromiumPromise = null;

async function loadChromium() {
  if (!chromiumPromise) {
    chromiumPromise = (async () => {
      for (const mod of ['playwright', 'playwright-core']) {
        try { return (await import(mod)).chromium; } catch { /* try the next */ }
      }
      throw new Error(
        'The browser tracking provider needs Playwright. Install it with:\n'
        + '  npm install playwright && npx playwright install chromium\n'
        + 'Or set tracking.provider back to "yuntrack" / "seventeentrack" / "manual".',
      );
    })();
  }
  return chromiumPromise;
}

/**
 * One browser, reused across a sync run, one page per parcel.
 * The page's own XHR to /Track/Query is intercepted, so the data comes back in
 * the documented JSON shape rather than being scraped out of the DOM.
 */
export async function fetchTracking(codes, { timeoutMs = 45_000, headless = true, executablePath } = {}) {
  const chromium = await loadChromium();

  const browser = await chromium.launch({
    headless,
    ...(executablePath || process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: executablePath || process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {}),
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const results = [];
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });

    for (const code of codes) {
      const page = await context.newPage();
      let payload = null;

      page.on('response', async (res) => {
        if (!res.url().startsWith(`${API_ROOT}/Track/Query`)) return;
        try {
          const json = await res.json();
          if (json?.ResultList?.length) payload = json;
        } catch { /* not the JSON we want */ }
      });

      try {
        await page.goto(`${PAGE_URL}${encodeURIComponent(code)}`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        // Wait for the page's own query to land rather than a fixed sleep.
        const deadline = Date.now() + timeoutMs;
        while (!payload && Date.now() < deadline) await page.waitForTimeout(400);

        if (payload) {
          const entry = payload.ResultList[0];
          results.push(normalise(entry, code));
        } else {
          // A captcha challenge is the usual reason nothing arrived.
          const text = await page.locator('body').innerText().catch(() => '');
          const captcha = /captcha|verify|slide|拖动|验证/i.test(text);
          results.push({
            code,
            status: STATUS.NOT_FOUND,
            events: [],
            statusDetail: captcha
              ? 'YunTrack showed a captcha. Run with tracking.browser_headless = false once to solve it, or set the status by hand.'
              : 'The YunTrack page loaded but returned no tracking record.',
            raw: null,
          });
        }
      } catch (err) {
        log.warn(`${code}: ${err.message}`);
        results.push({ code, status: STATUS.NOT_FOUND, events: [], statusDetail: `Browser lookup failed: ${err.message}`, raw: null });
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return results;
}
