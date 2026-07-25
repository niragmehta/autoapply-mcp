import type { Company } from "../domain/campaign.js";
import { exactFingerprint, roleFingerprint } from "../domain/fingerprint.js";
import type { CompensationRange, Job, WorkplaceType } from "../domain/job.js";
import { analyzeLocation } from "../ranking/location.js";
import { parseCompensationFromText } from "../ranking/compensation.js";
import { htmlToText } from "../text/html.js";
import { shortHash } from "../util/hash.js";

/** Shared normalization so every adapter produces an identical Job shape. */

export type RawJobInput = {
  company: Company;
  externalId: string;
  title: string;
  locations: string[];
  url: string;
  applyUrl: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  postedAt?: string | null;
  workplaceType?: WorkplaceType;
  isRemote?: boolean;
  employmentType?: string;
  structuredCompensation?: CompensationRange | null;
};

function fallbackCurrency(country: string): string {
  return country === "CA" ? "CAD" : "USD";
}

export function normalizeJob(input: RawJobInput, capturedAt: string): Job {
  const descriptionText = (input.descriptionPlain?.trim().length ?? 0) > 0
    ? (input.descriptionPlain as string)
    : htmlToText(input.descriptionHtml ?? "");

  const location = analyzeLocation(input.locations, {
    isRemote: input.isRemote,
    workplaceType: input.workplaceType,
  });

  const compensation =
    input.structuredCompensation ?? parseCompensationFromText(descriptionText, fallbackCurrency(location.country));

  const externalId = input.externalId || shortHash(input.url, 12);

  return {
    id: `job_${exactFingerprint(input.company.ats, input.company.board, externalId)}`,
    fingerprint: roleFingerprint(input.company.name, input.title, location.locationClass),
    ats: input.company.ats,
    companyName: input.company.name,
    companyTier: input.company.tier,
    board: input.company.board,
    externalId,
    title: input.title.trim(),
    locationsRaw: input.locations.filter((value) => value.trim().length > 0),
    locationClass: location.locationClass,
    country: location.country,
    workplaceType: location.workplaceType,
    employmentType: (input.employmentType ?? "unknown").toLowerCase(),
    url: input.url,
    applyUrl: input.applyUrl || input.url,
    descriptionText,
    descriptionHash: shortHash(descriptionText, 20),
    compensation,
    postedAt: input.postedAt ?? null,
    capturedAt,
  };
}

export function epochToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const millis = value > 1e12 ? value : value * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
