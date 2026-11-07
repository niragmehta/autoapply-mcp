import { createContext, useContext } from "./html.js";

/**
 * App-wide state: the campaign status (polled once for the whole app, shared
 * by the header badges and the Overview), the filter enumerations from
 * /api/meta, and transient toasts.
 */

export const StatusContext = createContext({ data: undefined, error: null, loading: true, reload: () => {} });
export const MetaContext = createContext({ data: undefined, error: null, loading: true, reload: () => {} });

export function useStatus() {
  return useContext(StatusContext);
}

export function useMeta() {
  return useContext(MetaContext);
}

let toasts = [];
let nextToastId = 1;
const toastListeners = new Set();

function publish() {
  for (const listener of toastListeners) listener(toasts);
}

/** Shows a short message. `tone: "bad"` for failures; `href` adds a link. */
export function toast(message, { tone = "ok", href, linkText, timeout = 6000 } = {}) {
  const id = nextToastId++;
  toasts = [...toasts, { id, message, tone, href, linkText }];
  publish();
  setTimeout(() => dismissToast(id), tone === "bad" ? timeout * 2 : timeout);
  return id;
}

export function dismissToast(id) {
  toasts = toasts.filter((entry) => entry.id !== id);
  publish();
}

export function subscribeToasts(listener) {
  toastListeners.add(listener);
  listener(toasts);
  return () => toastListeners.delete(listener);
}
