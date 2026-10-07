import React from 'react';
import { Link } from 'react-router-dom';

/**
 * An order's code (26-0710-01) - the same one the packing desk, the supplier
 * sheet and the warehouse use - with what has arrived for it so far.
 */
export function OrderCode({ code }) {
  if (!code) return null;
  return <span className="mono" style={{ fontWeight: 700 }} title="Order code - type it on the Packing page to put a warehouse arrival on this order">{code}</span>;
}

export function ArrivalChip({ arrival }) {
  if (!arrival) return null;
  // An order whose first parcel is being kept at the warehouse for the rest of it.
  if (arrival.hold?.state === 'active') {
    return (
      <Link to="/packing" style={{ textDecoration: 'none' }}
            title={`The warehouse is asked to keep the parcel that arrived until the rest of this order is here (${arrival.received}${arrival.needed ? ` of ${arrival.needed}` : ''} pieces so far)`}>
        <span className="badge amber">⏸ {arrival.hold.code}{arrival.needed ? ` · ${arrival.received}/${arrival.needed} here` : ''}</span>
      </Link>
    );
  }
  const complete = arrival.needed && arrival.received >= arrival.needed;
  const labels = arrival.parcels.map((p) => p.label).filter(Boolean).join(', ');
  return (
    <Link to="/packing" style={{ textDecoration: 'none' }}
          title={`${arrival.received}${arrival.needed ? ` of ${arrival.needed}` : ''} piece${arrival.received === 1 ? '' : 's'} arrived at the warehouse${labels ? `: ${labels}` : ''}${arrival.packed ? ' - packed' : ''}`}>
      <span className={`badge ${arrival.packed ? 'blue' : complete ? 'green' : 'amber'}`}>
        {arrival.packed ? '📦 packed' : `📦 ${arrival.received}${arrival.needed ? `/${arrival.needed}` : ''} here`}
      </span>
    </Link>
  );
}
