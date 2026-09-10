/**
 * What state an order is actually in, as a set of chips rather than one flag.
 *
 * An order is rarely in a single state: it can be delivered and still have a
 * problem, because things go wrong after the parcel arrives. So this returns a
 * list, ordered the way the work happens, and each chip carries the sentence
 * that explains it — no guessing what a colour means.
 *
 * Everything here is derived from facts already recorded (pushed to Airtable,
 * supplier ordered, tracking added, parcel delivered, days without movement)
 * except the problem state, which you or the AI set deliberately.
 */

export const PROBLEM = {
  NONE: 'none',
  WARNING: 'warning',
  SOLVED: 'solved',
  OUT_OF_STOCK: 'out_of_stock',
};

/** How long without a carrier scan before it is worth worrying, and how much. */
export const IDLE_TIERS = [
  { days: 5, level: 'severe', label: 'No movement for 5+ days', hint: 'Serious: nothing has scanned for five days or more. Chase the courier now.' },
  { days: 4, level: 'high', label: 'No movement for 4+ days', hint: 'Getting worse: four days without a scan.' },
  { days: 3, level: 'watch', label: 'No movement for 3+ days', hint: 'Something is off: three days without a scan.' },
];

export const idleTier = (days) => (days === null || days === undefined
  ? null
  : IDLE_TIERS.find((t) => days >= t.days) ?? null);

/**
 * The chips for one order row.
 *
 * `row` is the joined order record the list and detail queries already build.
 */
export function statusesFor(row = {}) {
  const out = [];
  const add = (id, label, kind, hint) => out.push({ id, label, kind, hint });

  if (row.was_canceled) {
    add('canceled', 'Canceled', 'muted', 'Etsy reports this order as cancelled.');
  }

  if (row.airtable_pushed_at) {
    add('airtable', 'Airtable', 'info',
      `Sent to Airtable ${row.airtable_pushed_at}. Sending again updates the same row.`);
  }

  // Offsite ads cost real money, so it is worth seeing at a glance which
  // orders carry the fee rather than discovering it at month end.
  if (row.offsite_ads) {
    add('offsite_ads', 'Offsite ad', 'warn',
      row.offsite_ads_explanation || 'This order came from an Etsy Offsite Ad, so Etsy takes an advertising fee from it.');
  }

  if (row.supplier_ordered) {
    add('ordered', 'Ordered', 'info',
      row.supplier_order_ref
        ? `Ordered from the supplier (ref ${row.supplier_order_ref}).`
        : 'Ordered from the supplier. Add the supplier reference on the order if you want it here.');
  }

  const delivered = row.tracking_status === 'delivered';
  if (row.tracking_code && !delivered) {
    add('shipped', 'Shipped', 'ok',
      `Tracking ${row.tracking_code} is on the order${row.carrier_name ? ` with ${row.carrier_name}` : ''}.`);
  }
  if (delivered) {
    add('delivered', 'Delivered', 'ok',
      'The parcel arrived. Good moment to ask the buyer for a review.');
  }

  const problem = row.problem_state ?? PROBLEM.NONE;
  if (problem === PROBLEM.OUT_OF_STOCK) {
    add('out_of_stock', 'Out of stock', 'bad',
      row.problem_note || 'The item you need to buy is not in stock. It cannot be fulfilled until it is back.');
  }

  // A problem can sit alongside delivered: things go wrong after arrival too.
  if (problem === PROBLEM.WARNING || problem === PROBLEM.OUT_OF_STOCK) {
    add('warning', 'Warning', 'bad', row.problem_note || 'Marked as having a problem.');
  } else if (problem === PROBLEM.SOLVED) {
    add('solved', 'Solved', 'ok', row.problem_note || 'There was a problem and it has been sorted out.');
  }

  // An idle parcel is a problem whether or not anyone marked it as one.
  const tier = row.tracking_code && !delivered ? idleTier(row.days_since_move) : null;
  if (tier && problem !== PROBLEM.SOLVED) {
    const nonYun = !String(row.tracking_code || '').toUpperCase().startsWith('YT');
    add(`idle_${tier.level}`, tier.label, tier.level === 'watch' ? 'warn' : 'bad',
      nonYun
        ? `${tier.hint} This number is not a YunExpress one, so the app cannot follow it automatically — check it with the carrier.`
        : tier.hint);
  }

  if (!out.length) {
    add('new', 'New', 'muted', 'Nothing has happened to this order yet.');
  }
  return out;
}

/** One line summarising the chips, for exports and tooltips. */
export const statusLine = (row) => statusesFor(row).map((s) => s.label).join(' · ');
