/** Payments and the payment-account ledger. */
import { Router } from 'express';
import { asyncRoute, int, list } from '../lib/http.js';
import { call, callAll } from '../etsy/client.js';
import { requireShopId } from '../etsy/shop.js';

const router = Router();

router.get('/payments', asyncRoute(async (req, res) => {
  res.json(await call('getPayments', { shop_id: requireShopId(), payment_ids: list(req.query.paymentIds).map(Number) }));
}));

router.get('/payments/receipt/:receiptId', asyncRoute(async (req, res) => {
  res.json(await call('getShopPaymentByReceiptId', { shop_id: requireShopId(), receipt_id: Number(req.params.receiptId) }));
}));

router.get('/ledger', asyncRoute(async (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  res.json({
    results: await callAll('getShopPaymentAccountLedgerEntries', {
      shop_id: requireShopId(),
      min_created: int(req.query.minCreated, now - 90 * 86_400),
      max_created: int(req.query.maxCreated, now),
    }, { max: int(req.query.limit, 500) }),
  });
}));

router.get('/ledger/:id', asyncRoute(async (req, res) => {
  res.json(await call('getShopPaymentAccountLedgerEntry', { shop_id: requireShopId(), ledger_entry_id: Number(req.params.id) }));
}));

router.get('/ledger-payments', asyncRoute(async (req, res) => {
  res.json(await call('getPaymentAccountLedgerEntryPayments', { shop_id: requireShopId(), ledger_entry_ids: list(req.query.ids).map(Number) }));
}));

router.get('/transactions', asyncRoute(async (req, res) => {
  res.json(await call('getShopReceiptTransactionsByShop', { shop_id: requireShopId(), limit: int(req.query.limit, 100), offset: int(req.query.offset, 0) }));
}));

router.get('/transactions/:id', asyncRoute(async (req, res) => {
  res.json(await call('getShopReceiptTransaction', { shop_id: requireShopId(), transaction_id: Number(req.params.id) }));
}));

router.get('/transactions/listing/:listingId', asyncRoute(async (req, res) => {
  res.json(await call('getShopReceiptTransactionsByListing', { shop_id: requireShopId(), listing_id: Number(req.params.listingId), limit: int(req.query.limit, 100) }));
}));

export default router;
