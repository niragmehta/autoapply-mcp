import type { Campaign } from "../domain/campaign.js";
import type { Evaluation, Job } from "../domain/job.js";
import type { Profile } from "../domain/profile.js";
import { buildMatchReport } from "../drafting/matchReport.js";
import { resolveNarrative } from "../drafting/narrative.js";
import type { NarrativeResolver } from "./formFields.js";

/**
 * Only Greenhouse publishes a question schema, so open-ended questions on Ashby
 * and Lever never reach drafting and arrive blank in the browser. This renders
 * the same approved narrative template against the same posting-derived topics
 * drafting would have used, so the reviewer sees a complete form.
 */
export function narrativeResolverFor(
  job: Job,
  evaluation: Evaluation | null,
  profile: Profile,
  campaign: Campaign,
): NarrativeResolver | undefined {
  if (!evaluation) return undefined;
  const report = buildMatchReport(job, evaluation, profile, campaign);
  const context = {
    company: job.companyName,
    role: job.title,
    location: job.locationsRaw[0] ?? job.locationClass,
    topics: report.matchedKeywords
      .map((entry: { term: string }) => entry.term)
      .filter((term: string) => !report.claimsToAvoid.includes(term)),
  };

  return (label: string) => {
    const resolved = resolveNarrative(label, profile, context);
    if (!resolved) return null;
    return { answer: resolved.answer, citation: resolved.citation, authorized: resolved.authorized };
  };
}
