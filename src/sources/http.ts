import { AppError } from "../util/errors.js";
import { logger } from "../util/logger.js";

/**
 * Polite HTTP client for public ATS endpoints.
 *
 * Enforces a per-host minimum interval, bounded retries with backoff, request
 * timeouts and a response size cap. Identifies itself honestly via User-Agent.
 */

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;

/**
 * Response size cap. Greenhouse boards with thousands of postings return tens
 * of megabytes when full descriptions are requested, so the ceiling has to be
 * generous while still bounded.
 */
function defaultMaxBytes(): number {
  const raw = Number.parseInt(process.env.AUTOAPPLY_MAX_RESPONSE_MB ?? "", 10);
  const megabytes = Number.isFinite(raw) && raw > 0 ? raw : 64;
  return megabytes * 1024 * 1024;
}

/** Per-host politeness interval; override for tests or slower crawling. */
function defaultMinIntervalMs(): number {
  const raw = Number.parseInt(process.env.AUTOAPPLY_MIN_INTERVAL_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 700;
}

const lastRequestByHost = new Map<string, number>();

export function userAgent(): string {
  return (
    process.env.AUTOAPPLY_USER_AGENT ??
    "autoapply-mcp/0.1 (+https://github.com/autoapply-mcp; personal job-search client)"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle(host: string, minIntervalMs: number): Promise<void> {
  const last = lastRequestByHost.get(host) ?? 0;
  const wait = last + minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestByHost.set(host, Date.now());
}

export type FetchJsonOptions = {
  timeoutMs?: number;
  retries?: number;
  minIntervalMs?: number;
  maxBytes?: number;
  accept?: string;
};

/** Fetches JSON with throttling, retries and hard limits. */
export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const maxBytes = options.maxBytes ?? defaultMaxBytes();
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new AppError("insecure_url", `refusing to fetch non-HTTPS url: ${url}`);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await throttle(parsed.host, options.minIntervalMs ?? defaultMinIntervalMs());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          accept: options.accept ?? "application/json",
          "user-agent": userAgent(),
          "accept-language": "en-US,en;q=0.9",
        },
      });

      if (response.status === 404) {
        throw new AppError("not_found", `board not found (404): ${url}`, { url });
      }
      if (response.status === 429 || response.status >= 500) {
        throw new AppError("retryable_http", `HTTP ${response.status} from ${parsed.host}`, { status: response.status });
      }
      if (!response.ok) {
        throw new AppError("http_error", `HTTP ${response.status} from ${parsed.host}`, { status: response.status });
      }

      const text = await readCapped(response, maxBytes);
      return JSON.parse(text) as T;
    } catch (error) {
      lastError = error;
      const retryable = error instanceof AppError ? error.code === "retryable_http" : true;
      const isLast = attempt === retries;
      if (!retryable || isLast) break;
      const backoff = 800 * 2 ** attempt + Math.floor(Math.random() * 400);
      logger.warn("http retry", { url: parsed.host, attempt: attempt + 1, backoff });
      await sleep(backoff);
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastError instanceof AppError) throw lastError;
  throw new AppError("network_error", `request failed: ${String(lastError)}`, { url });
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new AppError("response_too_large", `response exceeded ${maxBytes} bytes`);
  }
  return new TextDecoder("utf-8").decode(buffer);
}

/** Probes a URL and reports whether it resolves, used by board discovery. */
export async function probeJson(url: string): Promise<{ ok: boolean; status: string }> {
  try {
    await fetchJson<unknown>(url, { retries: 0, timeoutMs: 12_000 });
    return { ok: true, status: "ok" };
  } catch (error) {
    return { ok: false, status: error instanceof AppError ? error.code : "error" };
  }
}
