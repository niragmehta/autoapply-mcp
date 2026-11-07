import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { z } from "zod";
import { loadCampaign, loadCompanies, loadProfile } from "../../config/load.js";
import { resolvePaths, type WorkspacePaths } from "../../config/paths.js";
import { parseSecrets } from "../../config/secrets.js";
import type { Campaign } from "../../domain/campaign.js";
import type { Profile } from "../../domain/profile.js";
import { inboxStatus } from "../../inbox/status.js";
import { readProfileStatus } from "../../onboarding/profileStatus.js";
import { validateResumeFile } from "../../submission/resume.js";
import { readVerificationInboxConfig } from "../../submission/verificationInbox.js";
import { toErrorMessage } from "../../util/errors.js";
import type { DashboardContext } from "../context.js";
import { displayPath, scrubHome } from "../queries/files.js";
import { parseQuery, type Router } from "../router.js";
import { queryBool } from "./shared.js";

/**
 * GET /api/health: whether this workspace can run. Works even when the
 * configuration is invalid, since that is exactly when it is needed. Secret
 * names are reported; values never leave the process.
 */

type Check = { id: string; label: string; ok: boolean; detail: string; level?: "warn" };

/** Variables the submission engine and dashboard read. Only their presence is reported. */
const KNOWN_SECRETS = [
  "AUTOAPPLY_OTP_IMAP_USER",
  "AUTOAPPLY_OTP_IMAP_PASSWORD",
  "AUTOAPPLY_OTP_IMAP_HOST",
  "AUTOAPPLY_OTP_IMAP_PORT",
  "AUTOAPPLY_OTP_MAILBOX",
  "AUTOAPPLY_OTP_FROM",
  "AUTOAPPLY_INBOX_IMAP_USER",
  "AUTOAPPLY_INBOX_IMAP_PASSWORD",
  "AUTOAPPLY_INBOX_IMAP_HOST",
  "AUTOAPPLY_INBOX_IMAP_PORT",
  "AUTOAPPLY_INBOX_IMAP_MAILBOX",
  "AUTOAPPLY_ATS_EMAIL",
  "AUTOAPPLY_ATS_PASSWORD",
  "AUTOAPPLY_DASHBOARD_TOKEN",
] as const;

const TABLES = [
  "jobs",
  "evaluations",
  "applications",
  "approvals",
  "outcomes",
  "events",
  "runs",
  "run_logs",
  "job_dismissals",
  "liveness_checks",
  "inbox_messages",
  "followups",
  "interviews",
  "offers",
  "evaluation_reports",
  "tailored_documents",
  "leads",
  "harvested_boards",
] as const;

type PlaywrightStatus = { installed: boolean; browser: boolean; detail: string };
let playwrightCache: PlaywrightStatus | null = null;

async function playwrightStatus(refresh: boolean): Promise<PlaywrightStatus> {
  if (playwrightCache && !refresh) return playwrightCache;
  const specifier = "playwright";
  let status: PlaywrightStatus;
  try {
    createRequire(import.meta.url).resolve(specifier);
    const module = (await import(specifier)) as { chromium?: { executablePath(): string } };
    const executable = module.chromium?.executablePath() ?? "";
    status = existsSync(executable)
      ? { installed: true, browser: true, detail: "Playwright and its Chromium build are installed" }
      : { installed: true, browser: false, detail: 'Playwright is installed but Chromium is not; run "npx playwright install chromium"' };
  } catch {
    status = { installed: false, browser: false, detail: 'Playwright is not installed; browser submission needs "npm install playwright"' };
  }
  playwrightCache = status;
  return status;
}

function tryLoad<T>(label: string, id: string, load: () => T, describe: (value: T) => string): { check: Check; value: T | null } {
  try {
    const value = load();
    return { check: { id, label, ok: true, detail: describe(value) }, value };
  } catch (error) {
    return { check: { id, label, ok: false, detail: toErrorMessage(error) }, value: null };
  }
}

function resumeChecks(profile: Profile | null, campaign: Campaign | null): Check[] {
  if (!profile) return [];
  const checks: Check[] = profile.resumes.map((resume) => {
    const result = validateResumeFile(resume.path);
    return {
      id: `resume:${resume.id}`,
      label: `Resume "${resume.id}"`,
      ok: result.ok,
      detail: result.ok ? `${result.format}, ${Math.round(result.sizeBytes / 1024)} KB${result.warnings.length ? ` - ${result.warnings.join("; ")}` : ""}` : result.reason,
    };
  });
  if (campaign) {
    const ids = new Set(profile.resumes.map((resume) => resume.id));
    for (const track of campaign.tracks) {
      checks.push({
        id: `track:${track.id}`,
        label: `Track "${track.id}" resume`,
        ok: ids.has(track.resumeId),
        detail: ids.has(track.resumeId) ? track.resumeId : `campaign names unknown resume "${track.resumeId}"`,
      });
    }
  }
  return checks;
}

function secretNames(path: string): { file: boolean; inFile: string[]; inEnvironment: string[] } {
  const inFile = existsSync(path) ? Object.keys(parseSecrets(readFileSync(path, "utf8"))).sort() : [];
  const inEnvironment = KNOWN_SECRETS.filter((name) => (process.env[name] ?? "").length > 0);
  return { file: existsSync(path), inFile, inEnvironment };
}

