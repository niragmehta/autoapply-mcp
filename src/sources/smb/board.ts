import type { Company } from "../../domain/campaign.js";
import type { Job } from "../../domain/job.js";
import { AppError } from "../../util/errors.js";

/**
 * Board identifiers for the startup/SMB adapters.
 *
 * Every board is either a tenant subdomain (`acme` in `acme.bamboohr.com`) or a
 * single path segment (`acme` in `ats.rippling.com/acme`). Both are validated
 * before any URL is built, so a pasted URL, a path or a host suffix fails with
 * an example instead of silently addressing a different board.
 */

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

export type BoardFormat = {
  /** ATS name used in error messages, e.g. "BambooHR". */
  readonly ats: string;
  /** What the board is, e.g. "the tenant subdomain of <tenant>.bamboohr.com". */
  readonly shape: string;
  readonly example: string;
};

export function invalidBoard(format: BoardFormat, board: string): AppError {
  return new AppError(
    "invalid_board",
    `${format.ats} board must be ${format.shape}, e.g. "${format.example}"; got "${board}"`,
    { board, example: format.example },
  );
}

/** A lower-cased DNS label such as a tenant subdomain. */
export function tenantBoard(board: string, format: BoardFormat): string {
  const value = board.trim().toLowerCase();
  if (!DNS_LABEL.test(value)) throw invalidBoard(format, board);
  return value;
}

/** A single URL path segment; case is preserved because some ATS slugs are case-sensitive. */
export function segmentBoard(board: string, format: BoardFormat): string {
  const value = board.trim();
  if (!PATH_SEGMENT.test(value)) throw invalidBoard(format, board);
  return value;
}

export function isDnsLabel(value: string): boolean {
  return DNS_LABEL.test(value);
}

/** Identifiers that go into a URL path must stay a single opaque segment. */
export function postingId(value: string, ats: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id)) {
    throw new AppError("invalid_posting_id", `${ats} posting id must be a single identifier, got "${value}"`);
  }
  return id;
}

/** Rebuilds the board a stored job came from, for liveness checks. */
export function companyFromJob(job: Job): Company {
  return {
    name: job.companyName,
    ats: job.ats,
    board: job.board,
    tier: job.companyTier,
    tags: [],
    active: true,
    region: "global",
    query: "",
  };
}

/** The non-empty, decoded path segments of a URL. */
export function pathParts(url: URL): string[] {
  return url.pathname.split("/").filter((part) => part.length > 0).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
}
