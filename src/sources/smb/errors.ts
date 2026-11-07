import { AppError } from "../../util/errors.js";

/** Translates ATS-specific "no such board" signals into a stable not_found error. */
export function missingBoard(error: unknown, ats: string, board: string): unknown {
  // Unknown BambooHR and JazzHR tenants redirect to the vendor's marketing
  // site; the host allowlist stops that redirect, which is the real signal.
  if (error instanceof AppError && ["source_host_not_allowed", "unsafe_source_url"].includes(error.code)) {
    return new AppError("not_found", `${ats} board "${board}" was not found (the host redirected away from the board)`, { board });
  }
  return error;
}
