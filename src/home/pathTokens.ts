import { join } from "node:path";

/**
 * Paths under AUTOAPPLY_HOME, written so a workspace can move.
 *
 * The configuration and the database store absolute paths (a resume variant,
 * a tailored PDF, a screenshot). A bundle carries each one as the placeholder
 * plus the rest of the path with forward slashes, and the import joins the
 * rest onto the new home, so a Windows workspace opens on Linux and back.
 */

export const HOME_TOKEN = "~AUTOAPPLY_HOME~";

const forward = (value: string) => value.replace(/\\/g, "/");
const isDrivePath = (value: string) => /^[a-z]:\//i.test(value);

/** The placeholder form of a path inside `home`, or null when the path is elsewhere. */
export function tokenizePath(value: string, home: string): string | null {
  const base = forward(home).replace(/\/+$/, "");
  const path = forward(value);
  if (base.length === 0 || path.length < base.length) return null;
  const head = path.slice(0, base.length);
  // Windows paths compare without case, the way the file system does.
  const same = isDrivePath(base) ? head.toLowerCase() === base.toLowerCase() : head === base;
  const rest = path.slice(base.length);
  if (!same || (rest.length > 0 && !rest.startsWith("/"))) return null;
  return `${HOME_TOKEN}${rest}`;
}

/** The path a placeholder stands for at `home`, or null when the value holds no placeholder. */
export function detokenizePath(value: string, home: string): string | null {
  if (!value.startsWith(HOME_TOKEN)) return null;
  const rest = value.slice(HOME_TOKEN.length);
  if (rest.length > 0 && !rest.startsWith("/")) return null;
  const parts = rest.split("/").filter((part) => part.length > 0);
  return parts.length > 0 ? join(home, ...parts) : home;
}

/** Every string in a JSON value passed through `rewrite`, as a new value. */
export function mapStrings(value: unknown, rewrite: (text: string) => string): unknown {
  if (typeof value === "string") return rewrite(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, rewrite));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, rewrite)]));
  }
  return value;
}

/**
 * A stored text value with its paths rewritten: the whole value when it is a
 * path, or each path string when it is a JSON document. Free text that only
 * mentions a path is left exactly as it was, and so is any value with nothing
 * to rewrite.
 */
export function rewriteTextValue(value: string, rewritePath: (path: string) => string | null): string {
  const start = value.trimStart()[0];
  if (start === "{" || start === "[") {
    try {
      const parsed: unknown = JSON.parse(value);
      let changed = false;
      const next = mapStrings(parsed, (text) => {
        const rewritten = rewritePath(text);
        if (rewritten === null) return text;
        changed = true;
        return rewritten;
      });
      return changed ? JSON.stringify(next) : value;
    } catch {
      // Not JSON after all; treat it as plain text below.
    }
  }
  return rewritePath(value) ?? value;
}

/**
 * Substrings that find stored text mentioning `home`, however its separators
 * were written: forward slashes, backslashes, or JSON-escaped backslashes. The
 * drive letter is left off so its case does not matter.
 */
export function databaseNeedles(home: string): string[] {
  const tail = forward(home).replace(/\/+$/, "").replace(/^[a-z]:/i, "");
  return [...new Set([tail, tail.replace(/\//g, "\\"), tail.replace(/\//g, "\\\\")])].filter((needle) => needle.length > 0);
}
