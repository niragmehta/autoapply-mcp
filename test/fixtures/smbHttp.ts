import { vi } from "vitest";

/**
 * Stubbed `fetch` for SMB adapter tests: each request is answered by the
 * longest string route the URL starts with, else the first matching RegExp.
 * Unmatched requests answer 404, so a test can never reach the network.
 */

export type Handler = Response | ((url: URL, init?: RequestInit) => Response | Promise<Response>);

export function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

export function text(body: string, status = 200, type = "text/html"): Response {
  return new Response(body, { status, headers: { "content-type": type } });
}

export function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

export function failure(): never {
  throw new TypeError("fetch failed");
}

export type Call = { url: string; init?: RequestInit };

export function stubRoutes(routes: ReadonlyArray<[string | RegExp, Handler]>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, init });
    const prefixes = routes.filter(([key]) => typeof key === "string" && url.href.startsWith(key))
      .sort(([a], [b]) => String(b).length - String(a).length);
    const route = prefixes[0] ?? routes.find(([key]) => key instanceof RegExp && key.test(url.href));
    if (!route) return text("not found", 404);
    const handler = route[1];
    return typeof handler === "function" ? handler(url, init) : handler.clone();
  }));
  return calls;
}

export function jobPostingLd(posting: Record<string, unknown>): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org/", "@type": "JobPosting", ...posting,
  })}</script></head><body></body></html>`;
}
