/** Etsy money is {amount, divisor, currency_code}. Keep minor units in the DB
 *  and only divide at the edges so we never accumulate float error. */
export const toMajor = (m) =>
  !m || m.amount == null ? null : Number(m.amount) / (Number(m.divisor) || 100);

export const money = (m) => ({
  amount: m?.amount ?? null,
  divisor: m?.divisor ?? 100,
  currency: m?.currency_code ?? null,
  value: toMajor(m),
});

/** Price after a percentage off, rounded to cents. */
export const discounted = (value, percent) =>
  value == null ? null : Math.round(value * (1 - percent / 100) * 100) / 100;

/** The list price needed so that `percent` off lands on `target`. */
export const listPriceForTarget = (target, percent) =>
  target == null ? null : Math.round((target / (1 - percent / 100)) * 100) / 100;

export const fmt = (value, currency) =>
  value == null ? '' : `${currency ? `${currency} ` : ''}${value.toFixed(2)}`;
