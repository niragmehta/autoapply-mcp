import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PROMPT_GROUND_RULES, userPrompt } from "./helpers.js";

/** Conversational onboarding that builds the profile. */

const ONBOARD = [
  "Onboard this candidate onto autoapply-mcp by conversation. They should never have to edit JSON by hand, except personal and demographic details, which stay hand-edited.",
  "",
  "1. Call profile_status. Summarize readiness in two sentences and list the sections you will cover. If profile.json or campaign.json does not exist, ask the candidate to run `npm run init`, then call profile_status again.",
  "2. Work through these sections in order, skipping any that profile_status shows complete. Ask one topic at a time and keep questions short.",
  "   a. Target roles and tracks: the roles, seniority and domains they want. Map each role family to a campaign track (titleIncludes, titleExcludes, weighted keywords, resumeId) with update_campaign.",
  "   b. Locations: cities, regions and remote scope they will accept. Set campaign.locations.allow and workplaceTypes with update_campaign.",
  "   c. Compensation: the floor (minimumTotal) and the target (targetTotal) with currency, plus per-country campaign floors. Read the numbers back before writing them.",
  "   d. Work authorization: for every country the campaign targets, ask directly whether they are a citizen, already authorized, able to work without employer sponsorship, or need sponsorship. Never assume and never infer it from a name, an employer, a location or the resume. Write only what they state, with update_profile, and read the statement back to them.",
  "   e. Dealbreakers and do-not-apply companies: title and description exclusions and excluded companies (campaign.exclusions), and the do-not-apply list (campaign.hygiene.blacklist).",
  "   f. CV import: ask them to paste their resume as text and call import_resume_text. Walk through each experience entry, education entry and skill; correct what is wrong and fill every field in needsConfirmation; then append the confirmed entries to /experience, /education and /skills with update_profile.",
  "   g. Facts with metrics: for their strongest achievements ask for the concrete numbers and the context. Save each as a fact {id, statement, metrics, tags}. Never round up, estimate or invent a metric.",
  "   h. Recurring application answers: profile_status lists blank and REVIEW-flagged answers. Go through the common ones (start date, notice period, relocation, how they heard about the role) and record each with update_profile at /answers/<index>/answer. Leave demographic, disability, veteran and criminal-history answers for the candidate to edit by hand.",
  "   i. Resume files: confirm the file path of each resume variant (/resumes/<index>/path) and which tracks it serves. Each track's resumeId must name one of them.",
  "3. Write each confirmed answer immediately with one small update_profile or update_campaign call, then move on. If a write is rejected, read the validation message, fix the value with the candidate and retry. Never write a value they did not give or confirm.",
  "4. Finish with profile_status. Report readiness and any remaining blockers, and suggest `npm run doctor -- --probe` to verify resume files and boards.",
  "",
  "Submission stays in manual mode and submission.allowedCompanies stays empty unless the candidate explicitly decides otherwise.",
  "",
  PROMPT_GROUND_RULES,
].join("\n");

const CAMPAIGN_SETUP = [
  "Tune this candidate's campaign to their goals.",
  "",
  "1. Call profile_status and campaign_status to see the tracks, thresholds, queue depth and the most common rejection reasons.",
  "2. Ask about their goals: role families, seniority, domains, locations, pay floor, how many applications a week, and companies to avoid.",
  "3. Tracks: one track per distinct role family. titleIncludes holds phrases that must appear in a title, titleExcludes the ones that rule a title out, and keywords are weighted from 3 (core) to 1 (nice to have), drawn only from skills and facts the profile already verifies. Allocation shares should add up to 1, and each track's resumeId must name a resume variant.",
  "4. Thresholds: scoring.thresholds tierA, tierB and tierC. If the queue is thin, lower tierC a few points at a time; if it is noisy, raise it. Adjust freshnessDays to how fresh a posting must be.",
  "5. Exclusions: title and description patterns that are dealbreakers, excluded companies, and the hygiene blacklist for employers they never want to hear from.",
  "6. Submission: mode stays manual unless they explicitly choose assisted or auto. Set dailyLimit and maxPerCompany to the pace they want. Add to allowedCompanies only on their explicit instruction.",
  "7. Write each change with update_campaign, then run discover_jobs and list_queue to show the effect, and iterate.",
  "",
  PROMPT_GROUND_RULES,
].join("\n");

export function registerOnboardingPrompts(server: McpServer): void {
  server.registerPrompt(
    "onboard",
    {
      title: "Onboard: build the profile by conversation",
      description:
        "Guides the agent through conversational onboarding: readiness check, target roles, locations, pay, work authorization, dealbreakers, CV import, facts, recurring answers and resume files, saving each confirmed answer as it goes.",
      argsSchema: {
        focus: z.string().optional().describe("Optional section to start with, for example 'work authorization' or 'resume import'."),
      },
    },
    (args: { focus?: string }) =>
      userPrompt(args.focus?.trim() ? `${ONBOARD}\n\nStart with this section: ${args.focus.trim()}.` : ONBOARD),
  );

  server.registerPrompt(
    "campaign_setup",
    {
      title: "Campaign setup: tracks, keywords and thresholds",
      description: "Tunes the campaign's tracks, keywords, thresholds, exclusions and pace to the candidate's goals.",
      argsSchema: {
        goal: z.string().optional().describe("Optional goal in the candidate's words, for example 'staff security roles in Toronto'."),
      },
    },
    (args: { goal?: string }) =>
      userPrompt(args.goal?.trim() ? `${CAMPAIGN_SETUP}\n\nThe candidate's stated goal: ${args.goal.trim()}` : CAMPAIGN_SETUP),
  );
}
