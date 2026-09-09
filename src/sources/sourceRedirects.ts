import { AppError } from "../util/errors.js";

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function assertSourceUrl(raw: string, allowedHosts: readonly string[]): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new AppError("unsafe_source_url", "source URLs must use HTTPS without credentials or custom ports");
  }
  if (!allowedHosts.some((host) => host.toLowerCase() === url.hostname.toLowerCase())) {
    throw new AppError("source_host_not_allowed", `source host "${url.hostname}" is not permitted`);
  }
  return url;
}

/** Validate each redirect before any request, including before sending API credentials. */
export async function fetchSourceResponse(
  rawUrl: string,
  init: RequestInit,
  allowedHosts?: readonly string[],
  customHeaderNames: readonly string[] = [],
): Promise<Response> {
  if (!allowedHosts) return fetch(rawUrl, { ...init, redirect: "follow" });
  let url = assertSourceUrl(rawUrl, allowedHosts);
  let request = { ...init, redirect: "manual" as const };
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(url.toString(), request);
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await response.body?.cancel();
    if (redirects === MAX_REDIRECTS) {
      throw new AppError("redirect_limit", "source exceeded the permitted redirect count");
    }
    const location = response.headers.get("location");
    if (!location) throw new AppError("invalid_redirect", "source redirect has no Location header");
    const next = assertSourceUrl(new URL(location, url).toString(), allowedHosts);
    const headers = new Headers(request.headers);
    if (next.origin !== url.origin) {
      for (const name of [...customHeaderNames, "authorization", "cookie", "proxy-authorization"]) headers.delete(name);
    }
    const useGet = response.status === 303 || ([301, 302].includes(response.status) && request.method === "POST");
    if (useGet) headers.delete("content-type");
    request = { ...request, headers, ...(useGet ? { method: "GET", body: undefined } : {}) };
    url = next;
  }
  throw new AppError("redirect_limit", "source exceeded the permitted redirect count");
}
