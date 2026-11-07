/**
 * The JSON API. Every call is same-origin with the session cookie; state
 * changes are JSON (which the server requires, and which a cross-site form
 * cannot send). A 401 anywhere signs the whole app out.
 */

export class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function queryString(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

async function request(method, path, { query, body, signal } = {}) {
  let response;
  try {
    response = await fetch(`${path}${queryString(query)}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new ApiError(0, "offline", "The dashboard server is not responding. Is npm run dashboard still running?");
  }
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (response.status === 401) window.dispatchEvent(new CustomEvent("autoapply:signed-out"));
  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(response.status, error.code ?? "http_error", error.message ?? `Request failed (${response.status})`, error);
  }
  return payload;
}

export const api = {
  get: (path, query, options = {}) => request("GET", path, { ...options, query }),
  post: (path, body = {}) => request("POST", path, { body }),
  patch: (path, body = {}) => request("PATCH", path, { body }),
  del: (path) => request("DELETE", path, { body: {} }),
};

/** Server-sent events for one run; returns a function that closes the stream. */
export function followRun(runId, handlers, afterSeq = 0) {
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events${afterSeq ? `?afterSeq=${afterSeq}` : ""}`);
  const on = (event, handler) => {
    source.addEventListener(event, (message) => {
      try {
        handler(JSON.parse(message.data));
      } catch {
        // A malformed frame is skipped; the next one carries full state again.
      }
    });
  };
  on("log", (line) => handlers.log?.(line));
  on("progress", (progress) => handlers.progress?.(progress));
  on("run", (run) => handlers.run?.(run));
  on("end", (end) => {
    source.close();
    handlers.end?.(end);
  });
  source.onerror = () => handlers.error?.();
  return () => source.close();
}

export function artifactUrl(name) {
  return `/api/artifacts/${encodeURIComponent(name)}`;
}
