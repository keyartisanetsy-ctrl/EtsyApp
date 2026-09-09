/**
 * Reading a shipping address before it becomes a lost parcel.
 *
 * A wrong address costs more than anything else on the order desk: the parcel
 * ships, travels for three weeks, comes back, and the refund and the postage
 * both come out of your pocket. Most of them are obvious in hindsight - a ZIP
 * that belongs to a different state, a street number missing, an apartment
 * written where the city goes, a country that does not match the post code
 * format.
 *
 * Two passes, deliberately in this order:
 *
 *   1. Rules that are certain. A US ZIP is five digits; a UK post code has a
 *      shape; a German PLZ is five digits. These cost nothing, run offline, and
 *      are never wrong about the thing they check.
 *   2. The AI, for the things rules cannot see - a street that does not exist
 *      in that city, a city misspelled, a flat number in the wrong field.
 *
 * The AI never rewrites the address by itself. It proposes, and you accept. An
 * address silently "corrected" to something wrong is worse than the original,
 * because nobody looks at it again.
 */
import { getDb, audit } from '../db/index.js';
import { activeShopId } from '../etsy/shop.js';
import { readSetting } from './settings.js';
import { badRequest, notFound } from '../lib/errors.js';
import { run, parseJsonish } from './ai/index.js';

/** Post code shapes we can check without asking anyone. */
const POSTCODE_RULES = {
  US: { re: /^\d{5}(-\d{4})?$/, says: 'a US ZIP is five digits, optionally followed by -1234' },
  CA: { re: /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/, says: 'a Canadian postal code looks like K1A 0B1' },
  GB: { re: /^[A-Za-z]{1,2}\d[A-Za-z\d]?[ ]?\d[A-Za-z]{2}$/, says: 'a UK post code looks like BS2 8LS' },
  DE: { re: /^\d{5}$/, says: 'a German PLZ is five digits' },
  FR: { re: /^\d{5}$/, says: 'a French code postal is five digits' },
  NL: { re: /^\d{4}\s?[A-Za-z]{2}$/, says: 'a Dutch postcode looks like 1012 AB' },
  AU: { re: /^\d{4}$/, says: 'an Australian postcode is four digits' },
  JP: { re: /^\d{3}-?\d{4}$/, says: 'a Japanese postal code looks like 100-0001' },
  TR: { re: /^\d{5}$/, says: 'a Turkish posta kodu is five digits' },
  IT: { re: /^\d{5}$/, says: 'an Italian CAP is five digits' },
  ES: { re: /^\d{5}$/, says: 'a Spanish código postal is five digits' },
  SE: { re: /^\d{3}\s?\d{2}$/, says: 'a Swedish postnummer looks like 123 45' },
};

/** US states, so a ZIP can be checked against the state written next to it. */
const US_ZIP_RANGES = [
  ['MA', 1000, 2799], ['RI', 2800, 2999], ['NH', 3000, 3899], ['ME', 3900, 4999],
  ['VT', 5000, 5999], ['CT', 6000, 6999], ['NJ', 7000, 8999], ['NY', 10000, 14999],
  ['PA', 15000, 19699], ['DE', 19700, 19999], ['DC', 20000, 20599], ['MD', 20600, 21999],
  ['VA', 22000, 24699], ['WV', 24700, 26899], ['NC', 27000, 28999], ['SC', 29000, 29999],
  ['GA', 30000, 31999], ['FL', 32000, 34999], ['AL', 35000, 36999], ['TN', 37000, 38599],
  ['MS', 38600, 39799], ['KY', 40000, 42799], ['OH', 43000, 45999], ['IN', 46000, 47999],
  ['MI', 48000, 49999], ['IA', 50000, 52899], ['WI', 53000, 54999], ['MN', 55000, 56799],
  ['SD', 57000, 57799], ['ND', 58000, 58899], ['MT', 59000, 59999], ['IL', 60000, 62999],
  ['MO', 63000, 65899], ['KS', 66000, 67999], ['NE', 68000, 69399], ['LA', 70000, 71499],
  ['AR', 71600, 72999], ['OK', 73000, 74999], ['TX', 75000, 79999], ['CO', 80000, 81699],
  ['WY', 82000, 83199], ['ID', 83200, 83899], ['UT', 84000, 84799], ['AZ', 85000, 86599],
  ['NM', 87000, 88499], ['NV', 88900, 89899], ['CA', 90000, 96199], ['OR', 97000, 97999],
  ['WA', 98000, 99499], ['AK', 99500, 99999], ['HI', 96700, 96899],
];

