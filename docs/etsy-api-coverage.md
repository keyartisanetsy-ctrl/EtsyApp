# Etsy Open API v3 — coverage

This app builds its client from Etsy's own OpenAPI document, so the table below
is generated, not hand-maintained. Re-run `npm run codegen` after Etsy ships a
spec update and it refreshes itself.

**105 operations across 27 tags — all of them reachable.**

Most operations have a purpose-built screen. The rest are reachable through the
**API explorer**, which can invoke any operationId through the same
authenticated, rate-limited client, with the parameter and body schema rendered
from the spec. That is what makes coverage total rather than selective.

| Tag | Ops | Operations |
|---|---:|---|
| **BuyerTaxonomy** | 2 | `getBuyerTaxonomyNodes`, `getPropertiesByBuyerTaxonomyId` |
| **Ledger Entry** | 2 | `getShopPaymentAccountLedgerEntries`, `getShopPaymentAccountLedgerEntry` |
| **Other** | 2 | `ping`, `tokenScopes` |
| **Payment** | 3 | `getPaymentAccountLedgerEntryPayments`, `getPayments`, `getShopPaymentByReceiptId` |
| **Review** | 2 | `getReviewsByListing`, `getReviewsByShop` |
| **SellerTaxonomy** | 2 | `getPropertiesByTaxonomyId`, `getSellerTaxonomyNodes` |
| **Shop HolidayPreferences** | 2 | `getHolidayPreferences`, `updateHolidayPreferences` |
| **Shop ProcessingProfiles** | 5 | `createShopReadinessStateDefinition`, `deleteShopReadinessStateDefinition`, `getShopReadinessStateDefinition`, `getShopReadinessStateDefinitions`, `updateShopReadinessStateDefinition` |
| **Shop ProductionPartner** | 1 | `getShopProductionPartners` |
| **Shop Receipt Transactions** | 4 | `getShopReceiptTransaction`, `getShopReceiptTransactionsByListing`, `getShopReceiptTransactionsByReceipt`, `getShopReceiptTransactionsByShop` |
| **Shop Receipt** | 4 | `createReceiptShipment`, `getShopReceipt`, `getShopReceipts`, `updateShopReceipt` |
| **Shop Return Policy** | 6 | `consolidateShopReturnPolicies`, `createShopReturnPolicy`, `deleteShopReturnPolicy`, `getShopReturnPolicies`, `getShopReturnPolicy`, `updateShopReturnPolicy` |
| **Shop Section** | 5 | `createShopSection`, `deleteShopSection`, `getShopSection`, `getShopSections`, `updateShopSection` |
| **Shop ShippingProfile** | 14 | `createShopShippingProfile`, `createShopShippingProfileDestination`, `createShopShippingProfileUpgrade`, `deleteShopShippingProfile`, `deleteShopShippingProfileDestination`, `deleteShopShippingProfileUpgrade`, `getShippingCarriers`, `getShopShippingProfile`, `getShopShippingProfileDestinationsByShippingProfile`, `getShopShippingProfiles`, `getShopShippingProfileUpgrades`, `updateShopShippingProfile`, `updateShopShippingProfileDestination`, `updateShopShippingProfileUpgrade` |
| **Shop** | 4 | `findShops`, `getShop`, `getShopByOwnerUserId`, `updateShop` |
| **ShopListing File** | 4 | `deleteListingFile`, `getAllListingFiles`, `getListingFile`, `uploadListingFile` |
| **ShopListing Image** | 4 | `deleteListingImage`, `getListingImage`, `getListingImages`, `uploadListingImage` |
| **ShopListing Inventory** | 3 | `getListingInventory`, `getListingsInventoryByListingIds`, `updateListingInventory` |
| **ShopListing Offering** | 1 | `getListingOffering` |
| **ShopListing Personalization** | 3 | `deleteListingPersonalization`, `getListingPersonalization`, `updateListingPersonalization` |
| **ShopListing Product** | 1 | `getListingProduct` |
| **ShopListing Translation** | 3 | `createListingTranslation`, `getListingTranslation`, `updateListingTranslation` |
| **ShopListing VariationImage** | 2 | `getListingVariationImages`, `updateVariationImages` |
| **ShopListing Video** | 4 | `deleteListingVideo`, `getListingVideo`, `getListingVideos`, `uploadListingVideo` |
| **ShopListing** | 17 | `createDraftListing`, `deleteListing`, `deleteListingProperty`, `findAllActiveListingsByShop`, `findAllListingsActive`, `getFeaturedListingsByShop`, `getListing`, `getListingProperties`, `getListingProperty`, `getListingsByListingIds`, `getListingsByShop`, `getListingsByShopReceipt`, `getListingsByShopReturnPolicy`, `getListingsByShopSectionId`, `getListingsShippingByListingIds`, `updateListing`, `updateListingProperty` |
| **User** | 2 | `getMe`, `getUser` |
| **UserAddress** | 3 | `deleteUserAddress`, `getUserAddress`, `getUserAddresses` |

