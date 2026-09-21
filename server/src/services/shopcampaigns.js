/**
 * Shop Campaigns: Shopify's own in-app advertising, run from inside the
 * consumer Shop app/shop.app rather than a third-party ad platform. Its
 * numbers are not exposed as plain Order fields - the only documented route
 * is a ShopifyQL query against the `shop_campaign_insights` schema, which
 * needs API version 2025-10+, the `read_reports` scope, AND a separate
 * Shopify "Level 2 protected customer data" approval that has to be
 * requested by the merchant through the Partner/Dev Dashboard - nothing a
 * scope grant alone can turn on. Until that approval is in place Shopify
 * answers the query with an ACCESS_DENIED-shaped error, which is treated
 * here as "not available yet" rather than a failure.
 */
import { gql, ShopifyApiError } from '../shopify/client.js';
import { AppError } from '../lib/errors.js';

const NOT_APPROVED_HINT = 'Shop Campaigns spend needs Shopify\'s "Level 2 access to protected customer data" '
  + 'approval, requested for this app from the Partner/Dev Dashboard, on top of the read_reports scope this app '
  + 'already asks for. Once Shopify approves it, this panel starts showing real numbers - nothing to change here.';

const QUERY = `
query ShopCampaignInsights($q: String!) {
  shopifyqlQuery(query: $q) {
    parseErrors
    tableData { columns { name dataType displayName } rows }
  }
}`;

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const round2 = (n) => (n === null || n === undefined || Number.isNaN(n) ? null : Math.round((n + Number.EPSILON) * 100) / 100);
const sum = (arr) => arr.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

const looksLikeAccessDenied = (err) => {
  if (err instanceof ShopifyApiError) {
    if (err.status === 401 || err.status === 403) return true;
    if (Array.isArray(err.errors) && err.errors.some((e) => e.extensions?.code === 'ACCESS_DENIED')) return true;
  }
  return /access denied|not approved|protected customer data|read_reports/i.test(err?.message || '');
};

const notAvailable = (reason) => ({ available: false, reason });

/**
 * Ad spend, sales, ROAS, CAC etc. per Shop Campaign over the last N days.
 * Returns { available: false, reason } instead of throwing when Shopify has
 * not yet granted the approval this query needs - that is an expected,
 * permanent-until-the-merchant-acts state, not a bug.
 */
export async function campaignAdSpend({ sinceDays = 30 } = {}) {
  const days = Math.max(1, Math.min(365, Number(sinceDays) || 30));
  const shopifyql = `
FROM shop_campaign_insights
SHOW shop_campaign_sales, shop_campaign_ad_spend, shop_campaign_return_on_ad_spend,
     shop_campaign_average_customer_acquisition_cost, shop_campaign_average_order_value, shop_campaign_customers
GROUP BY shop_campaign_name
SINCE -${days}d UNTIL today
ORDER BY shop_campaign_ad_spend DESC`.trim();

  let data;
  try {
    data = await gql(QUERY, { q: shopifyql });
  } catch (err) {
    if (looksLikeAccessDenied(err)) return notAvailable(NOT_APPROVED_HINT);
    throw err;
  }

  const resp = data?.shopifyqlQuery;
  if (!resp) return notAvailable(NOT_APPROVED_HINT);
  if (resp.parseErrors?.length) throw new AppError(502, `ShopifyQL rejected the query: ${resp.parseErrors.join('; ')}`);

  const rows = Array.isArray(resp.tableData?.rows) ? resp.tableData.rows : [];
  const campaigns = rows.map((r) => ({
    name: r.shop_campaign_name || '(unnamed campaign)',
    sales: num(r.shop_campaign_sales),
    adSpend: num(r.shop_campaign_ad_spend),
    roas: num(r.shop_campaign_return_on_ad_spend),
    avgCac: num(r.shop_campaign_average_customer_acquisition_cost),
    avgOrderValue: num(r.shop_campaign_average_order_value),
    customers: num(r.shop_campaign_customers),
  }));

  const totalAdSpend = round2(sum(campaigns.map((c) => c.adSpend)));
  const totalSales = round2(sum(campaigns.map((c) => c.sales)));
  const totalCustomers = sum(campaigns.map((c) => c.customers));

  return {
    available: true,
    sinceDays: days,
    campaigns,
    totals: {
      adSpend: totalAdSpend,
      sales: totalSales,
      customers: totalCustomers,
      roas: totalAdSpend ? round2(totalSales / totalAdSpend) : null,
      avgCac: totalCustomers ? round2(totalAdSpend / totalCustomers) : null,
    },
  };
}
