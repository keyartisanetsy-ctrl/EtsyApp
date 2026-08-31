/** Thin fetch wrapper. Every error surfaces the server's message and, when
 *  Etsy rejected the call, the upstream body too. */
class ApiError extends Error {
  constructor(status, message, payload) {
    super(message);
    this.status = status;
    this.details = payload?.details;
    this.etsy = payload?.etsy;
    this.operationId = payload?.operationId;
  }
}

async function request(path, { method = 'GET', body, formData, signal } = {}) {
  const options = { method, signal, headers: {} };
  if (formData) options.body = formData;
  else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const res = await fetch(`/api${path}`, options);
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }

  if (!res.ok) {
    throw new ApiError(res.status, payload?.error || res.statusText || 'Request failed', payload);
  }
  return payload;
}

const qs = (params = {}) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    s.append(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const str = s.toString();
  return str ? `?${str}` : '';
};

export const api = {
  ApiError,
  get: (p, params) => request(p + qs(params)),
  post: (p, body) => request(p, { method: 'POST', body }),
  put: (p, body) => request(p, { method: 'PUT', body }),
  patch: (p, body) => request(p, { method: 'PATCH', body }),
  del: (p, body) => request(p, { method: 'DELETE', body }),
  upload: (p, formData) => request(p, { method: 'POST', formData }),

  health: () => request('/health'),
  dashboard: () => request('/dashboard'),
  syncAll: (body) => request('/dashboard/sync', { method: 'POST', body }),
  syncListings: (body) => request('/dashboard/sync/listings', { method: 'POST', body }),
};

export default api;
