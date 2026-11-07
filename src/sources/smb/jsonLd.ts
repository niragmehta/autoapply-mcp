import type { CompensationRange } from "../../domain/job.js";
import { absoluteDate } from "./dates.js";
import { payPeriod, structuredPay } from "./pay.js";

/**
 * schema.org JobPosting metadata embedded in public posting pages.
 *
 * Read as data, never executed. Only fields that are present and well-formed
 * are returned; anything else is left empty rather than guessed.
 */

export type LdPlace = { city: string; region: string; country: string };

export type JobPostingLd = {
  title: string;
  description: string;
  datePosted: string | null;
  validThrough: string | null;
  employmentType: string;
  places: LdPlace[];
  remote: boolean;
  applicantCountries: string[];
  pay: CompensationRange | null;
  identifier: string;
};

type Node = Record<string, unknown>;

// Some sites entity-encode the "+" in the type attribute ("ld&#x2B;json").
const LD_SCRIPT = /<script\b[^>]*type\s*=\s*["']application\/ld(?:\+|&#x2B;|&#43;)json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

/** Every schema.org node in a page's JSON-LD scripts, with `@graph` containers flattened. */
export function jsonLdNodes(html: string): Node[] {
  return [...html.matchAll(LD_SCRIPT)].flatMap((match) => {
    try {
      const parsed: unknown = JSON.parse(match[1] ?? "");
      return list(parsed).flatMap((entry) => isNode(entry) && Array.isArray(entry["@graph"]) ? entry["@graph"] : [entry]);
    } catch {
      return [];
    }
  }).filter(isNode);
}

function isJobPosting(node: Node): boolean {
  return list(node["@type"]).some((type) => type === "JobPosting");
}

function countryOf(value: unknown): string {
  return isNode(value) ? text(value.name) : text(value);
}

function places(value: unknown): LdPlace[] {
  return list(value).filter(isNode).map((place) => {
    const address = isNode(place.address) ? place.address : {};
    return {
      city: text(address.addressLocality),
      region: text(address.addressRegion),
      country: countryOf(address.addressCountry),
    };
  }).filter((place) => place.city || place.region || place.country);
}

function pay(value: unknown): CompensationRange | null {
  if (!isNode(value) || !isNode(value.value)) return null;
  const amount = value.value;
  const single = amount.value;
  return structuredPay(
    amount.minValue ?? single, amount.maxValue ?? single, value.currency,
    payPeriod(amount.unitText), JSON.stringify(value).slice(0, 500),
  );
}

export function readJobPostingLd(html: string): JobPostingLd | null {
  const node = jsonLdNodes(html).find(isJobPosting);
  return node ? jobPostingFromNode(node) : null;
}

/** Reads one JobPosting object, e.g. the `_jobposting` extension of a JSON Feed item. */
export function jobPostingFromNode(value: unknown): JobPostingLd | null {
  if (!isNode(value) || !isJobPosting(value)) return null;
  const node = value;
  const identifier = isNode(node.identifier) ? text(node.identifier.value) : text(node.identifier);
  return {
    title: text(node.title),
    description: text(node.description),
    datePosted: absoluteDate(node.datePosted),
    validThrough: absoluteDate(node.validThrough),
    employmentType: list(node.employmentType).map(text).filter(Boolean).join(", "),
    places: places(node.jobLocation),
    remote: list(node.jobLocationType).some((type) => text(type).toUpperCase() === "TELECOMMUTE"),
    applicantCountries: list(node.applicantLocationRequirements).map(countryOf).filter(Boolean),
    pay: pay(node.baseSalary),
    identifier,
  };
}

/** True when the posting declares an expiry that has already passed. */
export function isExpired(posting: JobPostingLd, now = new Date()): boolean {
  return posting.validThrough !== null && Date.parse(posting.validThrough) < now.getTime();
}
