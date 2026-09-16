import React, { useState } from 'react';
import api from '../lib/api.js';

/** Shown instead of the app when APP_PASSWORD is set and this browser
 *  hasn't unlocked it yet. Posts to /api/login, which sets the cookie
 *  every other request checks. */
export default function Login({ onSuccess }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/login', { password });
      onSuccess();
    } catch (err) {
      setError(err.message || 'Wrong password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
      <form className="card" onSubmit={submit} style={{ width: 320 }}>
        <div className="card-head"><h2>Locked</h2></div>
        <div className="field">
          <label htmlFor="app-password">Password</label>
          <input
            id="app-password"
            type="password"
            className="input"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: '100%' }}
          />
          {error && <div className="hint" style={{ color: 'var(--bad)' }}>{error}</div>}
        </div>
        <button type="submit" className="btn primary" disabled={busy} style={{ width: '100%', marginTop: 10 }}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}
