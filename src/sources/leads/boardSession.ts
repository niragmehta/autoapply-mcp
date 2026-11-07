import { AppError } from "../../util/errors.js";
import { userAgent } from "../http.js";
import { fetchSourceResponse } from "../sourceRedirects.js";

/**
 * Fetches a board page together with the anonymous session cookies it sets.
 *
 * `http.ts` returns response bodies only, and Consider's search endpoint
 * accepts a request only with the session cookie and CSRF token its own page
 * hands every visitor. This single GET is therefore made here, with the same
 * guarantees: host allowlist, HTTPS and per-redirect checks
 * (`fetchSourceResponse`), the honest User-Agent, a timeout, a size cap and a
 * per-host interval. It does not retry; a failed handshake fails the search.
 */

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MIN_INTERVAL_MS = 700;
let lastRequestAt = new Map<string, number>();

async function pause(host: string): Promise<void> {
  const wait = (lastRequestAt.get(host) ?? 0) + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = new Map([...lastRequestAt, [host, Date.now()]]);
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let bytes = 0;
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return text + decoder.decode();
    bytes += chunk.value.byteLength;
    if (bytes > MAX_BYTES) {
      await reader.cancel();
      throw new AppError("response_too_large", `board page exceeded ${MAX_BYTES} bytes`);
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
}

export async function fetchPageWithSession(url: string, host: string): Promise<{ html: string; cookie: string }> {
  await pause(host);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchSourceResponse(url, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "text/html", "user-agent": userAgent(), "accept-language": "en-US,en;q=0.9" },
    }, [host]);
    if (response.status === 404) throw new AppError("not_found", `board page not found (404): ${host}`);
    if (!response.ok) throw new AppError("http_error", `HTTP ${response.status} from ${host}`, { status: response.status });
    const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]?.trim() ?? "").filter(Boolean).join("; ");
    return { html: await readCapped(response), cookie };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("network_error", `board page request failed: ${String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}
