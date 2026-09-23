import React from 'react';
import { Thumb } from './ui.jsx';

/**
 * Supplier link, supplier order number and inbound tracking number, glanced
 * from the orders list instead of having to open every order to see whether
 * the supply-chain side of it is covered. Editing still happens in the order
 * detail drawer - this is read-only, on purpose, so the list stays a preview.
 * Shared between the Etsy and Shopify orders lists since both feed it the
 * same shape (order.supplyLink / .itemsWithSupplyLink / .supplierOrderRef /
 * .supplyTrackingNumber).
 */
export function SupplyCell({ order }) {
  const { supplyLink, itemsWithSupplyLink = 0, supplierOrderRef, supplyTrackingNumber } = order;
  if (!supplyLink && !supplierOrderRef && !supplyTrackingNumber) return <span className="muted small">—</span>;
  return (
    <div className="small" style={{ lineHeight: 1.6 }}>
      {supplyLink && (
        <div>
          <a href={supplyLink} target="_blank" rel="noreferrer" className="btn xs ghost" title="The supplier's page for this order's item">
            ↗ Link
          </a>
          {itemsWithSupplyLink > 1 && <span className="muted" style={{ marginLeft: 4 }}>+{itemsWithSupplyLink - 1} more</span>}
        </div>
      )}
      {supplierOrderRef && <div className="mono dim">#{supplierOrderRef}</div>}
      {supplyTrackingNumber && <div className="mono dim">{supplyTrackingNumber}</div>}
    </div>
  );
}

/** The warehouse photo for this order's first covered item, with an X/Y
 *  count when only some of a multi-item order's items have one. */
export function WarehouseCell({ order }) {
  const { warehousePhotoUrl, itemsWithPhoto = 0, itemCount = 1 } = order;
  if (!warehousePhotoUrl) return <span className="muted small">—</span>;
  return (
    <div className="flex gap4" style={{ alignItems: 'center' }}>
      <Thumb src={warehousePhotoUrl} />
      {itemCount > 1 && <span className="small dim">{itemsWithPhoto}/{itemCount}</span>}
    </div>
  );
}
