import React, { useEffect, useState, useCallback } from 'react';
import { Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import api from './lib/api.js';
import { ToastHost, useToast, useErrorToast } from './components/ui.jsx';
import UndoHost from './components/Undo.jsx';

import Dashboard from './pages/Dashboard.jsx';
import Listings from './pages/Listings.jsx';
import Skus from './pages/Skus.jsx';
import Orders from './pages/Orders.jsx';
import Tracking from './pages/Tracking.jsx';
import AiStudio from './pages/AiStudio.jsx';
import Prompts from './pages/Prompts.jsx';
import Research from './pages/Research.jsx';
import BulkJobs from './pages/BulkJobs.jsx';
import Exports from './pages/Exports.jsx';
import Airtable from './pages/Airtable.jsx';
import Analytics from './pages/Analytics.jsx';
import Drafts from './pages/Drafts.jsx';
import Supply from './pages/Supply.jsx';
import ShopSettings from './pages/ShopSettings.jsx';
import Settings from './pages/Settings.jsx';
import ApiExplorer from './pages/ApiExplorer.jsx';
import NewListing from './pages/NewListing.jsx';

const NAV = [
  {
    label: 'Overview',
    items: [
      { to: '/', icon: '◆', label: 'Dashboard', end: true },
      { to: '/analytics', icon: '📈', label: 'Shop data' },
    ],
  },
  {
    label: 'Catalogue',
    items: [
      { to: '/listings', icon: '▤', label: 'Listings', badge: 'listings' },
      { to: '/skus', icon: '⧉', label: 'SKUs & variations', badge: 'missingSku', badgeKind: 'muted' },
      { to: '/listings/new', icon: '＋', label: 'Create listing' },
      { to: '/drafts', icon: '✎', label: 'Draft desk' },
      { to: '/supply', icon: '🛒', label: 'Supply book' },
      { to: '/research', icon: '◎', label: 'Product research' },
    ],
  },
  {
    label: 'Fulfilment',
    items: [
      { to: '/orders', icon: '▣', label: 'Orders', badge: 'newOrders' },
      { to: '/tracking', icon: '➤', label: 'Tracking', badge: 'alerts', badgeKind: 'alert' },
      { to: '/exports', icon: '⤓', label: 'Excel exports' },
      { to: '/airtable', icon: '⇉', label: 'Airtable sync' },
    ],
  },
  {
    label: 'AI',
    items: [
      { to: '/ai', icon: '✦', label: 'AI studio' },
      { to: '/prompts', icon: '❝', label: 'Prompt library' },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/jobs', icon: '⚙', label: 'Bulk jobs' },
      { to: '/shop', icon: '🏬', label: 'Shop settings' },
      { to: '/api-explorer', icon: '⌘', label: 'API explorer' },
      { to: '/settings', icon: '⚒', label: 'Settings' },
    ],
  },
];

/** Sidebar shop selector. Several Etsy shops can be connected; exactly one is
 *  active, and everything on screen belongs to that shop. */
function ShopSwitcher({ summary, onSwitched }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const showError = useErrorToast();
  const accounts = summary?.accounts ?? [];
  const active = accounts.find((a) => a.isActive);

  const switchTo = async (shopId) => {
    setBusy(true);
    try {
      await api.post(`/auth/accounts/${shopId}/activate`, {});
      const next = accounts.find((a) => a.shopId === shopId);
      toast({ kind: 'ok', title: `Switched to ${next?.label || next?.shopName || shopId}` });
      setOpen(false);
      onSwitched();
    } catch (err) { showError(err, 'Could not switch shop'); } finally { setBusy(false); }
  };

  if (!accounts.length) {
    return (
      <div className="shop-chip">
        <span className="dot off" />
        <span className="muted">No shop connected</span>
      </div>
    );
  }

  return (
    <div className="shop-switch">
      <button className="shop-chip as-button" onClick={() => setOpen((v) => !v)} disabled={busy}>
        <span className="dot on" />
        <span className="shop-name">{active?.label || active?.shopName || `Shop ${active?.shopId}`}</span>
        {accounts.length > 1 && <span className="shop-count">{accounts.length}</span>}
        <span className="caret">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="shop-menu">
          {accounts.map((a) => (
            <button key={a.shopId} className={`shop-option ${a.isActive ? 'active' : ''}`}
                    onClick={() => switchTo(a.shopId)} disabled={busy || a.isActive}>
              <span className={`dot ${a.isActive ? 'on' : 'idle'}`} />
              <span>
                <span className="shop-option-name">{a.label || a.shopName || `Shop ${a.shopId}`}</span>
                <span className="shop-option-id">{a.shopId}</span>
              </span>
            </button>
          ))}
          <NavLink to="/settings" className="shop-option add" onClick={() => setOpen(false)}>
            <span className="ico">＋</span> Connect another shop
          </NavLink>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [summary, setSummary] = useState(null);
  const location = useLocation();

  const refresh = useCallback(async () => {
    try { setSummary(await api.dashboard()); } catch { /* offline or not connected yet */ }
  }, []);

  useEffect(() => { refresh(); }, [refresh, location.pathname]);
  useEffect(() => {
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  const counts = {
    listings: summary?.listings?.total || 0,
    missingSku: summary?.listings?.missingSku || 0,
    newOrders: summary?.orders?.newOrders || 0,
    alerts: summary?.tracking?.alerts || 0,
  };

  return (
    <ToastHost>
      <div className="app">
        <nav className="sidebar">
          <div className="brand">
            <div className="brand-mark">E</div>
            <div>
              <div className="brand-name">Command Center</div>
              <div className="brand-sub">Etsy Open API v3</div>
            </div>
          </div>

          <ShopSwitcher summary={summary} onSwitched={refresh} />

          <UndoHost />

          <div className="nav">
            {NAV.map((group) => (
              <div className="nav-group" key={group.label}>
                <div className="nav-label">{group.label}</div>
                {group.items.map((item) => {
                  const count = item.badge ? counts[item.badge] : 0;
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.end}
                      className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                    >
                      <span className="ico">{item.icon}</span>
                      <span>{item.label}</span>
                      {count > 0 && <span className={`nav-badge ${item.badgeKind ?? ''}`}>{count > 999 ? '999+' : count}</span>}
                    </NavLink>
                  );
                })}
              </div>
            ))}
          </div>
        </nav>

        <main className="main">
          <Routes>
            <Route path="/" element={<Dashboard summary={summary} onRefresh={refresh} />} />
            <Route path="/listings" element={<Listings />} />
            <Route path="/listings/new" element={<NewListing />} />
            <Route path="/skus" element={<Skus />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/tracking" element={<Tracking />} />
            <Route path="/ai" element={<AiStudio />} />
            <Route path="/prompts" element={<Prompts />} />
            <Route path="/research" element={<Research />} />
            <Route path="/jobs" element={<BulkJobs />} />
            <Route path="/exports" element={<Exports />} />
            <Route path="/airtable" element={<Airtable />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/drafts" element={<Drafts />} />
            <Route path="/supply" element={<Supply />} />
            <Route path="/shop" element={<ShopSettings />} />
            <Route path="/api-explorer" element={<ApiExplorer />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </ToastHost>
  );
}
