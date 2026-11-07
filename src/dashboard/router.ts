import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { ZodType } from "zod";
import { isAppError } from "../util/errors.js";
import type { DashboardContext } from "./context.js";
import { scrubHome } from "./queries/files.js";

/**
 * A small router for the JSON API.
 *
 * Feature modules each export `registerRoutes(router)` and are listed in
 * api/index.ts, so a new area (inbox, follow-ups, analytics...) adds its
 * endpoints in its own file without touching the server.
 */

export type ApiRequest = {
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly headers: IncomingHttpHeaders;
  readonly ctx: DashboardContext;
  readonly raw: IncomingMessage;
  readonly res: ServerResponse;
};

/** A JSON body with a status other than 200. */
export class JsonReply {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    this.status = status;
    this.body = body;
  }
}

/** A file streamed from disk, already validated by the handler. With `downloadName` it is sent as an attachment. */
export class FileReply {
  readonly path: string;
  readonly contentType: string;
  readonly downloadName: string | null;

  constructor(path: string, contentType: string, downloadName: string | null = null) {
    this.path = path;
    this.contentType = contentType;
    this.downloadName = downloadName;
  }
}

/** Generated content offered as a download, such as a calendar file. */
export class DownloadReply {
  readonly content: string;
  readonly contentType: string;
  readonly fileName: string;

  constructor(content: string, contentType: string, fileName: string) {
    this.content = content;
    this.contentType = contentType;
    this.fileName = fileName;
  }
}

/** A header-safe file name: letters, digits, dot, dash and underscore only. */
export function safeDownloadName(name: string, fallback = "download"): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 120);
  return cleaned.length > 0 ? cleaned : fallback;
}

/** Returned by handlers that wrote the response themselves (server-sent events). */
export const STREAMED: unique symbol = Symbol("streamed");

export type HandlerResult = unknown;
export type Handler = (request: ApiRequest) => HandlerResult | Promise<HandlerResult>;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type Route = { method: string; segments: string[]; handler: Handler };

export type RouteMatch =
  | { kind: "matched"; handler: Handler; params: Record<string, string> }
  | { kind: "method_not_allowed"; allow: string[] }
  | { kind: "not_found" };

function splitPath(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

export class Router {
  private readonly routes: Route[] = [];

  get(path: string, handler: Handler): this {
    return this.add("GET", path, handler);
  }

  post(path: string, handler: Handler): this {
    return this.add("POST", path, handler);
  }

  patch(path: string, handler: Handler): this {
    return this.add("PATCH", path, handler);
  }

  delete(path: string, handler: Handler): this {
    return this.add("DELETE", path, handler);
  }

  add(method: string, path: string, handler: Handler): this {
    const segments = splitPath(path);
    const clash = this.routes.find((route) => route.method === method && route.segments.join("/") === segments.join("/"));
    if (clash) throw new Error(`route ${method} ${path} registered twice`);
    this.routes.push({ method, segments, handler });
    return this;
  }

  /** Static segments win over parameters, so /api/runs/types is not read as a run id. */
  match(method: string, path: string): RouteMatch {
    const parts = splitPath(path);
    const candidates = this.routes
      .map((route) => ({ route, params: matchSegments(route.segments, parts) }))
      .filter((entry): entry is { route: Route; params: Record<string, string> } => entry.params !== null)
      .sort((a, b) => paramCount(a.route) - paramCount(b.route));
    if (candidates.length === 0) return { kind: "not_found" };
    const lookup = method === "HEAD" ? "GET" : method;
    const hit = candidates.find((entry) => entry.route.method === lookup);
    if (!hit) return { kind: "method_not_allowed", allow: [...new Set(candidates.map((entry) => entry.route.method))] };
    return { kind: "matched", handler: hit.route.handler, params: hit.params };
  }
}

function paramCount(route: Route): number {
  return route.segments.filter((segment) => segment.startsWith(":")).length;
}

function matchSegments(pattern: string[], parts: string[]): Record<string, string> | null {
  if (pattern.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (const [index, segment] of pattern.entries()) {
    const part = parts[index]!;
    if (segment.startsWith(":")) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(part);
      } catch {
        return null;
      }
      if (decoded.length === 0 || decoded.includes("\0")) return null;
      params[segment.slice(1)] = decoded;
    } else if (segment !== part) {
      return null;
    }
  }
  return params;
}

function issuesOf(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }) {
  return error.issues.slice(0, 12).map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));
}

function validate<T>(schema: ZodType<T>, value: unknown, where: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = issuesOf(result.error);
  const summary = issues.map((issue) => `${issue.path || where}: ${issue.message}`).join("; ");
  throw new HttpError(400, "invalid_request", `invalid ${where}: ${summary}`, { issues });
}

export function parseBody<T>(schema: ZodType<T>, request: ApiRequest): T {
  return validate(schema, request.body ?? {}, "body");
}

export function parseParams<T>(schema: ZodType<T>, request: ApiRequest): T {
  return validate(schema, request.params, "path");
}

/** Query strings become an object; a repeated key becomes an array. */
export function parseQuery<T>(schema: ZodType<T>, request: ApiRequest): T {
  const value: Record<string, string | string[]> = {};
  for (const key of new Set(request.query.keys())) {
    const all = request.query.getAll(key);
    value[key] = all.length > 1 ? all : (all[0] ?? "");
  }
  return validate(schema, value, "query");
}

const STATUS_BY_CODE: Record<string, number> = {
  invalid_request: 400,
  invalid_run_params: 400,
  unknown_run_type: 400,
  unknown_question_key: 400,
  missing_argument: 400,
  reply_text_required: 400,
  invalid_round_cap: 503,
  config_missing: 503,
  config_invalid: 503,
  config_invalid_json: 503,
  config_unreadable: 503,
};

/** A service's own refusal of bad input (invalid_since, invalid_start...) is the client's error, not a conflict. */
function statusForAppCode(code: string): number {
  const listed = STATUS_BY_CODE[code];
  if (listed !== undefined) return listed;
  if (code.endsWith("_not_found")) return 404;
  return code.startsWith("invalid_") ? 400 : 409;
}

/** HTTP status for a thrown error, and the body the client sees. Unexpected errors are not described; home paths are shortened to ~. */
export function errorResponse(error: unknown): { status: number; body: { error: Record<string, unknown> } } {
  if (error instanceof HttpError) {
    return { status: error.status, body: { error: { code: error.code, message: scrubHome(error.message), ...error.details } } };
  }
  if (isAppError(error)) {
    return { status: statusForAppCode(error.code), body: { error: { code: error.code, message: scrubHome(error.message) } } };
  }
  return { status: 500, body: { error: { code: "internal_error", message: "The dashboard hit an unexpected error; details are in its terminal." } } };
}
