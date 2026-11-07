import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toErrorMessage } from "../util/errors.js";

/**
 * Fonts the document templates embed.
 *
 * Latin Modern, the face of the LaTeX original, as TrueType. Chromium embeds a
 * font with CFF outlines (an .otf, or a .ttf that is really "OTTO" inside) as
 * Type3, and ATS parsers read Type3 text poorly, so only TrueType outlines are
 * accepted. The fonts are the user's to supply under the GUST Font License;
 * with none present the templates fall back to a serif stack.
 */

const FONT_FILES = {
  regular: "lmroman10-regular.ttf",
  bold: "lmroman10-bold.ttf",
  italic: "lmroman10-italic.ttf",
  display: "lmroman12-bold.ttf",
  small: "lmroman9-regular.ttf",
} as const;

export type FontRole = keyof typeof FONT_FILES;

export type FontSet = {
  dir: string;
  /** Base64 TrueType data for each role that was found and usable. */
  faces: Partial<Record<FontRole, string>>;
  missing: FontRole[];
  /** Files that exist but cannot be embedded as TrueType. */
  rejected: Array<{ role: FontRole; file: string; reason: string }>;
};

const FONT_ROLES = Object.keys(FONT_FILES) as FontRole[];

export const NO_FONTS: FontSet = { dir: "", faces: {}, missing: [...FONT_ROLES], rejected: [] };

function outlineKind(data: Buffer): "truetype" | "cff" | "unknown" {
  if (data.length < 12) return "unknown";
  const tag = data.subarray(0, 4).toString("latin1");
  if (data.readUInt32BE(0) === 0x00010000 || tag === "true") return "truetype";
  return tag === "OTTO" ? "cff" : "unknown";
}

export function loadFonts(dir: string): FontSet {
  const faces: Partial<Record<FontRole, string>> = {};
  const missing: FontRole[] = [];
  const rejected: FontSet["rejected"] = [];
  for (const role of FONT_ROLES) {
    const file = FONT_FILES[role];
    const path = join(dir, file);
    if (!existsSync(path)) {
      missing.push(role);
      continue;
    }
    let data: Buffer;
    try {
      data = readFileSync(path);
    } catch (error) {
      rejected.push({ role, file, reason: `unreadable: ${toErrorMessage(error)}` });
      continue;
    }
    const kind = outlineKind(data);
    if (kind !== "truetype") {
      rejected.push({
        role,
        file,
        reason:
          kind === "cff"
            ? "has CFF (PostScript) outlines, which Chromium embeds as Type3; convert it to TrueType"
            : "is not a TrueType font",
      });
      continue;
    }
    faces[role] = data.toString("base64");
  }
  return { dir, faces, missing, rejected };
}

/** Human-readable notes about fonts that will not be embedded. */
export function fontWarnings(fonts: FontSet): string[] {
  const warnings = fonts.rejected.map((entry) => `font ${entry.file} ${entry.reason}`);
  if (fonts.missing.length > 0 && fonts.dir) {
    const files = fonts.missing.map((role) => FONT_FILES[role]).join(", ");
    warnings.push(`fonts not found in ${fonts.dir}: ${files}; a fallback serif is used instead (see docs/DOCUMENTS.md)`);
  }
  return warnings;
}
