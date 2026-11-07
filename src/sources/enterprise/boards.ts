import { AppError } from "../../util/errors.js";

/**
 * Board-string helpers. Every enterprise board is a short, slash-separated
 * value a person can read off the employer's careers URL; each adapter
 * documents its own shape in docs/SOURCES_ENTERPRISE.md.
 */

/** A DNS hostname: no scheme, port, path, credentials or IP literal. */
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function hostname(value: string): string | null {
  const host = value.trim().toLowerCase();
  return HOSTNAME.test(host) ? host : null;
}

/** Splits a board on "/", trimming and dropping empty segments. */
export function boardSegments(board: string): string[] {
  return board.split("/").map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Parses a value as an absolute HTTPS URL, or null. */
export function httpsUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * The error every adapter throws for a malformed board. When a person pasted
 * a careers URL instead of the board string, the message names the board that
 * URL points at so the fix is a copy and paste.
 */
export function invalidBoard(
  label: string,
  board: string,
  expected: string,
  fromUrl?: (url: URL) => string | null,
): AppError {
  const url = httpsUrl(board);
  const suggestion = url && fromUrl ? fromUrl(url) : null;
  const hint = suggestion
    ? ` That looks like a careers URL; use the board "${suggestion}".`
    : url
      ? " Use the board string, not the careers URL."
      : "";
  return new AppError("invalid_board", `${label} board must be ${expected}, got: ${board}.${hint}`, { board });
}
