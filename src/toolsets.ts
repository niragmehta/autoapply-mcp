import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCareerPrompts } from "./prompts/career.js";
import { registerDocumentPrompts } from "./prompts/documents.js";
import { registerEvaluationPrompts } from "./prompts/evaluation.js";
import { registerFollowupPrompts } from "./prompts/followup.js";
import { registerOnboardingPrompts } from "./prompts/onboarding.js";
import { registerBatchTools } from "./tools/batch.js";
import { registerCareerTools } from "./tools/career.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerDocumentTools } from "./tools/documents.js";
import { registerDraftingTools } from "./tools/drafting.js";
import { registerEvaluationTools } from "./tools/evaluation.js";
import { registerFollowupTools } from "./tools/followup.js";
import { registerHygieneTools } from "./tools/hygiene.js";
import { registerOnboardingTools } from "./tools/onboarding.js";
import { registerRunTools } from "./tools/runs.js";
import { registerSourceSearchTools } from "./tools/sourceSearch.js";
import { registerSourcingTools } from "./tools/sourcing.js";
import { registerSubmissionTools } from "./tools/submission.js";
import { registerTrackingTools } from "./tools/tracking.js";
import { AppError } from "./util/errors.js";

type Register = (server: McpServer) => void;

type Toolset = {
  /** One paragraph of the server instructions, shown only when the toolset is enabled. */
  instructions: string;
  tools: readonly Register[];
  prompts: readonly Register[];
};

/**
 * Tool groups a client can switch on and off with AUTOAPPLY_TOOLSETS.
 *
 * Every tool costs context in every request, and some clients cap how many
 * tools one request may carry (VS Code allows 128 across all servers), so a
 * candidate who only applies can load the core workflow alone. Core is always on.
 */
const TOOLSETS = {
  core: {
    instructions: `Core workflow (always on):
  1. discover_jobs, then list_queue and explain_job to see what fits and why.
  2. prepare_application, set_application_content, preview_application, approve_application (bound to the packet hash), submit_application.
  3. record_submission after sending by hand, record_outcome as replies arrive; list_applications, audit_log, campaign_status, reload_config.
  High volume: prepare_batch, preview_batch (read recurringQuestions), approve_batch (manifest hash and exact count), submit_batch, list_batches.
  Boards: resolve_company_board, add_company_board, scan_hiring_thread.`,
    tools: [registerDiscoveryTools, registerDraftingTools, registerSubmissionTools, registerTrackingTools, registerBatchTools],
    prompts: [],
  },
  sources: {
    instructions: `sources: list_sources, search_job_sources and scan_source_page find employer boards; leads from job alerts and funding news arrive through import_job_alert, scan_alert_inbox and fetch_funded_companies, are reviewed with list_leads (set_lead_status sets one aside), then turned into verified boards with propose_companies and accept_company_proposals. harvest_status reports the Common Crawl board harvest.`,
    tools: [registerSourceSearchTools, registerSourcingTools],
    prompts: [],
  },
  screening: {
    instructions: `screening: check_liveness before preparing or submitting (closed postings are refused), find_reposts and posting_legitimacy to spot stale or ghost postings, dismiss_job, restore_job and blacklist_company to rule postings or employers out, and evaluate_job or evaluate_posting for a deep scored report kept with save_evaluation_report.`,
    tools: [registerHygieneTools, registerEvaluationTools],
    prompts: [registerEvaluationPrompts],
  },
  documents: {
    instructions: `documents: tailor_resume renders a per-application resume from resume.json using only verified facts and checks the PDF; cover_letter_scaffold then save_cover_letter for a letter; document_status shows what is attached.`,
    tools: [registerDocumentTools],
    prompts: [registerDocumentPrompts],
  },
  followup: {
    instructions: `followup: scan_inbox and review_replies read employer replies (read-only), and each is settled by the candidate with confirm_reply or dismiss_reply; followups_due drafts follow-ups and mark_followup records them; close_stale_applications, campaign_analytics, export_tracker and interview_calendar_file report on the campaign.`,
    tools: [registerFollowupTools],
    prompts: [registerFollowupPrompts],
  },
  career: {
    instructions: `career: a story bank (story_bank_scaffold, save_story, match_stories_to_job), interview prep and debriefs, company notes, contacts and outreach drafts, and offers with compare_offers, negotiation_plan and contract_checklist.`,
    tools: [registerCareerTools],
    prompts: [registerCareerPrompts],
  },
  onboarding: {
    instructions: `onboarding: profile_status shows what the profile still lacks; update_profile, update_campaign and import_resume_text fill it in, validating and backing up each file.`,
    tools: [registerOnboardingTools],
    prompts: [registerOnboardingPrompts],
  },
  runs: {
    instructions: `runs: start_run queues long work (discovery, prepare, submit, liveness, inbox, alerts, funded, propose, harvest, close-stale) so it survives client timeouts; follow it with run_status and run_logs, stop it with cancel_run. The dashboard (npm run dashboard) shows the same runs.`,
    tools: [registerRunTools],
    prompts: [],
  },
} as const satisfies Record<string, Toolset>;

export type ToolsetName = keyof typeof TOOLSETS;

export const TOOLSET_NAMES = Object.keys(TOOLSETS) as ToolsetName[];

const isToolsetName = (name: string): name is ToolsetName => Object.hasOwn(TOOLSETS, name);

/** Reads a comma-separated toolset list. Empty or "all" enables everything; core is always included. */
export function parseToolsets(value: string | undefined): ToolsetName[] {
  const requested = (value ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
  if (requested.length === 0 || requested.includes("all")) return [...TOOLSET_NAMES];
  const unknown = requested.find((name) => !isToolsetName(name));
  if (unknown !== undefined) {
    throw new AppError("config_invalid", `unknown toolset "${unknown}" in AUTOAPPLY_TOOLSETS; choose from all, ${TOOLSET_NAMES.join(", ")}`);
  }
  const chosen = new Set<string>(["core", ...requested]);
  return TOOLSET_NAMES.filter((name) => chosen.has(name));
}

export function registerToolsets(server: McpServer, toolsets: readonly ToolsetName[]): void {
  for (const name of toolsets) {
    for (const register of TOOLSETS[name].tools) register(server);
  }
}

export function registerToolsetPrompts(server: McpServer, toolsets: readonly ToolsetName[]): void {
  for (const name of toolsets) {
    for (const register of TOOLSETS[name].prompts) register(server);
  }
}

export function toolsetInstructions(toolsets: readonly ToolsetName[]): string {
  return [`Enabled toolsets: ${toolsets.join(", ")}.`, ...toolsets.map((name) => TOOLSETS[name].instructions)].join("\n\n");
}

/** The instructions paragraph for one toolset, as the server shows it. */
export function toolsetDescription(name: ToolsetName): string {
  return TOOLSETS[name].instructions;
}
