import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Workspace } from "../config/load.js";
import { getRunQueue } from "../runner/index.js";
import type { RunQueue } from "../runner/queue.js";
import { freshWorkspace } from "../runner/workspace.js";
import { AppError, toErrorMessage } from "../util/errors.js";
import { nowIso } from "../util/hash.js";
import { logger } from "../util/logger.js";
import { registerApiRoutes } from "./api/index.js";
import type { DashboardContext } from "./context.js";
import { DownloadReply, FileReply, HttpError, JsonReply, Router, STREAMED, errorResponse, safeDownloadName, type ApiRequest } from "./router.js";
import {
  DEFAULT_PORT,
  FailedAuthLimiter,
  LOOPBACK_HOSTS,
  SECURITY_HEADERS,
  authenticate,
  contentSecurityPolicy,
  isAllowedHost,
  originAllowed,
  resolveToken,
  sessionCookie,
  tokensEqual,
} from "./security.js";
import { importMapHash, loadStaticSite, readText, resolveStatic, type StaticSite } from "./static.js";

/**
 * The local dashboard: a JSON API over the same services the MCP tools use,
 * the run queue's live logs, and the static browser app in `web/`.
 * node:http only; see security.ts for the threat model.
 */

export type DashboardOptions = {
  port?: number;
  host?: string;
  /** Defaults to AUTOAPPLY_DASHBOARD_TOKEN, else a random 32-byte token. */
  token?: string;
  /** Defaults to the process-wide queue. */
  queue?: RunQueue;
  workspace?: () => Workspace;
  webRoot?: string;
  bodyLimitBytes?: number;
};

export type DashboardHandle = {
  readonly url: string;
  /** Opening this once signs the browser in. Contains the token: print it, never log it. */
  readonly loginUrl: string;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly server: Server;
  close(): Promise<void>;
};

const DEFAULT_BODY_LIMIT = 256 * 1024;
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function packageVersion(): string {
  try {
    const path = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return String((JSON.parse(readFileSync(path, "utf8")) as { version?: unknown }).version ?? "unknown");
  } catch {
    return "unknown";
  }
}

function applySecurityHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  res.setHeader("Content-Security-Policy", contentSecurityPolicy());
}

function sendJson(res: ServerResponse, status: number, body: unknown, method = "GET"): void {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(method === "HEAD" ? undefined : text);
}

function sendText(res: ServerResponse, status: number, text: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function sendFile(res: ServerResponse, path: string, contentType: string, method: string, extra: Record<string, string> = {}): void {
  const size = statSync(path).size;
  res.writeHead(200, { "Content-Type": contentType, "Content-Length": size, ...extra });
  if (method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(path)
    .on("error", () => res.destroy())
    .pipe(res);
}

async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const tooLarge = () => new HttpError(413, "body_too_large", `request bodies are limited to ${limit} bytes`);
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    // Drain rather than reset, so the client gets to read the 413.
    req.resume();
    throw tooLarge();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size <= limit) chunks.push(buffer);
  }
  if (size > limit) throw tooLarge();
  if (size === 0) return undefined;
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
    throw new HttpError(415, "unsupported_media_type", "send JSON with Content-Type: application/json");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "the request body is not valid JSON");
  }
}

