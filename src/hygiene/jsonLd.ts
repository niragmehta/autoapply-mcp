import { htmlToText } from "../text/html.js";

/**
 * schema.org JobPosting metadata, read from a page's JSON-LD blocks.
 *
 * Most career sites publish it for search engines, which makes it the one
 * structured description of a posting that works on hosts without an adapter.
 * The page is untrusted: values are read defensively and nothing in it is
 * executed or followed.
 */

export type JsonLdSalary = {
  min: number | null;
  max: number | null;
  currency: string;
  unit: string;
  raw: string;
};

export type JsonLdJobPosting = {
  title: string;
  /** HTML or text, as published. */
  description: string;
  hiringOrganization: string | null;
  locations: string[];
  countries: string[];
  remote: boolean;
  datePosted: string | null;
  validThrough: string | null;
  salary: JsonLdSalary | null;
  employmentType: string;
  identifier: string | null;
  url: string | null;
};

type Json = unknown;

function record(value: Json): Record<string, Json> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Json>) : null;
}

function list(value: Json): Json[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: Json): string {
  if (typeof value === "string") return htmlToText(value).trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function named(value: Json): string {
  const object = record(value);
  return object ? text(object.name) : text(value);
}

function isJobPosting(value: Json): boolean {
  const object = record(value);
  if (!object) return false;
  return list(object["@type"]).some((type) => typeof type === "string" && type.toLowerCase() === "jobposting");
}

function collect(value: Json, found: Record<string, Json>[], depth = 0): void {
  if (depth > 4) return;
  if (Array.isArray(value)) {
    for (const item of value) collect(item, found, depth + 1);
    return;
  }
  const object = record(value);
  if (!object) return;
  if (isJobPosting(object)) found.push(object);
  if (object["@graph"] !== undefined) collect(object["@graph"], found, depth + 1);
}

function address(value: Json): { label: string; country: string } {
  const place = record(value);
  const raw = place ? (place.address ?? place) : value;
  if (typeof raw === "string") return { label: text(raw), country: "" };
  const parts = record(raw);
  if (!parts) return { label: "", country: "" };
  const country = named(parts.addressCountry);
  const label = [text(parts.addressLocality), text(parts.addressRegion), country]
    .filter((part, index, all) => part.length > 0 && all.indexOf(part) === index)
    .join(", ");
  return { label, country };
}

function amount(value: Json): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return null;
}

function salary(value: Json): JsonLdSalary | null {
  const object = record(value);
  if (!object) return null;
  const currency = text(object.currency).toUpperCase();
  const inner = record(object.value);
  const min = amount(inner?.minValue ?? null) ?? amount(inner?.value ?? null) ?? amount(object.value);
  const max = amount(inner?.maxValue ?? null) ?? amount(inner?.value ?? null) ?? amount(object.value);
  if (min === null && max === null) return null;
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  return {
    min,
    max,
    currency,
    unit: text(inner?.unitText ?? object.unitText).toUpperCase(),
    raw: JSON.stringify(value).slice(0, 300),
  };
}

function identifier(value: Json): string | null {
  const object = record(value);
  const raw = object ? (object.value ?? object["@id"] ?? object.name) : value;
  const result = text(raw);
  return result.length > 0 ? result.slice(0, 200) : null;
}

function toPosting(object: Record<string, Json>): JsonLdJobPosting | null {
  const title = text(object.title);
  if (title.length === 0) return null;
  const places = list(object.jobLocation).map(address).filter((place) => place.label.length > 0);
  const applicantRegions = list(object.applicantLocationRequirements).map(named).filter((name) => name.length > 0);
  const remote = list(object.jobLocationType).some((type) => typeof type === "string" && /telecommute/i.test(type));
  const locations = [
    ...places.map((place) => place.label),
    ...(remote ? applicantRegions.map((region) => `Remote - ${region}`) : []),
  ];
  return {
    title,
    description: typeof object.description === "string" ? object.description : "",
    hiringOrganization: named(object.hiringOrganization) || null,
    locations: [...new Set(remote && locations.length === 0 ? ["Remote"] : locations)],
    countries: [...new Set([...places.map((place) => place.country), ...applicantRegions].filter((value) => value.length > 0))],
    remote,
    datePosted: text(object.datePosted) || null,
    validThrough: text(object.validThrough) || null,
    salary: salary(object.baseSalary),
    employmentType: list(object.employmentType).map(text).filter((value) => value.length > 0).join(", "),
    identifier: identifier(object.identifier),
    url: typeof object.url === "string" ? object.url : null,
  };
}

const LD_SCRIPT = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;

/** Every JobPosting described by the page's JSON-LD, in page order. Malformed blocks are skipped. */
export function extractJobPostings(html: string): JsonLdJobPosting[] {
  const found: Record<string, Json>[] = [];
  for (const match of html.matchAll(LD_SCRIPT)) {
    const raw = (match[1] ?? "").trim().replace(/^<!\[CDATA\[|\]\]>$/g, "");
    if (raw.length === 0 || raw.length > 2_000_000) continue;
    try {
      collect(JSON.parse(raw) as Json, found);
    } catch {
      // A malformed block says nothing about the posting; other blocks may still parse.
    }
  }
  return found.map(toPosting).filter((posting): posting is JsonLdJobPosting => posting !== null);
}
