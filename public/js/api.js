/**
 * api.js — the single choke point for talking to the backend.
 *
 * Owns the auth token (previously a loose global in app.js) and the fetch
 * wrapper. On a 401 it calls a caller-registered handler so app logic (logout,
 * redirect) stays out of here.
 */

const API_BASE = window.location.origin;

let authToken = localStorage.getItem('authToken');
let onUnauthorized = () => {};

/** @returns {string|null} the current bearer token, if any. */
export function getToken() {
  return authToken;
}

/**
 * Set (or clear) the auth token and mirror it to localStorage.
 * @param {string|null} token
 */
export function setToken(token) {
  authToken = token || null;
  if (authToken) localStorage.setItem('authToken', authToken);
  else localStorage.removeItem('authToken');
}

/**
 * Register the callback invoked when the API returns 401 (expired/invalid token).
 * @param {() => void} fn
 */
export function setUnauthorizedHandler(fn) {
  onUnauthorized = typeof fn === 'function' ? fn : () => {};
}

/**
 * Fetch wrapper: attaches JSON headers + bearer token, throws on non-2xx, and
 * returns parsed JSON when the response is JSON (otherwise undefined).
 * @param {string} endpoint path beginning with `/`
 * @param {RequestInit} [options]
 * @returns {Promise<any>}
 */
export async function apiCall(endpoint, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const response = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
  if (!response.ok) {
    if (response.status === 401) onUnauthorized();
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Request failed');
  }
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.indexOf('application/json') !== -1) return response.json();
}