const LOGIN_FAILED_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Sign-in link not valid</title>
<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.25rem">This dashboard link is not valid</h1>
<p>The token changes every time the dashboard starts. Open the link printed by <code>npm run dashboard</code> in its terminal.</p>
</body></html>`;

type ServerState = {
  token: string;
  port: number;
  router: Router;
  site: StaticSite;
  ctx: DashboardContext;
  limiter: FailedAuthLimiter;
  bodyLimit: number;
};

function handleLogin(state: ServerState, url: URL, res: ServerResponse): void {
  const supplied = url.searchParams.get("token") ?? "";
  if (!tokensEqual(supplied, state.token)) {
    if (state.limiter.blocked()) return sendText(res, 429, "Too many attempts; wait a minute.");
    state.limiter.record();
    return sendText(res, 401, LOGIN_FAILED_PAGE, "text/html; charset=utf-8");
  }
  const rest = new URLSearchParams(url.searchParams);
  rest.delete("token");
  const query = rest.toString();
  res.writeHead(303, {
    "Set-Cookie": sessionCookie(state.port, state.token),
    Location: `${url.pathname}${query ? `?${query}` : ""}`,
    "Cache-Control": "no-store",
  });
  res.end();
}

function serveStaticFile(state: ServerState, pathname: string, method: string, res: ServerResponse): void {
  const file = resolveStatic(state.site, pathname);
  if (!file) return sendText(res, 404, "Not found");
  if (file.path.endsWith("index.html")) {
    const html = readText(file.path);
    const hash = importMapHash(html);
    res.setHeader("Content-Security-Policy", contentSecurityPolicy(hash ? [hash] : []));
    res.writeHead(200, { "Content-Type": file.contentType, "Cache-Control": "no-cache", "Content-Length": Buffer.byteLength(html) });
    res.end(method === "HEAD" ? undefined : html);
    return;
  }
  sendFile(res, file.path, file.contentType, method, { "Cache-Control": "no-cache" });
}

async function handleApi(state: ServerState, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const auth = authenticate(req.headers, state.token, state.port);
  if (auth.method === null) {
    if (state.limiter.blocked()) {
      return sendJson(res, 429, { error: { code: "too_many_attempts", message: "Too many failed sign-ins; wait a minute." } });
    }
    if (auth.presented) state.limiter.record();
    return sendJson(res, 401, {
      error: { code: "unauthorized", message: "Not signed in. Open the link printed by npm run dashboard." },
    });
  }
  if (!originAllowed(method, req.headers.origin, auth.method, state.port)) {
    return sendJson(res, 403, { error: { code: "bad_origin", message: "Cross-origin requests are refused." } });
  }

  const match = state.router.match(method, url.pathname);
  if (match.kind === "not_found") return sendJson(res, 404, { error: { code: "not_found", message: `no endpoint ${url.pathname}` } });
  if (match.kind === "method_not_allowed") {
    res.setHeader("Allow", match.allow.join(", "));
    return sendJson(res, 405, { error: { code: "method_not_allowed", message: `use ${match.allow.join(" or ")}` } });
  }

  try {
    const body = BODY_METHODS.has(method) ? await readJsonBody(req, state.bodyLimit) : undefined;
    const request: ApiRequest = {
      method,
      path: url.pathname,
      params: match.params,
      query: url.searchParams,
      body,
      headers: req.headers,
      ctx: state.ctx,
      raw: req,
      res,
    };
    const result = await match.handler(request);
    if (result === STREAMED) return;
    if (result instanceof FileReply) {
      const extra: Record<string, string> = result.downloadName
        ? { "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="${safeDownloadName(result.downloadName)}"` }
        : { "Cache-Control": "private, max-age=3600" };
      return sendFile(res, result.path, result.contentType, method, extra);
    }
    if (result instanceof DownloadReply) {
      res.writeHead(200, {
        "Content-Type": result.contentType,
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(result.content),
        "Content-Disposition": `attachment; filename="${safeDownloadName(result.fileName)}"`,
      });
      res.end(method === "HEAD" ? undefined : result.content);
      return;
    }
    if (result instanceof JsonReply) return sendJson(res, result.status, result.body, method);
    return sendJson(res, 200, result, method);
  } catch (error) {
    const { status, body } = errorResponse(error);
    if (status >= 500 && !(error instanceof AppError)) logger.error("dashboard request failed", { path: url.pathname, error: toErrorMessage(error) });
    if (res.headersSent) {
      res.end();
      return;
    }
    return sendJson(res, status, body, method);
  }
}

async function handle(state: ServerState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  applySecurityHeaders(res);
  // A DNS-rebinding page reaches us under its own host name; only our names are served.
  if (!isAllowedHost(req.headers.host, state.port)) return sendText(res, 403, "Forbidden host");
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${state.port}`);
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return handleApi(state, req, res, url);

  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return sendText(res, 405, "Method not allowed");
  }
  if (url.searchParams.has("token")) return handleLogin(state, url, res);
  return serveStaticFile(state, url.pathname, method, res);
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(
        error.code === "EADDRINUSE"
          ? new AppError("port_in_use", `port ${port} is already in use; pass --port or stop the other dashboard`)
          : error,
      );
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function startDashboard(options: DashboardOptions = {}): Promise<DashboardHandle> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new AppError("dashboard_not_loopback", "the dashboard only listens on 127.0.0.1, localhost or ::1");
  }
  const token = resolveToken(options.token);
  const queue = options.queue ?? getRunQueue();
  const workspace = options.workspace ?? freshWorkspace;
  let boundPort = options.port ?? DEFAULT_PORT;

  const ctx: DashboardContext = {
    queue,
    db: queue.db,
    workspace,
    startedAt: nowIso(),
    version: packageVersion(),
    host,
    port: () => boundPort,
  };
  const state: ServerState = {
    token,
    port: boundPort,
    router: registerApiRoutes(new Router()),
    site: loadStaticSite(options.webRoot),
    ctx,
    limiter: new FailedAuthLimiter(),
    bodyLimit: options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT,
  };

  const server = createServer((req, res) => {
    handle(state, req, res).catch((error: unknown) => {
      logger.error("dashboard handler crashed", { error: toErrorMessage(error) });
      if (!res.headersSent) sendJson(res, 500, { error: { code: "internal_error", message: "unexpected error" } });
      else res.end();
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  await listen(server, boundPort, host);
  boundPort = (server.address() as AddressInfo).port;
  state.port = boundPort;

  const urlHost = host === "::1" ? "[::1]" : host;
  const url = `http://${urlHost}:${boundPort}/`;
  return {
    url,
    loginUrl: `${url}?token=${encodeURIComponent(token)}`,
    host,
    port: boundPort,
    token,
    server,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      }),
  };
}
