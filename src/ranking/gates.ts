import type { Campaign } from "../domain/campaign.js";
import type { GateResult, Job } from "../domain/job.js";
import type { Profile } from "../domain/profile.js";
import { snippetAround } from "../text/html.js";
import { daysBetween, parseDateSafe } from "../util/hash.js";
import { checkCompensationFloor } from "./compensation.js";

/**
 * Deterministic exclusion gates.
 *
 * These run before scoring. A gate failure is a hard stop with a quotable
 * reason, so a rejection can always be explained and audited.
 */

const SENIORITY_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ["intern", /\b(intern|internship|co-?op|apprentice)\b/i],
  ["new-grad", /\b(new ?grad|graduate program|university grad|early career)\b/i],
  ["junior", /\b(junior|jr\.?|entry[- ]level|associate engineer|\bi{1,2}\b(?= engineer))\b/i],
  ["executive", /\b(chief|cto|ciso|cio|vp|vice president|head of|svp|evp)\b/i],
  ["director", /\bdirector\b/i],
  ["manager", /\b(engineering manager|people manager|\bmanager\b)\b/i],
  ["principal", /\b(principal|distinguished|fellow|architect)\b/i],
  ["staff", /\b(staff|lead engineer|tech lead|technical lead)\b/i],
  ["senior", /\b(senior|sr\.?|snr)\b/i],
];

export function detectSeniority(title: string): string {
  for (const [level, pattern] of SENIORITY_RULES) {
    if (pattern.test(title)) return level;
  }
  return "unspecified";
}

const NO_SPONSORSHIP_PATTERNS: readonly RegExp[] = [
  /\b(?:un(?:able|willing)|not able|cannot|can not|can't|do(?:es)? not|will not|won't)\b[^.\n]{0,60}\bsponsor/i,
  /\bno\b[^.\n]{0,20}\b(?:visa|immigration|work)?\s*sponsorship/i,
  /\bnot eligible for\b[^.\n]{0,30}\bsponsorship/i,
  /\bwithout\b[^.\n]{0,40}\bsponsorship\b[^.\n]{0,40}\b(?:now or in the future|currently or in the future)/i,
  /\bauthorized to work in the united states\b[^.\n]{0,60}\bwithout\b[^.\n]{0,30}\bsponsorship/i,
  /\bdoes not (?:provide|offer)\b[^.\n]{0,40}\bsponsorship/i,
];

const CITIZENSHIP_PATTERNS: readonly RegExp[] = [
  /\b(?:must be|require[sd]?|only)\b[^.\n]{0,60}\bu\.?s\.?\s*citizen/i,
  /\bu\.?s\.?\s*citizenship\b[^.\n]{0,30}\b(?:is\s+)?(?:required|mandatory)/i,
  /\bmust be a (?:united states|u\.?s\.?) (?:citizen|person)/i,
  /\bu\.?s\.?\s*person(?:s)?\b[^.\n]{0,40}\b(?:itar|export control)/i,
  /\b(?:itar|export control)[^.\n]{0,60}\bu\.?s\.?\s*person/i,
];

const CLEARANCE_PATTERNS: readonly RegExp[] = [
  /\b(?:security clearance|ts\/sci|top secret|secret clearance|public trust|dod clearance|sci\b)/i,
  /\bactive\b[^.\n]{0,20}\bclearance\b/i,
];

/** Equal-opportunity boilerplate mentions citizenship without requiring it. */
const NEGATIVE_CONTEXT = /(without regard to|regardless of|does not discriminate|equal (?:employment )?opportunity|protected (?:by law|characteristic|veteran))/i;

function findPattern(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const contextStart = Math.max(0, match.index - 160);
    const context = text.slice(contextStart, match.index + match[0].length + 60);
    if (NEGATIVE_CONTEXT.test(context)) continue;
    return match[0].replace(/\s+/g, " ").trim();
  }
  return null;
}

function pass(): GateResult {
  return { passed: true, rule: null, reason: "all gates passed", evidence: "" };
}

function fail(rule: string, reason: string, evidence = ""): GateResult {
  return { passed: false, rule, reason, evidence: evidence.slice(0, 300) };
}

/**
 * Exclusion matching. Single-word patterns match on word boundaries so "sales"
 * does not exclude "Salesforce"; multi-word patterns match as phrases.
 */
function matchesAnyPattern(value: string, patterns: readonly string[]): string | null {
  const haystack = value.toLowerCase();
  for (const raw of patterns) {
    const needle = raw.toLowerCase().trim();
    if (needle.length === 0) continue;
    if (needle.includes(" ")) {
      if (haystack.includes(needle)) return raw;
      continue;
    }
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack)) return raw;
  }
  return null;
}