function databaseStats(ctx: DashboardContext, path: string) {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    try {
      const row = ctx.db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total?: number } | undefined;
      counts[table] = Number(row?.total ?? 0);
    } catch {
      counts[table] = -1;
    }
  }
  let sizeBytes = 0;
  try {
    sizeBytes = statSync(path).size;
  } catch {
    sizeBytes = 0;
  }
  return { path: displayPath(path), sizeBytes, counts };
}

/** Profile readiness from the onboarding checks: masked, and readable even when the configuration is invalid. */
function readiness(paths: WorkspacePaths) {
  try {
    const status = readProfileStatus(paths);
    return {
      ready: status.ready,
      readiness: status.readiness,
      configErrors: status.configErrors.map((entry) => ({ ...entry, message: scrubHome(entry.message) })),
      nextSteps: status.nextSteps.slice(0, 8).map((step) => ({ severity: step.severity, section: step.section, message: scrubHome(step.message), tool: step.tool ?? null })),
      error: null,
    };
  } catch (error) {
    return { ready: false, readiness: 0, configErrors: [], nextSteps: [], error: scrubHome(toErrorMessage(error)) };
  }
}

/** Reply reading: switched on, and whether a mailbox is configured. Never the host or credentials. */
function inboxReadiness(ctx: DashboardContext) {
  try {
    const report = inboxStatus(ctx.workspace());
    return { enabled: report.enabled, configured: report.configured, credentialSource: report.credentialSource, lastScanAt: report.lastScanAt };
  } catch {
    return { enabled: false, configured: false, credentialSource: null, lastScanAt: null };
  }
}

function displayPaths(paths: WorkspacePaths): Record<keyof WorkspacePaths, string> {
  return Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, displayPath(value)])) as Record<keyof WorkspacePaths, string>;
}

function configSummary(profile: Profile | null, campaign: Campaign | null) {
  return {
    profile: profile
      ? { name: profile.identity.fullName, resumes: profile.resumes.map((resume) => ({ id: resume.id, label: resume.label })) }
      : null,
    campaign: campaign
      ? {
          name: campaign.name,
          targetApplications: campaign.targetApplications,
          tracks: campaign.tracks.map((track) => ({ id: track.id, label: track.label, allocation: track.allocation, resumeId: track.resumeId })),
          locations: campaign.locations.allow,
          submission: {
            mode: campaign.submission.mode,
            dailyLimit: campaign.submission.dailyLimit,
            maxBatchSize: campaign.submission.maxBatchSize,
            maxPerCompany: campaign.submission.maxPerCompany,
            minDelaySeconds: campaign.submission.minDelaySeconds,
            allowedCompanies: campaign.submission.allowedCompanies,
            allowedAtsDomains: campaign.submission.allowedAtsDomains,
          },
          runner: campaign.runner,
        }
      : null,
  };
}

const HealthQuery = z.object({ refresh: queryBool });

export function registerRoutes(router: Router): void {
  router.get("/api/health", async (request) => {
    const { ctx } = request;
    const query = parseQuery(HealthQuery, request);
    const paths = resolvePaths();
    const profile = tryLoad("profile.json", "profile", () => loadProfile(paths.profile), (value) => `${value.resumes.length} resume variant(s)`);
    const campaign = tryLoad("campaign.json", "campaign", () => loadCampaign(paths.campaign), (value) => `${value.name}, submission mode "${value.submission.mode}"`);
    const companies = tryLoad("companies.json", "companies", () => loadCompanies(paths.companies), (value) => `${value.length} board(s), ${value.filter((company) => company.active).length} active`);
    const playwright = await playwrightStatus(query.refresh === true);
    const imapConfigured = readVerificationInboxConfig(process.env) !== null;
    const inbox = inboxReadiness(ctx);

    const checks: Check[] = [
      profile.check,
      campaign.check,
      companies.check,
      ...resumeChecks(profile.value, campaign.value),
      { id: "playwright", label: "Browser automation", ok: playwright.browser, detail: playwright.detail, level: "warn" },
      {
        id: "imap",
        label: "Verification inbox",
        ok: imapConfigured,
        detail: imapConfigured ? "IMAP mailbox configured" : "Not configured; email verification codes must be entered by hand",
        level: "warn",
      },
      {
        id: "reply-inbox",
        label: "Reply reading",
        ok: !inbox.enabled || inbox.configured,
        detail: !inbox.enabled
          ? "Off (campaign.inbox.enabled is false); paste replies on the Inbox page instead"
          : inbox.configured
            ? `On, reading the mailbox named by ${inbox.credentialSource}_*`
            : "On, but no mailbox is configured; set AUTOAPPLY_INBOX_IMAP_* or AUTOAPPLY_OTP_IMAP_*",
        level: "warn",
      },
    ];
    const failing = checks.filter((check) => !check.ok);
    return {
      ok: failing.every((check) => check.level === "warn"),
      version: ctx.version,
      node: process.version,
      startedAt: ctx.startedAt,
      host: { address: ctx.host, port: ctx.port(), pid: process.pid, runQueueHost: ctx.queue.hostPid },
      checks: checks.map((check) => ({ ...check, detail: scrubHome(check.detail) })),
      playwright,
      imap: { configured: imapConfigured },
      inbox,
      profile: readiness(paths),
      secrets: secretNames(paths.secrets),
      database: databaseStats(ctx, paths.database),
      paths: displayPaths(paths),
      config: configSummary(profile.value, campaign.value),
      runTypes: ctx.queue.taskTypes(),
    };
  });
}
