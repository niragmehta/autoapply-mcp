import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { AppError } from "../util/errors.js";

/**
 * The dashboard's security model.
 *
 * It listens on loopback only and every API call needs a per-start secret:
 * either the session cookie set by visiting the printed `/?token=` link, or an
 * `Authorization: Bearer` header. Host headers are checked so a DNS-rebinding
 * page cannot reach the server under its own name, and state-changing requests
 * authenticated by cookie must carry a matching Origin, so another site cannot
 * forge them. The cookie is SameSite=Strict as a second layer.
 */

export const DEFAULT_PORT = 4317;
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1"]);
export const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

const TOKEN_SHAPE = /^[A-Za-z0-9._~-]{24,512}$/;

/** The explicit token, AUTOAPPLY_DASHBOARD_TOKEN, or a fresh random 32-byte one. */
export function resolveToken(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const chosen = explicit ?? (env.AUTOAPPLY_DASHBOARD_TOKEN?.trim() || undefined);
  if (chosen === undefined) return randomBytes(32).toString("base64url");
  if (!TOKEN_SHAPE.test(chosen)) {
    throw new AppError(
      "invalid_dashboard_token",
      "the dashboard token must be 24-512 characters of letters, digits, '.', '_', '~' or '-'",
    );
  }
  return chosen;
}

/** Constant-time comparison; hashing first makes the lengths equal. */
export function tokensEqual(supplied: string, expected: string): boolean {
  const a = createHash("sha256").update(supplied, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Cookies are not port-scoped, so the name carries the port to keep two dashboards apart. */
export function cookieName(port: number): string {
  return `autoapply_dash_${port}`;
}

export function sessionCookie(port: number, token: string): string {
  return `${cookieName(port)}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return cookies;
}

export function allowedHosts(port: number): ReadonlySet<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

export function allowedOrigins(port: number): ReadonlySet<string> {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
}

export function isAllowedHost(header: string | undefined, port: number): boolean {
  return header !== undefined && allowedHosts(port).has(header.trim().toLowerCase());
}

export type AuthMethod = "cookie" | "bearer";

export type AuthResult = { method: AuthMethod | null; presented: boolean };

/** Which credential authenticated the request, and whether a wrong one was offered. */
export function authenticate(headers: IncomingHttpHeaders, token: string, port: number): AuthResult {
  const authorization = headers.authorization;
  if (typeof authorization === "string" && /^Bearer\s+/i.test(authorization)) {
    const supplied = authorization.replace(/^Bearer\s+/i, "").trim();
    return { method: tokensEqual(supplied, token) ? "bearer" : null, presented: true };
  }
  const cookie = parseCookies(headers.cookie).get(cookieName(port));
  if (cookie !== undefined) return { method: tokensEqual(cookie, token) ? "cookie" : null, presented: true };
  return { method: null, presented: false };
}

/**
 * Whether a state-changing request may proceed. Cookie-authenticated requests
 * come from a browser and must name this origin; a bearer request is not
 * forgeable cross-site, but if it names an origin, that origin must be ours.
 */
export function originAllowed(method: string, origin: string | undefined, auth: AuthMethod, port: number): boolean {
  if (SAFE_METHODS.has(method)) return true;
  if (origin === undefined) return auth === "bearer";
  return allowedOrigins(port).has(origin.trim().toLowerCase());
}

/** Throttles wrong tokens so a local process cannot grind through guesses. */
export class FailedAuthLimiter {
  private failures: number[] = [];
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max = 30, windowMs = 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }

  record(now = Date.now()): void {
    this.failures = [...this.failures.filter((at) => now - at < this.windowMs), now];
  }

  blocked(now = Date.now()): boolean {
    return this.failures.filter((at) => now - at < this.windowMs).length >= this.max;
  }
}

/** Response headers applied to everything the dashboard serves. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/**
 * No inline script runs. The one inline block is the import map, which is
 * data rather than code; it is allowed by its exact hash.
 */
export function contentSecurityPolicy(scriptHashes: readonly string[] = []): string {
  const scripts = ["'self'", ...scriptHashes.map((hash) => `'${hash}'`)].join(" ");
  return [
    "default-src 'self'",
    `script-src ${scripts}`,
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