const clean = (s) => String(s ?? '').trim();

/**
 * The checks that never need an API call.
 * Each finding says what is wrong and how sure we are, because a "certain"
 * finding and a hunch should not look the same on screen.
 */
export function ruleChecks(address = {}) {
  const findings = [];
  const country = clean(address.country).toUpperCase();
  const zip = clean(address.zip);
  const state = clean(address.state).toUpperCase();
  const line1 = clean(address.line1);
  const city = clean(address.city);

  if (!line1) findings.push({ level: 'error', field: 'line1', says: 'There is no street address at all.' });
  if (!city) findings.push({ level: 'error', field: 'city', says: 'There is no city.' });
  if (!country) findings.push({ level: 'error', field: 'country', says: 'There is no country.' });

  // A street with no number is the most common undeliverable address.
  if (line1 && !/\d/.test(line1) && !clean(address.line2).match(/\d/)) {
    findings.push({
      level: 'warn',
      field: 'line1',
      says: 'The street line has no number in it, which usually means the house or building number is missing.',
    });
  }

  const rule = POSTCODE_RULES[country];
  if (rule && zip && !rule.re.test(zip)) {
    findings.push({ level: 'error', field: 'zip', says: `"${zip}" is not the right shape - ${rule.says}.` });
  }
  if (rule && !zip) {
    findings.push({ level: 'error', field: 'zip', says: `${country} needs a post code and there is none.` });
  }

  // A US ZIP that belongs to a different state is the classic silent failure:
  // it looks fine, and it goes to the wrong sorting centre.
  if (country === 'US' && /^\d{5}/.test(zip) && state.length === 2) {
    const n = Number(zip.slice(0, 5));
    const owner = US_ZIP_RANGES.find(([, lo, hi]) => n >= lo && n <= hi);
    if (owner && owner[0] !== state) {
      findings.push({
        level: 'error',
        field: 'zip',
        says: `ZIP ${zip} belongs to ${owner[0]}, but the state says ${state}.`,
        suggestion: { state: owner[0] },
      });
    }
  }

  // A PO box with an apartment, or a city written into the street line.
  if (line1 && city && line1.toLowerCase().includes(city.toLowerCase()) && line1.length > city.length + 4) {
    findings.push({
      level: 'info',
      field: 'line1',
      says: 'The city name appears inside the street line as well, which some couriers reject as a duplicate.',
    });
  }

  return findings;
}

const AI_SYSTEM = `You check shipping addresses for an online shop before a parcel is sent.

You are given one address exactly as the marketplace supplied it. Decide whether a courier
could deliver to it, and say what is wrong if not.

Look for:
- a street that does not exist in that city, or a city that does not exist in that state/country
- a misspelled city, street or state
- a post code that does not belong to that city
- an apartment, unit or building number written into the wrong field, or missing entirely
- a country that does not match the rest of the address
- text that is clearly not part of an address (a phone number, a note to the seller)

Be careful about two things:
- Addresses in other countries follow other conventions. An address that looks odd to a US
  eye may be perfectly normal in Japan, Turkey or the Netherlands. Do not flag a foreign
  format as an error.
- If you are not sure, say you are not sure. A false alarm on a good address costs the seller
  time and makes them stop reading these warnings.

Reply with JSON only:
{"verdict":"ok"|"suspect"|"undeliverable",
 "confidence":0.0-1.0,
 "summary":"one short line the seller can read at a glance",
 "findings":[{"field":"city","level":"error"|"warn"|"info","says":"what is wrong"}],
 "suggestion":{"line1":"...","line2":"...","city":"...","state":"...","zip":"...","country":"US"},
 "suggestionReason":"why this correction, or empty if you are not proposing one"}

Only include "suggestion" when you are proposing a specific corrected address. Leave out any
field you are not changing.`;

