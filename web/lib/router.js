import { useEffect, useState } from "./html.js";

/**
 * History-API routing. Paths name views (/jobs, /runs); the query string holds
 * filters and the open record (?job=..., ?run=...), so every state can be
 * bookmarked and Back/Forward behave.
 */

const listeners = new Set();

function snapshot() {
  return { path: window.location.pathname, query: new URLSearchParams(window.location.search) };
}

function notify() {
  const location = snapshot();
  for (const listener of listeners) listener(location);
}

window.addEventListener("popstate", notify);

export function navigate(href, { replace = false } = {}) {
  const url = new URL(href, window.location.origin);
  if (url.origin !== window.location.origin) {
    window.location.assign(href);
    return;
  }
  const next = `${url.pathname}${url.search}`;
  if (next === `${window.location.pathname}${window.location.search}`) return;
  window.history[replace ? "replaceState" : "pushState"]({}, "", next);
  notify();
}

/** Rewrites query parameters; empty values are removed. Lists are joined with commas. */
export function setQuery(updates, { replace = true } = {}) {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(updates)) {
    const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
    if (empty) params.delete(key);
    else params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const search = params.toString();
  navigate(`${window.location.pathname}${search ? `?${search}` : ""}`, { replace });
}

export function useLocation() {
  const [location, setLocation] = useState(snapshot);
  useEffect(() => {
    listeners.add(setLocation);
    return () => listeners.delete(setLocation);
  }, []);
  return location;
}

/** A comma-separated query parameter as a list. */
export function listParam(query, key) {
  const raw = query.get(key);
  return raw ? raw.split(",").map((part) => part.trim()).filter(Boolean) : [];
}

// Same-origin links navigate in place; new tabs, downloads and the API are left alone.
document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
  const url = new URL(anchor.href, window.location.origin);
  if (url.origin !== window.location.origin || url.pathname.startsWith("/api/")) return;
  event.preventDefault();
  navigate(`${url.pathname}${url.search}`);
});
