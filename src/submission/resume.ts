import { statSync, openSync, readSync, closeSync } from "node:fs";
import { extname } from "node:path";

/**
 * Resume file validation.
 *
 * A resume that is missing, empty or not actually the format it claims will
 * fail at upload time - after the application has otherwise been accepted.
 * Checking it up front turns a silent failure into a blocking, explainable one.
 */

export type ResumeFormat = "pdf" | "docx" | "doc" | "txt" | "other";

export type ResumeCheck = {
  ok: boolean;
  path: string;
  exists: boolean;
  sizeBytes: number;
  format: ResumeFormat;
  reason: string;
  warnings: string[];
};

/** Many ATS reject uploads above roughly this size. */
const SOFT_MAX_BYTES = 5 * 1024 * 1024;
const HARD_MAX_BYTES = 25 * 1024 * 1024;

function detectFormat(path: string): ResumeFormat {
  const extension = extname(path).toLowerCase();
  if (extension === ".pdf") return "pdf";
  if (extension === ".docx") return "docx";
  if (extension === ".doc") return "doc";
  if (extension === ".txt") return "txt";
  return "other";
}

/** Reads the first bytes of a file without loading the whole thing. */
function readMagic(path: string, length = 1024): Buffer {
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(handle, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(handle);
  }
}

function fail(path: string, reason: string, partial: Partial<ResumeCheck> = {}): ResumeCheck {
  return {
    ok: false,
    path,
    exists: false,
    sizeBytes: 0,
    format: detectFormat(path),
    reason,
    warnings: [],
    ...partial,
  };
}

/**
 * Verifies a resume file is present, non-empty and structurally plausible for
 * its extension. PDFs are checked for the %PDF- signature so a renamed or
 * truncated file is caught before an employer ever sees the application.
 */
export function validateResumeFile(path: string): ResumeCheck {
  if (!path || path.trim().length === 0) {
    return fail(path ?? "", "no resume path configured for this variant");
  }

  let stats;
  try {
    stats = statSync(path);
  } catch {
    return fail(path, `resume file not found at ${path}`);
  }

  if (!stats.isFile()) {
    return fail(path, `resume path is not a file: ${path}`, { exists: true });
  }
  if (stats.size === 0) {
    return fail(path, `resume file is empty: ${path}`, { exists: true });
  }
  if (stats.size > HARD_MAX_BYTES) {
    return fail(path, `resume file is implausibly large (${Math.round(stats.size / 1024 / 1024)} MB)`, {
      exists: true,
      sizeBytes: stats.size,
    });
  }

  const format = detectFormat(path);
  const warnings: string[] = [];

  let magic: Buffer;
  try {
    magic = readMagic(path);
  } catch (error) {
    return fail(path, `resume file could not be read: ${String(error)}`, { exists: true, sizeBytes: stats.size });
  }

  if (format === "pdf" && !magic.subarray(0, 8).includes("%PDF-")) {
    return fail(path, `file has a .pdf extension but no %PDF- signature: ${path}`, {
      exists: true,
      sizeBytes: stats.size,
    });
  }
  // DOCX is a zip container, so it must start with the PK local-file header.
  if (format === "docx" && !(magic[0] === 0x50 && magic[1] === 0x4b)) {
    return fail(path, `file has a .docx extension but is not a valid zip container: ${path}`, {
      exists: true,
      sizeBytes: stats.size,
    });
  }

  if (stats.size > SOFT_MAX_BYTES) {
    warnings.push(`file is ${Math.round(stats.size / 1024 / 1024)} MB; some ATS reject uploads over 5 MB`);
  }
  if (format === "other") {
    warnings.push(`unrecognized resume format "${extname(path) || "no extension"}"; most ATS expect PDF or DOCX`);
  }
  if (format === "doc") {
    warnings.push("legacy .doc format; PDF is more reliably parsed by ATS");
  }

  return {
    ok: true,
    path,
    exists: true,
    sizeBytes: stats.size,
    format,
    reason: "resume file is present and structurally valid",
    warnings,
  };
}
