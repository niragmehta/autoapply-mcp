import { z } from "zod";
import type { ZodType } from "zod";
import type { WorkspacePaths } from "../config/paths.js";
import { readJsonFile, writeJsonAtomic } from "../config/write.js";
import { CampaignSchema } from "../domain/campaign.js";
import { ProfileSchema } from "../domain/profile.js";
import { validateResumeFile } from "../submission/resume.js";
import { AppError } from "../util/errors.js";
import { appendAt, parsePointer, removeAt, setAt } from "./jsonPointer.js";

/**
 * Guided edits to profile.json and campaign.json.
 *
 * An agent onboarding a candidate writes each confirmed answer as a small
 * patch rather than rewriting the file. Every patch is limited to sections the
 * candidate can reasonably state in conversation, validated as a whole against
 * the schema before anything is written, and written atomically with a dated
 * backup. Personal and demographic data, and the submission guard settings,
 * are not reachable from here: those stay hand-edited decisions.
 *
 * The file is patched as written, not as parsed, so defaults the schema would
 * fill in are not suddenly spelled out in a hand-maintained file.
 */

export const PATCH_OPS = ["set", "append", "remove"] as const;

export const PatchOpSchema = z.object({
  op: z.enum(PATCH_OPS),
  path: z.string().trim().min(2).max(300),
  value: z.unknown().optional(),
});
export type PatchOp = z.infer<typeof PatchOpSchema>;

export const PatchOpsSchema = z.array(PatchOpSchema).min(1).max(50);

export const PROFILE_PATCH_ALLOWLIST = [
  "/identity",
  "/preferences",
  "/compensation",
  "/workAuthorization",
  "/skills",
  "/facts",
  "/experience",
  "/education",
  "/answers",
  "/narratives",
  "/resumes",
] as const;

export const CAMPAIGN_PATCH_ALLOWLIST = [
  "/tracks",
  "/locations",
  "/compensation",
  "/exclusions",
  "/scoring/thresholds",
  "/freshnessDays",
  "/submission/mode",
  "/submission/dailyLimit",
  "/submission/maxPerCompany",
  "/submission/allowedCompanies",
  "/hygiene",
  "/documents",
  "/inbox",
  "/followUps",
  "/runner",
] as const;

export type PatchResult = {
  file: string;
  changed: Array<{ op: PatchOp["op"]; path: string }>;
  unchanged: boolean;
  backupPath: string | null;
  warnings: string[];
};

export type PatchOptions = { now?: Date; backup?: boolean };

function isAllowed(tokens: readonly string[], allowlist: readonly string[]): boolean {
  return allowlist.some((prefix) => {
    const allowed = parsePointer(prefix);
    return tokens.length >= allowed.length && allowed.every((token, index) => tokens[index] === token);
  });
}

function checkOps(ops: unknown, allowlist: readonly string[], label: string): PatchOp[] {
  const parsed = PatchOpsSchema.safeParse(ops);
  if (!parsed.success) {
    throw new AppError("patch_invalid_ops", `ops must be 1-50 entries of {op: set|append|remove, path: "/json/pointer", value?}`, {
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    });
  }
  for (const op of parsed.data) {
    const tokens = parsePointer(op.path);
    if (!isAllowed(tokens, allowlist)) {
      throw new AppError("patch_path_not_allowed", `${op.path} is not editable through ${label}; editable paths start with ${allowlist.join(", ")}`, {
        path: op.path,
      });
    }
    if (op.op !== "remove" && op.value === undefined) {
      throw new AppError("patch_value_missing", `"${op.op}" at ${op.path} needs a value`, { path: op.path });
    }
  }
  return parsed.data;
}

function applyOps(document: unknown, ops: readonly PatchOp[]): unknown {
  return ops.reduce<unknown>((current, op) => {
    if (op.op === "set") return setAt(current, op.path, op.value);
    if (op.op === "append") return appendAt(current, op.path, op.value);
    return removeAt(current, op.path);
  }, document);
}

function validate(schema: ZodType, document: unknown, label: string): void {
  const result = schema.safeParse(document);
  if (result.success) return;
  const issues = result.error.issues.slice(0, 10).map((issue) => `/${issue.path.join("/")}: ${issue.message}`);
  throw new AppError("patch_invalid", `the edit would leave ${label} invalid, so nothing was written:\n  - ${issues.join("\n  - ")}`, {
    issues,
  });
}

function patchFile(
  file: string,
  ops: unknown,
  allowlist: readonly string[],
  schema: ZodType,
  label: string,
  options: PatchOptions,
): PatchResult & { document: unknown; ops: PatchOp[] } {
  const checked = checkOps(ops, allowlist, label);
  const original = readJsonFile(file);
  const document = applyOps(original, checked);
  validate(schema, document, label);
  const changed = checked.map((op) => ({ op: op.op, path: op.path }));
  if (JSON.stringify(document) === JSON.stringify(original)) {
    return { file, changed, unchanged: true, backupPath: null, warnings: [], document, ops: checked };
  }
  const backupPath = writeJsonAtomic(file, document, { backup: options.backup ?? true, now: options.now });
  return { file, changed, unchanged: false, backupPath, warnings: [], document, ops: checked };
}

/** Resume paths are checked after the write: a missing file is worth saying, not worth refusing. */
function resumeWarnings(document: unknown, ops: readonly PatchOp[]): string[] {
  if (!ops.some((op) => op.path.startsWith("/resumes"))) return [];
  const parsed = ProfileSchema.safeParse(document);
  if (!parsed.success) return [];
  return parsed.data.resumes
    .map((resume) => ({ id: resume.id, check: validateResumeFile(resume.path) }))
    .filter(({ check }) => !check.ok)
    .map(({ id }) => `resume "${id}" does not point at a usable file yet; profile_status reports why`);
}

/** Applies validated, allowlisted edits to profile.json. Values are never echoed back. */
export function applyProfilePatch(paths: Pick<WorkspacePaths, "profile">, ops: unknown, options: PatchOptions = {}): PatchResult {
  const { document, ops: applied, ...result } = patchFile(paths.profile, ops, PROFILE_PATCH_ALLOWLIST, ProfileSchema, "profile.json", options);
  return { ...result, warnings: resumeWarnings(document, applied) };
}

/** Applies validated, allowlisted edits to campaign.json. */
export function applyCampaignPatch(paths: Pick<WorkspacePaths, "campaign">, ops: unknown, options: PatchOptions = {}): PatchResult {
  const { document: _document, ops: _ops, ...result } = patchFile(paths.campaign, ops, CAMPAIGN_PATCH_ALLOWLIST, CampaignSchema, "campaign.json", options);
  return result;
}
