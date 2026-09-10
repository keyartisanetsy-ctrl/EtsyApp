/** Shop-level resources: sections, shipping profiles, return policies,
 *  holiday preferences, production partners, reviews and readiness states. */
import { Router } from 'express';
import { asyncRoute, int, required } from '../lib/http.js';
import { call, callAll } from '../etsy/client.js';
import { requireShopId, currentShop, activeShopId } from '../etsy/shop.js';
import { syncShopSections } from '../services/sync.js';
import { getDb } from '../db/index.js';

const router = Router();
const shop = () => requireShopId();

router.get('/', asyncRoute(async (req, res) => res.json(await call('getShop', { shop_id: shop() }))));
router.put('/', asyncRoute(async (req, res) => res.json(await call('updateShop', { shop_id: shop(), ...req.body }))));
router.get('/me', asyncRoute(async (req, res) => res.json({ ...currentShop(), user: await call('getMe', {}) })));

// ----------------------------------------------------------------- sections
router.get('/sections', asyncRoute(async (req, res) => {
  if (req.query.local) {
    return res.json(getDb().prepare('SELECT * FROM shop_sections WHERE shop_id IS ? ORDER BY rank').all(activeShopId()));
  }
  res.json(await call('getShopSections', { shop_id: shop() }));
}));
router.post('/sections/sync', asyncRoute(async (req, res) => res.json({ synced: await syncShopSections() })));
router.post('/sections', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['title']);
  res.status(201).json(await call('createShopSection', { shop_id: shop(), title: req.body.title }));
}));
router.put('/sections/:id', asyncRoute(async (req, res) => {
  res.json(await call('updateShopSection', { shop_id: shop(), shop_section_id: Number(req.params.id), title: req.body.title }));
}));
router.delete('/sections/:id', asyncRoute(async (req, res) => {
  res.json(await call('deleteShopSection', { shop_id: shop(), shop_section_id: Number(req.params.id) }) ?? { deleted: req.params.id });
}));
router.get('/sections/:id/listings', asyncRoute(async (req, res) => {
  res.json(await call('getListingsByShopSectionId', { shop_id: shop(), shop_section_ids: [Number(req.params.id)], limit: int(req.query.limit, 100) }));
}));

// -------------------------------------------------------- shipping profiles
router.get('/shipping-profiles', asyncRoute(async (req, res) => res.json(await call('getShopShippingProfiles', { shop_id: shop() }))));
router.post('/shipping-profiles', asyncRoute(async (req, res) => res.status(201).json(await call('createShopShippingProfile', { shop_id: shop(), ...req.body }))));
router.get('/shipping-profiles/:id', asyncRoute(async (req, res) => res.json(await call('getShopShippingProfile', { shop_id: shop(), shipping_profile_id: Number(req.params.id) }))));
router.put('/shipping-profiles/:id', asyncRoute(async (req, res) => res.json(await call('updateShopShippingProfile', { shop_id: shop(), shipping_profile_id: Number(req.params.id), ...req.body }))));
router.delete('/shipping-profiles/:id', asyncRoute(async (req, res) => res.json(await call('deleteShopShippingProfile', { shop_id: shop(), shipping_profile_id: Number(req.params.id) }) ?? { deleted: req.params.id })));

router.get('/shipping-profiles/:id/destinations', asyncRoute(async (req, res) => res.json(await call('getShopShippingProfileDestinationsByShippingProfile', { shop_id: shop(), shipping_profile_id: Number(req.params.id) }))));
router.post('/shipping-profiles/:id/destinations', asyncRoute(async (req, res) => res.status(201).json(await call('createShopShippingProfileDestination', { shop_id: shop(), shipping_profile_id: Number(req.params.id), ...req.body }))));
router.put('/shipping-profiles/:id/destinations/:destId', asyncRoute(async (req, res) => res.json(await call('updateShopShippingProfileDestination', { shop_id: shop(), shipping_profile_id: Number(req.params.id), shipping_profile_destination_id: Number(req.params.destId), ...req.body }))));
router.delete('/shipping-profiles/:id/destinations/:destId', asyncRoute(async (req, res) => res.json(await call('deleteShopShippingProfileDestination', { shop_id: shop(), shipping_profile_id: Number(req.params.id), shipping_profile_destination_id: Number(req.params.destId) }) ?? { deleted: req.params.destId })));

