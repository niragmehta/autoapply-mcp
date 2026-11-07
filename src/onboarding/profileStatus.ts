import { existsSync, readFileSync } from "node:fs";
import type { Workspace } from "../config/load.js";
import { loadCampaign, loadProfile } from "../config/load.js";
import { resolvePaths, type WorkspacePaths } from "../config/paths.js";
import { parseSecrets } from "../config/secrets.js";
import type { Campaign } from "../domain/campaign.js";
import type { Profile } from "../domain/profile.js";
import type { ResumeCheck } from "../submission/resume.js";
import { AppError, toErrorMessage } from "../util/errors.js";
import {
  checkAnswers,
  checkCampaign,
  checkCompensation,
  checkContent,
  checkIdentity,
  checkPersonal,
  checkPlaceholders,
  checkResumes,
  checkWorkAuthorization,
  type Finding,
  type Severity,
} from "./profileChecks.js";

/**
 * Profile readiness: what is configured, what is still a placeholder, and the
 * order in which to fix the rest.
 *
 * Conversational onboarding starts here and ends here. The report is safe to
 * hand to an agent - contact details are masked and personal fields are
 * reported only as present or absent - and its next steps name the tool that
 * fixes each gap, so the agent can work through them one confirmed answer at a
 * time.
 */

export type NextStep = Finding & { priority: number };

export type ConfigError = { file: "profile" | "campaign"; code: string; message: string };

export type ProfileStatus = {
  ready: boolean;
  /** Share of checks with no blocking or important finding, 0-100. */
  readiness: number;
  home: string;
  configErrors: ConfigError[];
  identity?: ReturnType<typeof checkIdentity>["summary"];
  personal?: ReturnType<typeof checkPersonal>["summary"];
  workAuthorization?: ReturnType<typeof checkWorkAuthorization>["summary"];
  compensation?: ReturnType<typeof checkCompensation>["summary"];
  resumes?: ReturnType<typeof checkResumes>["summary"];
  counts?: ReturnType<typeof checkContent>["summary"];
  answers?: ReturnType<typeof checkAnswers>["summary"];
  placeholders?: ReturnType<typeof checkPlaceholders>["summary"];
  campaign?: ReturnType<typeof checkCampaign>["summary"];
  nextSteps: NextStep[];
};

export type StatusOptions = {
  env?: Record<string, string | undefined>;
  validateResume?: (path: string) => ResumeCheck;
};

const SEVERITY_ORDER: Record<Severity, number> = { blocker: 0, important: 1, suggested: 2 };

/** Identity, work authorization, compensation, resumes, content, answers, placeholders and campaign. */
const EXPECTED_SECTIONS = 8;

/** Blockers first, then important, then suggested; stable within each band. */
export function prioritize(findings: readonly Finding[]): NextStep[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity] || a.index - b.index)
    .map(({ finding }, position) => ({ priority: position + 1, ...finding }));
}

function secretKeys(paths: WorkspacePaths): Set<string> {
  try {
    if (!existsSync(paths.secrets)) return new Set();
    return new Set(Object.keys(parseSecrets(readFileSync(paths.secrets, "utf8"))));
  } catch {
    return new Set();
  }
}

function assemble(
  paths: WorkspacePaths,
  profile: Profile | null,
  campaign: Campaign | null,
  configErrors: ConfigError[],
  options: StatusOptions,
): ProfileStatus {
  const findings: Finding[] = configErrors.map((error) => ({
    severity: "blocker",
    section: error.file,
    message:
      error.code === "config_missing"
        ? `${error.file}.json does not exist yet; run "npm run init" to create it from the examples.`
        : `${error.file}.json cannot be loaded: ${error.message}`,
    tool: error.code === "config_missing" ? "npm run init" : error.file === "profile" ? "update_profile" : "update_campaign",
  }));
  const status: ProfileStatus = { ready: false, readiness: 0, home: paths.home, configErrors, nextSteps: [] };
  const sections: Finding[][] = [];

  if (profile) {
    const identity = checkIdentity(profile);
    const work = checkWorkAuthorization(profile, campaign);
    const pay = checkCompensation(profile, campaign);
    const resumes = checkResumes(profile, options.validateResume);
    const content = checkContent(profile);
    const answers = checkAnswers(profile);
    const placeholders = checkPlaceholders(profile);
    Object.assign(status, {
      identity: identity.summary,
      personal: checkPersonal(profile).summary,
      workAuthorization: work.summary,
      compensation: pay.summary,
      resumes: resumes.summary,
      counts: content.summary,
      answers: answers.summary,
      placeholders: placeholders.summary,
    });
    sections.push(identity.findings, work.findings, pay.findings, resumes.findings, content.findings, answers.findings, placeholders.findings);
    if (campaign) {
      const campaignCheck = checkCampaign(profile, campaign, options.env ?? process.env, secretKeys(paths));
      status.campaign = campaignCheck.summary;
      sections.push(campaignCheck.findings);
    }
  }

  const all = [...findings, ...sections.flat()];
  const clean = sections.filter((section) => !section.some((finding) => finding.severity !== "suggested")).length;
  status.readiness = Math.round((clean / EXPECTED_SECTIONS) * 100);
  status.ready = configErrors.length === 0 && profile !== null && campaign !== null && !all.some((finding) => finding.severity === "blocker");
  status.nextSteps = prioritize(all);
  return status;
}

/** Readiness of an already-loaded workspace. */
export function profileStatus(workspace: Pick<Workspace, "paths" | "profile" | "campaign">, options: StatusOptions = {}): ProfileStatus {
  return assemble(workspace.paths, workspace.profile, workspace.campaign, [], options);
}

function tryLoad<T>(file: ConfigError["file"], load: () => T, errors: ConfigError[]): T | null {
  try {
    return load();
  } catch (error) {
    errors.push({ file, code: error instanceof AppError ? error.code : "error", message: toErrorMessage(error) });
    return null;
  }
}

/**
 * Readiness straight from disk. Unlike getWorkspace this still answers when a
 * file is missing or invalid, which is exactly when onboarding needs it.
 */
export function readProfileStatus(paths: WorkspacePaths = resolvePaths(), options: StatusOptions = {}): ProfileStatus {
  const errors: ConfigError[] = [];
  const profile = tryLoad("profile", () => loadProfile(paths.profile), errors);
  const campaign = tryLoad("campaign", () => loadCampaign(paths.campaign), errors);
  return assemble(paths, profile, campaign, errors, options);
}
