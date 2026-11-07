import { userAgent } from "../sources/http.js";
import { AppError, toErrorMessage } from "../util/errors.js";
import { assertPublicHost } from "../util/netGuard.js";

/**
 * Reads one posting page for a liveness verdict or a pasted URL.
 *
 * The shared ATS client returns only a body, but a closed posting is often
 * recognisable only by where it redirects (Greenhouse sends a removed posting to
 * its board index with `?error=true`). So redirects are followed by hand, each
 * hop is checked, and the caller gets the status and the final URL as well as
 * the page. Same politeness as the ATS client: an honest User-Agent, a per-host
 * interval, a timeout and a size cap.
 *
 * Hosts are restricted to public names over HTTPS. A pasted or redirected URL
 * must never make this local server request an address on the candidate's own
 * network.
 */

export type FetchedPage = {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  redirects: string[];
  contentType: string;
  /** Raw body, truncated at the size cap. */
  body: string;
};

export type PageFetchOptions = { timeoutMs?: number; maxBytes?: number };

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024;

const lastRequestByHost = new Map<string, number>();

function minIntervalMs(): number {
  const raw = Number.parseInt(process.env.AUTOAPPLY_MIN_INTERVAL_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 700;
}

async function throttle(host: string): Promise<void> {
  const wait = (lastRequestByHost.get(host) ?? 0) + minIntervalMs() - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestByHost.set(host, Date.now());
}

const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];

/** True for names that resolve inside the candidate's own network rather than to a public site. */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || !host.includes(".")) return true;
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  // Postings live on names, never on bare addresses, so every IP literal is refused.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  return host.startsWith("[") || host.includes(":");
}

/** Validates a URL this server may fetch: HTTPS, a public host, no credentials, the default port. */
export function assertPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AppError("invalid_url", `not a valid URL: ${raw.slice(0, 200)}`);
  }
  if (url.protocol !== "https:") throw new AppError("insecure_url", "only https:// posting URLs are fetched");
  if (url.username || url.password) throw new AppError("unsafe_url", "posting URLs must not carry credentials");
  if (url.port && url.port !== "443") throw new AppError("unsafe_url", "posting URLs must use the default HTTPS port");
  if (isPrivateHostname(url.hostname)) {
    throw new AppError("private_host", `refusing to fetch ${url.hostname}: not a public host`);
  }
  return url;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let bytes = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return text + decoder.decode();
    const room = maxBytes - bytes;
    if (chunk.value.byteLength >= room) {
      // The opening of a page carries its title, status banner and metadata,
      // so a truncated body is still enough to classify.
      await reader.cancel();
      return text + decoder.decode(chunk.value.subarray(0, room));
    }
    bytes += chunk.value.byteLength;
    text += decoder.decode(chunk.value, { stream: true });
  }
}

export async function fetchPostingPage(rawUrl: string, options: PageFetchOptions = {}): Promise<FetchedPage> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const requested = assertPublicHttpsUrl(rawUrl);
  let current = requested;
  const redirects: string[] = [];

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(current.hostname);
    await throttle(current.host);
    let response: Response;
    try {
      response = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "user-agent": userAgent(),
          accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
        },
      });
    } catch (error) {
      throw new AppError("network_error", `request to ${current.host} failed: ${toErrorMessage(error)}`);
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new AppError("invalid_redirect", `${current.host} redirected without a Location header`);
      if (hop === MAX_REDIRECTS) throw new AppError("redirect_limit", "posting exceeded the permitted redirect count");
      current = assertPublicHttpsUrl(new URL(location, current).toString());
      redirects.push(current.toString());
      continue;
    }

    return {
      requestedUrl: requested.toString(),
      finalUrl: current.toString(),
      status: response.status,
      redirects,
      contentType: response.headers.get("content-type") ?? "",
      body: await readCapped(response, maxBytes),
    };
  }
  throw new AppError("redirect_limit", "posting exceeded the permitted redirect count");
}
