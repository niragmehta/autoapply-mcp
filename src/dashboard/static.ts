import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static files for the browser app: the repository's `web/` directory and the
 * three vendor modules (Preact, its hooks, htm) the import map points at.
 * Nothing outside those is ever served, and every path is validated before it
 * touches the filesystem.
 */

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
/** Windows device names resolve to devices, not files, wherever they appear. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export type StaticFile = { path: string; contentType: string };

export type StaticSite = {
  readonly root: string;
  /** URL path -> absolute file for the vendor modules. */
  readonly vendor: ReadonlyMap<string, string>;
};

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** The repository's web/ directory, from either src/dashboard or dist/dashboard. */
export function defaultWebRoot(): string {
  return resolve(moduleDir, "..", "..", "web");
}

function vendorFiles(): Map<string, string> {
  const require = createRequire(import.meta.url);
  // htm resolves to its CommonJS build under require(); its ES module sits beside it.
  const htm = join(dirname(require.resolve("htm")), "htm.mjs");
  const files = new Map([
    ["/vendor/preact.mjs", require.resolve("preact")],
    ["/vendor/preact-hooks.mjs", require.resolve("preact/hooks")],
    ["/vendor/htm.mjs", htm],
  ]);
  for (const [url, path] of files) {
    if (!/\.mjs$/.test(path) || !existsSync(path)) throw new Error(`vendor module for ${url} not found at ${path}`);
  }
  return files;
}

export function loadStaticSite(root = defaultWebRoot()): StaticSite {
  const resolvedRoot = resolve(root);
  if (!existsSync(join(resolvedRoot, "index.html"))) {
    throw new Error(`dashboard web files not found at ${resolvedRoot}`);
  }
  return { root: resolvedRoot, vendor: vendorFiles() };
}

/** A URL path reduced to safe segments, or null when it could escape or name something unexpected. */
export function safeRelativePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.split("/").filter((segment) => segment.length > 0);
  const unsafe = segments.some((segment) => !SEGMENT.test(segment) || segment.includes("..") || RESERVED.test(segment));
  return unsafe ? null : segments.join("/");
}

/** Resolves `relative` inside `root`, following symlinks, or null when it is not a regular file there. */
export function fileInside(root: string, relative: string): string | null {
  const candidate = resolve(root, relative);
  if (!candidate.startsWith(root + sep)) return null;
  try {
    if (!statSync(candidate).isFile()) return null;
    const real = realpathSync(candidate);
    const realRoot = realpathSync(root);
    return real.startsWith(realRoot + sep) ? real : null;
  } catch {
    return null;
  }
}

function contentTypeOf(path: string): string | null {
  return MIME[extname(path).toLowerCase()] ?? null;
}

/**
 * The file a GET for `pathname` serves. Extensionless paths are app routes
 * (/jobs, /runs...) and get index.html; the app reads the route itself.
 */
export function resolveStatic(site: StaticSite, pathname: string): StaticFile | null {
  const vendor = site.vendor.get(pathname);
  if (vendor) return { path: vendor, contentType: MIME[".mjs"]! };
  if (pathname.startsWith("/vendor/")) return null;
  const relative = safeRelativePath(pathname);
  if (relative === null) return null;
  const last = relative.split("/").at(-1) ?? "";
  const isRoute = relative === "" || !last.includes(".");
  const target = isRoute ? "index.html" : relative;
  const contentType = contentTypeOf(target);
  if (!contentType) return null;
  const path = fileInside(site.root, target);
  return path ? { path, contentType } : null;
}

/** The CSP source for the inline import map in index.html. */
export function importMapHash(html: string): string | null {
  const match = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
  if (!match) return null;
  return `sha256-${createHash("sha256").update(match[1] ?? "", "utf8").digest("base64")}`;
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}