/** The address as stored on one order. */
export function addressOf(receiptId) {
  const row = getDb().prepare(`
    SELECT receipt_id, name, first_line, second_line, city, state, zip, country_iso,
           formatted_address, buyer_email, payment_email
    FROM receipts WHERE receipt_id = ? AND shop_id IS ?`).get(Number(receiptId), activeShopId());
  if (!row) throw notFound(`No order ${receiptId} here.`);
  return {
    receiptId: row.receipt_id,
    name: row.name,
    line1: row.first_line,
    line2: row.second_line,
    city: row.city,
    state: row.state,
    zip: row.zip,
    country: row.country_iso,
    formatted: row.formatted_address,
    email: row.buyer_email || row.payment_email || null,
  };
}

/**
 * Check one address: rules first, then the AI when asked.
 *
 * `provider` and `model` let you pick who does the reading and which version -
 * the careful model for the orders that matter, the quick one for a sweep.
 */
export async function checkAddress({ receiptId = null, address = null, useAi = true,
  provider, model, runner = run } = {}) {
  const subject = address ?? (receiptId ? addressOf(receiptId) : null);
  if (!subject) throw badRequest('Give an order id or an address to check.');

  const rules = ruleChecks(subject);
  const ruleErrors = rules.filter((f) => f.level === 'error');

  const result = {
    receiptId: subject.receiptId ?? receiptId ?? null,
    address: subject,
    rules,
    ai: null,
    // Rules alone already settle the obvious cases.
    verdict: ruleErrors.length ? 'suspect' : 'ok',
    summary: ruleErrors.length
      ? `${ruleErrors.length} problem${ruleErrors.length === 1 ? '' : 's'} found without needing the AI.`
      : 'Nothing wrong with the shape of this address.',
    suggestion: null,
    checkedAt: new Date().toISOString(),
  };

  if (!useAi) return result;

  const chosenProvider = provider || readSetting('ai.address.provider') || undefined;
  const chosenModel = model || readSetting('ai.address.model') || undefined;

  try {
    const ai = await runner({
      kind: 'custom',
      provider: chosenProvider,
      model: chosenModel,
      promptOverride: AI_SYSTEM,
      context: {
        address: {
          name: subject.name, line1: subject.line1, line2: subject.line2,
          city: subject.city, state: subject.state, zip: subject.zip, country: subject.country,
        },
        // What the rules already found, so the AI does not repeat it.
        alreadyFound: rules.map((r) => r.says),
      },
      userInput: 'Check this address. JSON only.',
      maxTokens: 1200,
    });

    const parsed = parseJsonish(ai.text);
    if (parsed) {
      const verdicts = ['ok', 'suspect', 'undeliverable'];
      const verdict = verdicts.includes(parsed.verdict) ? parsed.verdict : 'suspect';
      // Only keep a suggestion that actually changes something and only for
      // fields that exist, so a hallucinated key never reaches the order.
      const allowed = ['line1', 'line2', 'city', 'state', 'zip', 'country'];
      let suggestion = null;
      if (parsed.suggestion && typeof parsed.suggestion === 'object') {
        const changes = {};
        for (const key of allowed) {
          const value = clean(parsed.suggestion[key]);
          if (value && value !== clean(subject[key])) changes[key] = value;
        }
        if (Object.keys(changes).length) {
          suggestion = { changes, reason: String(parsed.suggestionReason ?? '').slice(0, 400) };
        }
      }

      result.ai = {
        provider: ai.provider,
        model: ai.model,
        verdict,
        confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : null,
        summary: String(parsed.summary ?? '').slice(0, 300),
        findings: (parsed.findings ?? []).slice(0, 12).map((f) => ({
          field: allowed.includes(f.field) ? f.field : 'address',
          level: ['error', 'warn', 'info'].includes(f.level) ? f.level : 'warn',
          says: String(f.says ?? '').slice(0, 300),
        })),
      };
      result.suggestion = suggestion;
      // The worse of the two readings wins - a rule error is never talked down
      // by the AI saying it looks fine.
      const rank = { ok: 0, suspect: 1, undeliverable: 2 };
      result.verdict = rank[verdict] > rank[result.verdict] ? verdict : result.verdict;
      result.summary = result.ai.summary || result.summary;
    } else {
      result.ai = { error: 'The AI did not return a usable answer.' };
    }
  } catch (err) {
    // A missing API key must not make the rule findings disappear.
    result.ai = { error: err.message };
  }

  if (result.receiptId) {
    getDb().prepare(`
      INSERT INTO address_checks (receipt_id, shop_id, verdict, summary, findings, suggestion, provider, model, checked_at)
      VALUES (?,?,?,?,?,?,?,?, datetime('now'))
      ON CONFLICT(receipt_id) DO UPDATE SET
        verdict = excluded.verdict, summary = excluded.summary, findings = excluded.findings,
        suggestion = excluded.suggestion, provider = excluded.provider, model = excluded.model,
        checked_at = datetime('now'), accepted = 0`)
      .run(result.receiptId, activeShopId(), result.verdict, result.summary,
        JSON.stringify([...rules, ...(result.ai?.findings ?? [])]),
        result.suggestion ? JSON.stringify(result.suggestion) : null,
        result.ai?.provider ?? null, result.ai?.model ?? null);
    audit('orders.address_check', { entity: 'receipt', entityId: result.receiptId, detail: { verdict: result.verdict } });
  }

  return result;
}

