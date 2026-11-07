/**
 * Country evidence published by an ATS, separate from free-text locations.
 *
 * Only "US" and "CA" are meaningful to the location classifier; any other
 * country is still passed on as a restriction so a foreign-only posting is
 * not mistaken for a worldwide remote role.
 */

const US = /^(?:us|usa|u\.s\.(?:a\.)?|united states(?: of america)?)$/i;
const CA = /^(?:ca|can|canada)$/i;

/** "US" or "CA" for those countries, an upper-cased ISO code for others, else null. */
export function countryCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (US.test(text)) return "US";
  if (CA.test(text)) return "CA";
  return /^[a-z]{2}$/i.test(text) ? text.toUpperCase() : null;
}

/** The single North American country a posting publishes, when all its countries agree. */
export function publishedCountry(values: ReadonlyArray<unknown>): "US" | "CA" | undefined {
  const codes = new Set(values
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => countryCode(value) ?? String(value).trim().toLowerCase()));
  if (codes.size !== 1) return undefined;
  const [only] = [...codes];
  return only === "US" || only === "CA" ? only : undefined;
}

/** Published country names or codes, for the foreign-only restriction check. */
export function countryValues(values: ReadonlyArray<unknown>): string[] {
  return [...new Set(values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim()))];
}
