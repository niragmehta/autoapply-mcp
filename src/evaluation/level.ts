import type { Campaign } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import type { ExperienceAssessment } from "../hygiene/experienceYears.js";
import { detectSeniority } from "../ranking/gates.js";

/**
 * The posting's level against the level the candidate is aiming for.
 *
 * The posting's level reads the title first, then raises it when the stated
 * years or the scope language ask for more. The candidate's level comes from
 * their professional years, mapped on common industry bands (under 2 years
 * junior, 2-5 mid, 5-8 senior, 8-12 staff, 12+ principal), and from the
 * campaign's seniority allow list. These bands are heuristics; the advice is
 * framed so the candidate never claims a title or years they do not have.
 */

type LevelFit = "stretch" | "at-level" | "below-level";

export type LevelAssessment = {
  postingLevel: string;
  postingSignals: string[];
  candidateLevel: string;
  candidateBasis: string;
  targetLevels: string[];
  fit: LevelFit;
  advice: string[];
};

const LADDER: Readonly<Record<string, number>> = {
  intern: 0,
  "new-grad": 1,
  junior: 2,
  unspecified: 3,
  mid: 3,
  senior: 4,
  staff: 5,
  manager: 5,
  principal: 6,
  director: 7,
  executive: 8,
};
const BY_INDEX = ["intern", "new-grad", "junior", "mid", "senior", "staff", "principal", "director", "executive"];

const SCOPE_LANGUAGE =
  /\b(?:set (?:the )?technical (?:direction|strategy|vision)|org(?:anization)?[- ]wide|across (?:multiple|several) teams|own the (?:technical )?(?:roadmap|strategy|architecture)|lead (?:a team|teams|engineers)|technical leadership|architect(?:ure)? (?:for|across) the|mentor (?:senior|other) engineers|direct reports|people management)\b/i;

function levelFromYears(years: number): string {
  if (years < 2) return "junior";
  if (years < 5) return "mid";
  if (years < 8) return "senior";
  if (years < 12) return "staff";
  return "principal";
}

export function assessLevel(job: Pick<Job, "title" | "descriptionText">, campaign: Campaign, experience: ExperienceAssessment): LevelAssessment {
  const titleLevel = detectSeniority(job.title);
  const signals = [`title reads as "${titleLevel}"`];
  let postingIndex = LADDER[titleLevel] ?? 3;

  const required = experience.required.minYears;
  if (required !== null) {
    const yearsLevel = levelFromYears(required);
    signals.push(`asks for ${required}+ years (${yearsLevel} band)`);
    postingIndex = Math.max(postingIndex, LADDER[yearsLevel] ?? postingIndex);
  }
  const scope = SCOPE_LANGUAGE.exec(job.descriptionText ?? "");
  if (scope && postingIndex <= LADDER.senior!) {
    signals.push(`scope language: "${scope[0]}"`);
    postingIndex += 1;
  }
  const postingLevel = BY_INDEX[Math.min(postingIndex, BY_INDEX.length - 1)] ?? "mid";

  const years = experience.candidate.years;
  const candidateLevel = levelFromYears(years);
  const candidateIndex = LADDER[candidateLevel] ?? 3;
  const targetLevels = campaign.seniority.allow.filter((level) => level !== "unspecified");
  const targetIndices = targetLevels.map((level) => LADDER[level]).filter((value): value is number => value !== undefined);
  const lowestTarget = targetIndices.length > 0 ? Math.min(...targetIndices) : candidateIndex;

  const fit: LevelFit =
    postingIndex > candidateIndex || experience.overTolerance
      ? "stretch"
      : postingIndex < lowestTarget || postingIndex <= candidateIndex - 2
        ? "below-level"
        : "at-level";

  const advice: Record<LevelFit, string[]> = {
    stretch: [
      "Lead with scope: the largest systems, decisions and teams in your verified facts, in the posting's own vocabulary.",
      "Quantify with the metrics already in profile.facts; never round up a title or years of experience.",
      "If they suggest a lower level: accept if the pay is fair, and ask for a six-month review against written promotion criteria.",
    ],
    "at-level": [
      "Mirror the posting's language for ownership and scope with your strongest matching facts.",
      "Confirm the level and pay band in the first recruiter conversation.",
    ],
    "below-level": [
      "Confirm the level and pay band early; a lower band can cap the offer regardless of interviews.",
      "Ask how quickly the role can grow into the next level, and what the criteria are.",
    ],
  };

  return {
    postingLevel,
    postingSignals: signals,
    candidateLevel,
    candidateBasis: experience.candidate.detail,
    targetLevels,
    fit,
    advice: advice[fit],
  };
}