## Where each operation is used

| Operation | Method | Path | Scopes | Used by |
|---|---|---|---|---|
| `consolidateShopReturnPolicies` | POST | `/v3/application/shops/{shop_id}/policies/return/consolidate` | shops_w | Shop settings |
| `createDraftListing` | POST | `/v3/application/shops/{shop_id}/listings` | listings_w | Listings screen |
| `createListingTranslation` | POST | `/v3/application/shops/{shop_id}/listings/{listing_id}/translations/{language}` | listings_w | Listing extras |
| `createReceiptShipment` | POST | `/v3/application/shops/{shop_id}/receipts/{receipt_id}/tracking` | transactions_w | Tracking |
| `createShopReadinessStateDefinition` | POST | `/v3/application/shops/{shop_id}/readiness-state-definitions` | shops_w | Shop settings |
| `createShopReturnPolicy` | POST | `/v3/application/shops/{shop_id}/policies/return` | shops_w | Shop settings |
| `createShopSection` | POST | `/v3/application/shops/{shop_id}/sections` | shops_w | Shop settings |
| `createShopShippingProfile` | POST | `/v3/application/shops/{shop_id}/shipping-profiles` | shops_w | Shop settings |
| `createShopShippingProfileDestination` | POST | `/v3/application/shops/{shop_id}/shipping-profiles/{shipping_profile_id}/destinations` | shops_w | Shop settings |
| `createShopShippingProfileUpgrade` | POST | `/v3/application/shops/{shop_id}/shipping-profiles/{shipping_profile_id}/upgrades` | shops_w | Shop settings |
| `deleteListing` | DELETE | `/v3/application/listings/{listing_id}` | listings_d | Listings screen |
| `deleteListingFile` | DELETE | `/v3/application/shops/{shop_id}/listings/{listing_id}/files/{listing_file_id}` | listings_w | Listing media |
| `deleteListingImage` | DELETE | `/v3/application/shops/{shop_id}/listings/{listing_id}/images/{listing_image_id}` | listings_w | Listing media |
| `deleteListingPersonalization` | DELETE | `/v3/application/shops/{shop_id}/listings/{listing_id}/personalization` | listings_w | Listing extras |
| `deleteListingProperty` | DELETE | `/v3/application/shops/{shop_id}/listings/{listing_id}/properties/{property_id}` | listings_w | Listing extras |
| `deleteListingVideo` | DELETE | `/v3/application/shops/{shop_id}/listings/{listing_id}/videos/{video_id}` | listings_w | Listing media |
| `deleteShopReadinessStateDefinition` | DELETE | `/v3/application/shops/{shop_id}/readiness-state-definitions/{readiness_state_definition_id}` | shops_w | Shop settings |
| `deleteShopReturnPolicy` | DELETE | `/v3/application/shops/{shop_id}/policies/return/{return_policy_id}` | shops_w | Shop settings |
| `deleteShopSection` | DELETE | `/v3/application/shops/{shop_id}/sections/{shop_section_id}` | shops_w | Shop settings |
| `deleteShopShippingProfile` | DELETE | `/v3/application/shops/{shop_id}/shipping-profiles/{shipping_profile_id}` | shops_w | Shop settings |
| `deleteShopShippingProfileDestination` | DELETE | `/v3/application/shops/{shop_id}/shipping-profiles/{shipping_profile_id}/destinations/{shipping_profile_destination_id}` | shops_w | Shop settings |
| `deleteShopShippingProfileUpgrade` | DELETE | `/v3/application/shops/{shop_id}/shipping-profiles/{shipping_profile_id}/upgrades/{upgrade_id}` | shops_w | Shop settings |
| `deleteUserAddress` | DELETE | `/v3/application/user/addresses/{user_address_id}` | address_r | Account / auth |
| `findAllActiveListingsByShop` | GET | `/v3/application/shops/{shop_id}/listings/active` | _public_ | Listings screen |
| `findAllListingsActive` | GET | `/v3/application/listings/active` | _public_ | Product research |
| `findShops` | GET | `/v3/application/shops` | _public_ | Product research |
| `getAllListingFiles` | GET | `/v3/application/shops/{shop_id}/listings/{listing_id}/files` | listings_r | Listing media |
| `getBuyerTaxonomyNodes` | GET | `/v3/application/buyer-taxonomy/nodes` | _public_ | Product research |
| `getFeaturedListingsByShop` | GET | `/v3/application/shops/{shop_id}/listings/featured` | _public_ | Listings screen |
| `getHolidayPreferences` | GET | `/v3/application/shops/{shop_id}/holiday-preferences` | shops_r | Shop settings |
| `getListing` | GET | `/v3/application/listings/{listing_id}` | _public_ | Listings screen |
| `getListingFile` | GET | `/v3/application/shops/{shop_id}/listings/{listing_id}/files/{listing_file_id}` | listings_r | Listing media |
| `getListingImage` | GET | `/v3/application/listings/{listing_id}/images/{listing_image_id}` | _public_ | Listing media |
| `getListingImages` | GET | `/v3/application/listings/{listing_id}/images` | _public_ | Listing media |
| `getListingInventory` | GET | `/v3/application/listings/{listing_id}/inventory` | listings_r | SKUs & variations |
| `getListingOffering` | GET | `/v3/application/listings/{listing_id}/products/{product_id}/offerings/{product_offering_id}` | _public_ | SKUs & variations |
| `getListingPersonalization` | GET | `/v3/application/listings/{listing_id}/personalization` | _public_ | Listing extras |
| `getListingProduct` | GET | `/v3/application/listings/{listing_id}/inventory/products/{product_id}` | listings_r | SKUs & variations |
| `getListingProperties` | GET | `/v3/application/shops/{shop_id}/listings/{listing_id}/properties` | _public_ | Listing extras |
| `getListingProperty` | GET | `/v3/application/listings/{listing_id}/properties/{property_id}` | _public_ | Listing extras |
| `getListingsByListingIds` | GET | `/v3/application/listings/batch` | _public_ | Listings screen |
| `getListingsByShop` | GET | `/v3/application/shops/{shop_id}/listings` | listings_r | Listings screen |
| `getListingsByShopReceipt` | GET | `/v3/application/shops/{shop_id}/receipts/{receipt_id}/listings` | transactions_r | Orders |
| `getListingsByShopReturnPolicy` | GET | `/v3/application/shops/{shop_id}/policies/return/{return_policy_id}/listings` | listings_r | Listings screen |
| `getListingsByShopSectionId` | GET | `/v3/application/shops/{shop_id}/shop-sections/listings` | _public_ | Listings screen |
| `getListingsInventoryByListingIds` | GET | `/v3/application/listings/batch/inventory` | listings_r | SKUs & variations |
| `getListingsShippingByListingIds` | GET | `/v3/application/listings/batch/shipping` | shops_r | Shipping (batch) |
| `getListingTranslation` | GET | `/v3/application/shops/{shop_id}/listings/{listing_id}/translations/{language}` | _public_ | Listing extras |
| `getListingVariationImages` | GET | `/v3/application/shops/{shop_id}/listings/{listing_id}/variation-images` | _public_ | SKUs & variations |
| `getListingVideo` | GET | `/v3/application/listings/{listing_id}/videos/{video_id}` | _public_ | Listing media |
| `getListingVideos` | GET | `/v3/application/listings/{listing_id}/videos` | _public_ | Listing media |
| `getMe` | GET | `/v3/application/users/me` | shops_r | Account / auth |
| `getPaymentAccountLedgerEntryPayments` | GET | `/v3/application/shops/{shop_id}/payment-account/ledger-entries/payments` | transactions_r | Finance |
| `getPayments` | GET | `/v3/application/shops/{shop_id}/payments` | transactions_r | Finance |
| `getPropertiesByBuyerTaxonomyId` | GET | `/v3/application/buyer-taxonomy/nodes/{taxonomy_id}/properties` | _public_ | Product research |
| `getPropertiesByTaxonomyId` | GET | `/v3/application/seller-taxonomy/nodes/{taxonomy_id}/properties` | _public_ | Product research |
| `getReviewsByListing` | GET | `/v3/application/listings/{listing_id}/reviews` | _public_ | Reviews |
| `getReviewsByShop` | GET | `/v3/application/shops/{shop_id}/reviews` | _public_ | Reviews |
| `getSellerTaxonomyNodes` | GET | `/v3/application/seller-taxonomy/nodes` | _public_ | Product research |
| `getShippingCarriers` | GET | `/v3/application/shipping-carriers` | _public_ | Tracking |
| `getShop` | GET | `/v3/application/shops/{shop_id}` | _public_ | Shop settings |
| `getShopByOwnerUserId` | GET | `/v3/application/users/{user_id}/shops` | _public_ | Account / auth |
| `getShopPaymentAccountLedgerEntries` | GET | `/v3/application/shops/{shop_id}/payment-account/ledger-entries` | transactions_r | Finance |
| `getShopPaymentAccountLedgerEntry` | GET | `/v3/application/shops/{shop_id}/payment-account/ledger-entries/{ledger_entry_id}` | transactions_r | Finance |
| `getShopPaymentByReceiptId` | GET | `/v3/application/shops/{shop_id}/receipts/{receipt_id}/payments` | transactions_r | Finance |
| `getShopProductionPartners` | GET | `/v3/application/shops/{shop_id}/production-partners` | shops_r | Shop settings |
| `getShopReadinessStateDefinition` | GET | `/v3/application/shops/{shop_id}/readiness-state-definitions/{readiness_state_definition_id}` | shops_r | Shop settings |
| `getShopReadinessStateDefinitions` | GET | `/v3/application/shops/{shop_id}/readiness-state-definitions` | shops_r | Shop settings |
| `getShopReceipt` | GET | `/v3/application/shops/{shop_id}/receipts/{receipt_id}` | transactions_r | Orders |
| `getShopReceipts` | GET | `/v3/application/shops/{shop_id}/receipts` | transactions_r | Orders |
| `getShopReceiptTransaction` | GET | `/v3/application/shops/{shop_id}/transactions/{transaction_id}` | transactions_r | Orders |
| `getShopReceiptTransactionsByListing` | GET | `/v3/application/shops/{shop_id}/listings/{listing_id}/transactions` | transactions_r | Orders |
| `getShopReceiptTransactionsByReceipt` | GET | `/v3/application/shops/{shop_id}/receipts/{receipt_id}/transactions` | transactions_r | Orders |
| `getShopReceiptTransactionsByShop` | GET | `/v3/application/shops/{shop_id}/transactions` | transactions_r | Orders |
| `getShopReturnPolicies` | GET | `/v3/application/shops/{shop_id}/policies/return` | _public_ | Shop settings |
| `getShopReturnPolicy` | GET | `/v3/application/shops/{shop_id}/policies/return/{return_policy_id}` | _public_ | Shop settings |
| `getShopSection` | GET | `/v3/application/shops/{shop_id}/sections/{shop_section_id}` | _public_ | Shop settings |
| `getShopSections` | GET | `/v3/application/shops/{shop_id}/sections` | _public_ | Shop settings |
| `getShopShippingProfile` | GET | `/v3/application/shops/{shop_id}/shipping-profiles/{shipping_profile_id}` | shops_r | Shop settings |
| `getShopShippingProfileDestinationsByShippingProfile` | GET | `/v3/application/shops/{shop_id}/shipping-profiles/{shipping_profile_id}/destinations` | shops_r | Shop settings |
| `getShopShippingProfiles` | GET | `/v3/application/shops/{shop_id}/shipping-profiles` | shops_r | Shop settings |
| `getShopShippingProfileUpgrades` | GET | `/v3/application/shops/{shop_id}/shipping-profiles/{shipping_profile_id}/upgrades` | shops_r | Shop settings |
| `getUser` | GET | `/v3/application/users/{user_id}` | email_r | Account / auth |
| `getUserAddress` | GET | `/v3/application/user/addresses/{user_address_id}` | address_r | Account / auth |
| `getUserAddresses` | GET | `/v3/application/user/addresses` | address_r | Account / auth |
| `ping` | GET | `/v3/application/openapi-ping` | _public_ | Account / auth |
| `tokenScopes` | POST | `/v3/application/scopes` | _public_ | Account / auth |
| `updateHolidayPreferences` | PUT | `/v3/application/shops/{shop_id}/holiday-preferences/{holiday_id}` | shops_w | Shop settings |
| `updateListing` | PATCH | `/v3/application/shops/{shop_id}/listings/{listing_id}` | listings_w | Listings screen |
| `updateListingInventory` | PUT | `/v3/application/listings/{listing_id}/inventory` | listings_w | SKUs & variations |
| `updateListingPersonalization` | POST | `/v3/application/shops/{shop_id}/listings/{listing_id}/personalization` | listings_w | Listing extras |
| `updateListingProperty` | PUT | `/v3/application/shops/{shop_id}/listings/{listing_id}/properties/{property_id}` | listings_w | Listing extras |
| `updateListingTranslation` | PUT | `/v3/application/shops/{shop_id}/listings/{listing_id}/translations/{language}` | listings_w | Listing extras |
| `updateShop` | PUT | `/v3/application/shops/{shop_id}` | shops_r shops_w | Shop settings |
| `updateShopReadinessStateDefinition` | PUT | `/v3/application/shops/{shop_id}/readiness-state-definitions/{readiness_state_definition_id}` | shops_w | Shop settings |
| `updateShopReceipt` | PUT | `/v3/application/shops/{shop_id}/receipts/{receipt_id}` | transactions_w | Orders |
| `updateShopReturnPolicy` | PUT | `/v3/application/shops/{shop_id}/policies/return/{return_policy_id}` | shops_w | Shop settings |
| `updateShopSection` | PUT | `/v3/application/shops/{shop_id}/sections/{shop_section_id}` | shops_w | Shop settings |
| `updateShopShippingProfile` | PUT | `/v3/application/shops/{shop_id}/shipping-profiles/{shipping_profile_id}` | shops_w | Shop settings |
| `updateShopShippingProfileDestination` | PUT | `/v3/application/shops/{shop_id}/shipping-profiles/{shipping_profile_id}/destinations/{shipping_profile_destination_id}` | shops_w | Shop settings |
| `updateShopShippingProfileUpgrade` | PUT | `/v3/application/shops/{shop_id}/shipping-profiles/{shipping_profile_id}/upgrades/{upgrade_id}` | shops_w | Shop settings |
| `updateVariationImages` | POST | `/v3/application/shops/{shop_id}/listings/{listing_id}/variation-images` | listings_w | SKUs & variations |
| `uploadListingFile` | POST | `/v3/application/shops/{shop_id}/listings/{listing_id}/files` | listings_w | Listing media |
| `uploadListingImage` | POST | `/v3/application/shops/{shop_id}/listings/{listing_id}/images` | listings_w | Listing media |
| `uploadListingVideo` | POST | `/v3/application/shops/{shop_id}/listings/{listing_id}/videos` | listings_w | Listing media |