router.get('/shipping-profiles/:id/upgrades', asyncRoute(async (req, res) => res.json(await call('getShopShippingProfileUpgrades', { shop_id: shop(), shipping_profile_id: Number(req.params.id) }))));
router.post('/shipping-profiles/:id/upgrades', asyncRoute(async (req, res) => res.status(201).json(await call('createShopShippingProfileUpgrade', { shop_id: shop(), shipping_profile_id: Number(req.params.id), ...req.body }))));
router.put('/shipping-profiles/:id/upgrades/:upgradeId', asyncRoute(async (req, res) => res.json(await call('updateShopShippingProfileUpgrade', { shop_id: shop(), shipping_profile_id: Number(req.params.id), upgrade_id: Number(req.params.upgradeId), ...req.body }))));
router.delete('/shipping-profiles/:id/upgrades/:upgradeId', asyncRoute(async (req, res) => res.json(await call('deleteShopShippingProfileUpgrade', { shop_id: shop(), shipping_profile_id: Number(req.params.id), upgrade_id: Number(req.params.upgradeId) }) ?? { deleted: req.params.upgradeId })));

router.get('/carriers', asyncRoute(async (req, res) => res.json(await call('getShippingCarriers', { origin_country_iso: req.query.country ?? 'US' }, { auth: false }))));

// --------------------------------------------------------- return policies
router.get('/return-policies', asyncRoute(async (req, res) => res.json(await call('getShopReturnPolicies', { shop_id: shop() }))));
router.post('/return-policies', asyncRoute(async (req, res) => res.status(201).json(await call('createShopReturnPolicy', { shop_id: shop(), ...req.body }))));
router.get('/return-policies/:id', asyncRoute(async (req, res) => res.json(await call('getShopReturnPolicy', { shop_id: shop(), return_policy_id: Number(req.params.id) }))));
router.put('/return-policies/:id', asyncRoute(async (req, res) => res.json(await call('updateShopReturnPolicy', { shop_id: shop(), return_policy_id: Number(req.params.id), ...req.body }))));
router.delete('/return-policies/:id', asyncRoute(async (req, res) => res.json(await call('deleteShopReturnPolicy', { shop_id: shop(), return_policy_id: Number(req.params.id) }) ?? { deleted: req.params.id })));
router.post('/return-policies/consolidate', asyncRoute(async (req, res) => res.json(await call('consolidateShopReturnPolicies', { shop_id: shop(), ...req.body }))));
router.get('/return-policies/:id/listings', asyncRoute(async (req, res) => res.json(await call('getListingsByShopReturnPolicy', { shop_id: shop(), return_policy_id: Number(req.params.id) }))));

// --------------------------------------------------- holidays / partners
router.get('/holiday-preferences', asyncRoute(async (req, res) => res.json(await call('getHolidayPreferences', { shop_id: shop() }))));
router.put('/holiday-preferences/:holidayId', asyncRoute(async (req, res) => res.json(await call('updateHolidayPreferences', { shop_id: shop(), holiday_id: req.params.holidayId, ...req.body }))));
router.get('/production-partners', asyncRoute(async (req, res) => res.json(await call('getShopProductionPartners', { shop_id: shop() }))));

// ------------------------------------------------------- readiness states
router.get('/readiness-states', asyncRoute(async (req, res) => res.json(await call('getShopReadinessStateDefinitions', { shop_id: shop() }))));
router.post('/readiness-states', asyncRoute(async (req, res) => res.status(201).json(await call('createShopReadinessStateDefinition', { shop_id: shop(), ...req.body }))));
router.get('/readiness-states/:id', asyncRoute(async (req, res) => res.json(await call('getShopReadinessStateDefinition', { shop_id: shop(), readiness_state_definition_id: Number(req.params.id) }))));
router.put('/readiness-states/:id', asyncRoute(async (req, res) => res.json(await call('updateShopReadinessStateDefinition', { shop_id: shop(), readiness_state_definition_id: Number(req.params.id), ...req.body }))));
router.delete('/readiness-states/:id', asyncRoute(async (req, res) => res.json(await call('deleteShopReadinessStateDefinition', { shop_id: shop(), readiness_state_definition_id: Number(req.params.id) }) ?? { deleted: req.params.id })));

// ----------------------------------------------------------------- reviews
router.get('/reviews', asyncRoute(async (req, res) => {
  res.json({ results: await callAll('getReviewsByShop', { shop_id: shop() }, { max: int(req.query.limit, 200) }) });
}));
router.get('/reviews/listing/:listingId', asyncRoute(async (req, res) => {
  res.json(await call('getReviewsByListing', { listing_id: Number(req.params.listingId), limit: int(req.query.limit, 100) }));
}));

// --------------------------------------------------------------- addresses
router.get('/addresses', asyncRoute(async (req, res) => res.json(await call('getUserAddresses', {}))));
router.get('/addresses/:id', asyncRoute(async (req, res) => res.json(await call('getUserAddress', { user_address_id: Number(req.params.id) }))));
router.delete('/addresses/:id', asyncRoute(async (req, res) => res.json(await call('deleteUserAddress', { user_address_id: Number(req.params.id) }) ?? { deleted: req.params.id })));

export default router;
