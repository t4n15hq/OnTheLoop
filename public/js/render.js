/**
 * render.js — the ONE place that touches the DOM for dynamic content.
 *
 * Route every API/user-supplied value through `el()` + text nodes (or
 * `escapeHtml`) so no untrusted string is ever parsed as HTML. This is the
 * groundwork that lets the app drop `'unsafe-inline'` from the script CSP
 * (see issue #2): there are no inline handlers and no string-built markup
 * that mixes in raw user data.
 */

/* ================= DEBUG ================= */
// Gate noisy debug logging to local development only.
export const DEBUG =
  location.hostname === 'localhost' || location.hostname === '127.0.0.1';
export const log = (...args) => { if (DEBUG) console.log(...args); };

/* ================= ESCAPING ================= */
/**
 * Escape a value for safe interpolation into HTML text/markup.
 * @param {unknown} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Escape a value for safe interpolation into a double-quoted HTML attribute.
 * @param {unknown} s
 * @returns {string}
 */
export function escapeAttr(s) {
  return String(s ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/* ================= SAFE DOM BUILDERS ================= */
/**
 * Build a DOM element. Attributes are set via setAttribute (never innerHTML),
 * and children that aren't Nodes are appended as text nodes — so any dynamic
 * value passed as a child is inert HTML-wise.
 *
 * @param {string} tag
 * @param {Record<string, string>} [props] `class` maps to className; everything
 *   else is a plain attribute. Skips null/undefined values.
 * @param {...(Node|string|number)} kids
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else n.setAttribute(k, String(v));
  }
  for (const kid of kids) {
    if (kid == null) continue;
    n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

/**
 * A standalone text node — useful as an explicit, self-documenting child.
 * @param {unknown} s
 * @returns {Text}
 */
export function text(s) {
  return document.createTextNode(String(s ?? ''));
}

/**
 * Replace a `<select>`'s options from a list of {value, label} pairs, using
 * text nodes for labels so API-supplied names (stop/station names) can't inject
 * markup.
 * @param {HTMLSelectElement} select
 * @param {Array<{value: string, label: string}>} items
 */
export function setOptions(select, items) {
  select.replaceChildren(...items.map((it) => el('option', { value: it.value }, it.label)));
}