## OAuth scopes

The connect flow requests every scope Etsy defines, so no feature fails later
for want of permission. Etsy shows the seller exactly what is being granted.

| Scope | Grants |
|---|---|
| `address_r` / `address_w` | read / update billing and shipping addresses |
| `billing_r` | read billing data (not used by any v3 operation) |
| `email_r` | read the user profile |
| `listings_r` / `listings_w` / `listings_d` | read / create-edit / delete listings |
| `profile_r` / `profile_w` | read / update profile |
| `shops_r` / `shops_w` | read private shop data / update the shop |
| `transactions_r` / `transactions_w` | read checkout and payment data / update receipts |

## Notes on specific endpoints

- **`updateListingInventory` replaces the entire product array.** There is no
  per-variation patch. Every SKU or price edit is therefore read-modify-write,
  and the payload is rebuilt from scratch because Etsy rejects the read-only
  fields it returns on GET (`product_id`, `offering_id`, `is_deleted`, and
  `scale_id` on an unscaled property). The `*_on_property` arrays are carried
  through unchanged or the variation structure collapses.
- **`updateListing` accepts only `active` and `inactive` for `state`.**
  `draft`, `expired` and `sold_out` are states Etsy assigns itself: a published
  listing can never return to draft, and expiry/sell-out follow from the end
  date and stock level. The UI says this rather than offering a button that fails.
- **`createDraftListing` always creates a draft**, so the create screen cannot
  publish by accident. Activation is a separate, deliberate step.
- **`createReceiptShipment` is what marks an order shipped** and emails the
  buyer. Bulk tracking uses it, and it can be turned off to record a number locally only.
- **Restricted endpoints.** A few operations are gated behind an Etsy
  application review and return 403 on a standard app. The explorer flags these
  from the spec text rather than letting the call fail unexplained.

