/** The status vocabulary the tracking board works in. */
export const STATUS = {
  PRE_SHIPPED: 'pre_shipped',      // label made, carrier has not scanned it yet
  IN_TRANSIT: 'in_transit',        // "on its way"
  OUT_FOR_DELIVERY: 'out_for_delivery',
  PICKUP_WAITING: 'pickup_waiting',
  DELIVERED: 'delivered',
  EXCEPTION: 'exception',          // customs hold, damage, failed attempt
  RETURNED: 'returned',
  EXPIRED: 'expired',
  NOT_FOUND: 'not_found',
};

export const STATUS_LABELS = {
  pre_shipped: 'Pre-shipped',
  in_transit: 'On its way',
  out_for_delivery: 'Out for delivery',
  pickup_waiting: 'Waiting for pickup',
  delivered: 'Delivered',
  exception: 'Exception',
  returned: 'Returned',
  expired: 'Expired',
  not_found: 'Not found',
};

/** Terminal states never raise a stale alert. */
export const TERMINAL = new Set([STATUS.DELIVERED, STATUS.RETURNED]);

const RULES = [
  [STATUS.DELIVERED, /\b(delivered|signed for|entregado|livr[ée]|teslim edildi|投递成功|已签收|签收)\b/i],
  [STATUS.OUT_FOR_DELIVERY, /\b(out for delivery|with courier|delivery in progress|派送中|out-for-delivery)\b/i],
  [STATUS.PICKUP_WAITING, /\b(available for pickup|awaiting collection|collect|pickup point|待取件|held at)\b/i],
  [STATUS.RETURNED, /\b(return(ed|ing)? to sender|rts|refused|退回|退件)\b/i],
  [STATUS.EXCEPTION, /\b(exception|customs|detained|held|damaged|failed|undeliverable|address (problem|issue)|海关|异常|问题件)\b/i],
  [STATUS.EXPIRED, /\b(expired|no tracking information for a long time|过期)\b/i],
  [STATUS.IN_TRANSIT, /\b(in transit|departed|arrived|processed|accepted|dispatch|posting|flight|transport|运输|已发出|到达)\b/i],
  [STATUS.PRE_SHIPPED, /\b(pre-?shipment|label created|information received|awaiting item|电子信息已接收|预报)\b/i],
];

/** Best-effort mapping from a carrier's free-text event to our vocabulary. */
export function classify(text = '') {
  for (const [status, re] of RULES) if (re.test(text)) return status;
  return null;
}

/**
 * 17TRACK's numeric status codes.
 *
 * YunTrack uses a different, overlapping numbering (50 = delivered, 40 = alert)
 * and is mapped in its own adapter -- do not merge the two tables, the same
 * number means different things in each.
 */
export function fromProviderCode(code) {
  const map = {
    0: STATUS.NOT_FOUND,
    10: STATUS.IN_TRANSIT,
    20: STATUS.EXCEPTION,
    30: STATUS.PICKUP_WAITING,
    35: STATUS.OUT_FOR_DELIVERY,
    40: STATUS.DELIVERED,
    50: STATUS.RETURNED,
  };
  return map[Number(code)] ?? null;
}