export type GateContext = {
  campaign: Campaign;
  profile: Profile;
  now?: Date;
};

/** Runs every hard gate in order and returns the first failure. */
export function evaluateGates(job: Job, context: GateContext): GateResult {
  const { campaign, profile } = context;
  const now = context.now ?? new Date();
  const description = job.descriptionText ?? "";

  const excludedCompany = matchesAnyPattern(job.companyName, campaign.exclusions.companies);
  if (excludedCompany) return fail("company-excluded", `company on exclusion list: ${excludedCompany}`);

  const excludedTitle = matchesAnyPattern(job.title, campaign.exclusions.titlePatterns);
  if (excludedTitle) return fail("title-excluded", `title matches exclusion "${excludedTitle}"`, job.title);

  const seniority = detectSeniority(job.title);
  if (campaign.seniority.reject.includes(seniority)) {
    return fail("seniority-rejected", `detected seniority "${seniority}" is excluded`, job.title);
  }
  if (campaign.seniority.allow.length > 0 && !campaign.seniority.allow.includes(seniority)) {
    return fail("seniority-not-allowed", `detected seniority "${seniority}" is not in the allow list`, job.title);
  }

  if (!campaign.locations.allow.includes(job.locationClass)) {
    return fail(
      "location-not-allowed",
      `location class "${job.locationClass}" is not allowed`,
      job.locationsRaw.join(" | "),
    );
  }

  if (!campaign.locations.workplaceTypes.includes(job.workplaceType)) {
    return fail("workplace-type-not-allowed", `workplace type "${job.workplaceType}" is not allowed`);
  }

  const excludedByPattern = matchesAnyPattern(description, campaign.exclusions.descriptionPatterns);
  if (excludedByPattern) {
    return fail("description-excluded", `description matches exclusion "${excludedByPattern}"`, snippetAround(description, excludedByPattern));
  }

  const clearance = findPattern(description, CLEARANCE_PATTERNS);
  if (clearance) return fail("clearance-required", "posting requires a government security clearance", clearance);

  const authGate = evaluateWorkAuthorizationGate(job, profile);
  if (!authGate.passed) return authGate;

  const compensationCheck = checkCompensationFloor(job.compensation, job.country, campaign.compensation);
  if (compensationCheck.status === "below" && campaign.compensation.rejectBelowFloor) {
    return fail("compensation-below-floor", compensationCheck.reason, job.compensation?.raw ?? "");
  }
  if (compensationCheck.status === "unknown" && !campaign.compensation.allowUnknown) {
    return fail("compensation-unknown", "no published compensation and unknown values are not allowed");
  }

  const posted = parseDateSafe(job.postedAt);
  if (posted && daysBetween(posted, now) > campaign.freshnessDays) {
    return fail("stale-posting", `posted ${Math.round(daysBetween(posted, now))} days ago`, job.postedAt ?? "");
  }

  return pass();
}

/**
 * Work authorization is evaluated per country. A "must be authorized in Canada"
 * line is fine for a Canadian citizen, and a "we do not sponsor" line is not
 * disqualifying in a country the candidate can work in without sponsorship,
 * such as a Canadian using TN status under USMCA.
 */
export function evaluateWorkAuthorizationGate(job: Job, profile: Profile): GateResult {
  const country = job.country.toUpperCase();
  const description = job.descriptionText ?? "";
  const authorized = profile.workAuthorization.authorizedIn.map((code) => code.toUpperCase());
  const noSponsorshipNeeded = profile.workAuthorization.noSponsorshipRequiredIn.map((code) => code.toUpperCase());
  const needsSponsorship = profile.workAuthorization.requiresSponsorshipIn.map((code) => code.toUpperCase());

  if (authorized.includes(country)) return pass();

  // Citizenship and clearance requirements are absolute; no visa route satisfies
  // them, so they gate out regardless of the sponsorship position.
  const citizenship = findPattern(description, CITIZENSHIP_PATTERNS);
  if (citizenship) {
    return fail("citizenship-required", "posting requires citizenship the candidate does not hold", citizenship);
  }

  if (noSponsorshipNeeded.includes(country)) return pass();

  if (needsSponsorship.includes(country) || country === "UNKNOWN") {
    const noSponsorship = findPattern(description, NO_SPONSORSHIP_PATTERNS);
    if (noSponsorship) {
      return fail("sponsorship-unavailable", "employer states it will not sponsor work authorization", noSponsorship);
    }
  }

  return pass();
}
