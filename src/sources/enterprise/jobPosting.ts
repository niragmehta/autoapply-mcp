import type { CompensationRange } from "../../domain/job.js";
import { structuredPay, payPeriod } from "./compensation.js";
import { placeLabel, soleCountry } from "./country.js";
import { isoInstant, namedMonthDate } from "./dates.js";

/** The fields of a schema.org `JobPosting` this codebase uses. */
export type JobPostingFields = {
  title: string;
  descriptionHtml: string;
  postedAt: string | null;
  validThrough: string | null;
  locations: string[];
  country: "US" | "CA" | undefined;
  employmentType: string | undefined;
  isRemote: boolean;
  compensation: CompensationRange | null;
};

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") return text((value as Record<string, unknown>).name);
  return "";
}

/** iCIMS writes the literal UNAVAILABLE into address parts it has no value for. */
function addressPart(value: unknown): string {
  const part = text(value);
  return /^unavailable$/i.test(part) ? "" : part;
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function places(posting: Record<string, unknown>): { label: string; country: string }[] {
  return asList(posting.jobLocation).flatMap((place) => {
    if (!place || typeof place !== "object") return [];
    const address = (place as Record<string, unknown>).address;
    if (typeof address === "string") return address.trim() ? [{ label: address.trim(), country: "" }] : [];
    if (!address || typeof address !== "object") return [];
    const record = address as Record<string, unknown>;
    const country = addressPart(record.addressCountry);
    const label = placeLabel({ city: addressPart(record.addressLocality), region: addressPart(record.addressRegion), country });
    return label ? [{ label, country }] : [];
  });
}

function employmentType(value: unknown): string | undefined {
  const types = asList(value)
    .map((item) => text(item).toLowerCase().replace(/_/g, "-"))
    .filter((item) => item.length > 0 && item !== "other");
  return types.length > 0 ? types.join(", ") : undefined;
}

function baseSalary(value: unknown): CompensationRange | null {
  if (!value || typeof value !== "object") return null;
  const salary = value as Record<string, unknown>;
  const amount = salary.value && typeof salary.value === "object" ? salary.value as Record<string, unknown> : {};
  const single = typeof salary.value === "number" ? salary.value : amount.value;
  return structuredPay({
    min: amount.minValue ?? single,
    max: amount.maxValue ?? single,
    currency: salary.currency,
    period: payPeriod(amount.unitText ?? salary.unitText),
    raw: "schema.org baseSalary",
  });
}

/** Reads a schema.org `JobPosting` node defensively; absent fields come back empty. */
export function readJobPosting(posting: Record<string, unknown>): JobPostingFields {
  const found = places(posting);
  const locationType = text(posting.jobLocationType).toUpperCase();
  return {
    title: text(posting.title),
    descriptionHtml: typeof posting.description === "string" ? posting.description : "",
    postedAt: isoInstant(posting.datePosted) ?? namedMonthDate(posting.datePosted),
    validThrough: isoInstant(posting.validThrough),
    locations: [...new Set(found.map((place) => place.label))],
    country: soleCountry(found.map((place) => place.country)),
    employmentType: employmentType(posting.employmentType),
    isRemote: locationType === "TELECOMMUTE",
    compensation: baseSalary(posting.baseSalary),
  };
}