/** Check several orders, one after another so a rate limit does not bite. */
export async function checkMany({ receiptIds = [], useAi = true, provider, model, runner = run } = {}) {
  const out = [];
  for (const id of receiptIds) {
    try { out.push(await checkAddress({ receiptId: id, useAi, provider, model, runner })); }
    catch (err) { out.push({ receiptId: id, error: err.message }); }
  }
  return {
    checked: out.length,
    problems: out.filter((r) => r.verdict && r.verdict !== 'ok').length,
    results: out,
  };
}

/**
 * Take a proposed correction.
 *
 * The address on the receipt is Etsy's record and is not rewritten - what the
 * buyer typed stays visible. The accepted version is stored beside it and is
 * what the label and the Airtable push use, so you can always see both.
 */
export function acceptSuggestion(receiptId, changes = null) {
  const db = getDb();
  const id = Number(receiptId);
  const row = db.prepare('SELECT suggestion FROM address_checks WHERE receipt_id = ?').get(id);
  const proposed = changes ?? (row?.suggestion ? JSON.parse(row.suggestion).changes : null);
  if (!proposed || !Object.keys(proposed).length) throw badRequest('There is no correction to accept for this order.');

  const current = addressOf(id);
  const corrected = { ...current, ...proposed };

  db.prepare(`
    UPDATE address_checks SET accepted = 1, accepted_address = ?, accepted_at = datetime('now')
    WHERE receipt_id = ?`).run(JSON.stringify(corrected), id);
  audit('orders.address_accepted', { entity: 'receipt', entityId: id, detail: { changes: proposed } });
  return { receiptId: id, corrected, changed: Object.keys(proposed) };
}

/** What we last decided about an order's address. */
export function checkFor(receiptId) {
  const row = getDb().prepare('SELECT * FROM address_checks WHERE receipt_id = ?').get(Number(receiptId));
  if (!row) return null;
  return {
    receiptId: row.receipt_id,
    verdict: row.verdict,
    summary: row.summary,
    findings: row.findings ? JSON.parse(row.findings) : [],
    suggestion: row.suggestion ? JSON.parse(row.suggestion) : null,
    accepted: !!row.accepted,
    acceptedAddress: row.accepted_address ? JSON.parse(row.accepted_address) : null,
    provider: row.provider,
    model: row.model,
    checkedAt: row.checked_at,
  };
}

/** The orders currently flagged, for a "look at these before you ship" list. */
export function flagged({ limit = 100 } = {}) {
  return getDb().prepare(`
    SELECT a.receipt_id, a.verdict, a.summary, a.accepted, a.checked_at,
           r.name, r.city, r.country_iso
    FROM address_checks a JOIN receipts r ON r.receipt_id = a.receipt_id
    WHERE a.shop_id IS ? AND a.verdict <> 'ok' AND COALESCE(a.accepted, 0) = 0
    ORDER BY a.checked_at DESC LIMIT ?`).all(activeShopId(), limit);
}
