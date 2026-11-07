/**
 * Country codes for `RawJobInput.country`. The shared classifier only uses a
 * published "US" or "CA", and only when the location text names no place it
 * recognises, so anything else maps to nothing.
 */

const US = /^(?:us|usa|u\.s\.a?\.?|united states(?: of america)?)$/i;
const CANADA = /^(?:ca|can|canada)$/i;

export function countryCode(value: unknown): "US" | "CA" | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (US.test(text)) return "US";
  if (CANADA.test(text)) return "CA";
  return undefined;
}

/**
 * The one country every published value agrees on, or nothing. A posting open
 * in the US and in India must not be pinned to the US just because one of its
 * offices is there.
 */
export function soleCountry(values: readonly unknown[]): "US" | "CA" | undefined {
  const named = values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (named.length === 0) return undefined;
  const codes = new Set(named.map((value) => countryCode(value) ?? "other"));
  if (codes.size !== 1) return undefined;
  const [only] = [...codes];
  return only === "US" || only === "CA" ? only : undefined;
}

/** The trailing country of a "City, State, Country" label, e.g. "San Diego, CA, US". */
export function trailingCountry(label: string): string {
  const parts = label.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  return parts.length > 1 ? parts[parts.length - 1] ?? "" : "";
}

const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });

/** A country's display name from an ISO code or a name: "IN" → "India", "USA" → "United States". */
export function countryName(value: string): string {
  const text = value.trim();
  const code = countryCode(text);
  if (code) return code === "US" ? "United States" : "Canada";
  if (!/^[A-Za-z]{2}$/.test(text)) return text;
  try {
    return REGION_NAMES.of(text.toUpperCase()) ?? text;
  } catch {
    return text;
  }
}

let knownCountryNames: Set<string> | null = null;

/** Whether a value is an English country name ("Germany", "United States"). */
export function isCountryName(value: string): boolean {
  if (!knownCountryNames) {
    const names = new Set<string>(["united states of america", "usa"]);
    for (let first = 65; first <= 90; first += 1) {
      for (let second = 65; second <= 90; second += 1) {
        const code = String.fromCharCode(first, second);
        const name = REGION_NAMES.of(code);
        if (name && name !== code && name !== "Unknown Region") names.add(name.toLowerCase());
      }
    }
    knownCountryNames = names;
  }
  return knownCountryNames.has(value.trim().toLowerCase());
}

/**
 * "City, Region, Country" for a structured address. Outside the US and
 * Canada the region is dropped: region codes such as Tamil Nadu's "TN" or
 * India's "IN" collide with US state codes and would place the posting in the US.
 */
export function placeLabel(parts: { city?: string | null; region?: string | null; country?: string | null }): string {
  const country = parts.country?.trim() ?? "";
  const northAmerican = country === "" || countryCode(country) !== undefined;
  return [parts.city?.trim() ?? "", northAmerican ? parts.region?.trim() ?? "" : "", country ? countryName(country) : ""]
    .filter((part) => part.length > 0)
    .join(", ");
}
