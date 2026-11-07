/**
 * Classifying the fragments of a resume line: is "San Francisco, CA" a place,
 * is "Senior Software Engineer" a title, is "Acme Corp" an employer? Plain
 * vocabulary heuristics, deliberately conservative: an unclassified fragment
 * is left for the candidate to confirm rather than guessed into a field.
 */

const US_STATES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC";
const PROVINCES = "AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT";
const COUNTRIES =
  "United States|USA|U\\.S\\.A?\\.?|US|Canada|United Kingdom|UK|England|Germany|France|India|Australia|Ireland|Netherlands|Singapore|Israel|Japan|Spain|Italy|Sweden|Switzerland|Poland|Brazil|Mexico|Portugal|Denmark|Norway|Finland|Austria|Belgium|China|Korea|New Zealand";

const CITY_REGION = new RegExp(`^[A-Z][A-Za-z.' -]+,\\s*(?:${US_STATES}|${PROVINCES})(?:\\b|$)`);
const CITY_COUNTRY = new RegExp(`^[A-Z][A-Za-z.' -]+,\\s*(?:${COUNTRIES})(?:\\b|$)`);
const COUNTRY_ONLY = new RegExp(`^(?:${COUNTRIES})$`, "i");
const WORK_MODE = /^(?:remote|hybrid|on-?site)\b/i;

const COMPANY_SUFFIX =
  /\b(?:inc|llc|l\.l\.c|ltd|limited|corp|corporation|gmbh|ag|plc|s\.a|co|company|technologies|technology|labs|group|systems|solutions|partners|holdings|bank|university|ventures|studios?)\.?$/i;

const ROLE =
  /\b(?:engineer(?:ing)?|developer|programmer|architect|scientist|analyst|designer|manager|director|lead|head|principal|staff|intern(?:ship)?|consultant|specialist|administrator|officer|president|vp|founder|co-?founder|researcher|associate|coordinator|technician|owner|sre|devops|recruiter|writer|editor|teacher|professor|lecturer|assistant|advisor|strategist|cto|ceo|cfo|coo|cio|ciso|fellow|chief|mts|swe|sde)\b/i;

export function looksLikeLocation(part: string): boolean {
  const text = part.trim();
  if (COMPANY_SUFFIX.test(text)) return false;
  return WORK_MODE.test(text) || CITY_REGION.test(text) || CITY_COUNTRY.test(text) || COUNTRY_ONLY.test(text);
}

export function looksLikeTitle(part: string): boolean {
  return ROLE.test(part) && !COMPANY_SUFFIX.test(part.trim());
}

export function looksLikeCompany(part: string): boolean {
  return COMPANY_SUFFIX.test(part.trim());
}

/** Separators between title, employer and place on a header line. */
const STRONG_SEPARATOR = /\s+(?:\||\u2014|\u2013|-|\u00b7|\u2022|@)\s+|\s{2,}|\t|\s+at\s+(?=[A-Z0-9])/;
const SUFFIX_ONLY = /^(?:inc|llc|ltd|limited|corp|co|plc|gmbh|ag|s\.a)\.?$/i;

function clean(part: string): string {
  return part
    .replace(/^[\s,;:|()[\]\-\u2013\u2014]+|[\s,;:|()[\]\-\u2013\u2014]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Comma-separated fragments, keeping "City, ST" places and "Acme, Inc." names whole. */
function splitCommas(text: string): string[] {
  const segments = text.split(",").map(clean).filter(Boolean);
  const out: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const next = segments[index + 1];
    if (SUFFIX_ONLY.test(segment) && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1]}, ${segment}`;
      continue;
    }
    if (next !== undefined && looksLikeLocation(`${segment}, ${next}`)) {
      out.push(`${segment}, ${next}`);
      index += 1;
      continue;
    }
    out.push(segment);
  }
  return out;
}

/** Splits a header line into fragments: "Senior Engineer | Acme Corp | Austin, TX" gives three. */
export function splitHeader(text: string): string[] {
  return text
    .split(STRONG_SEPARATOR)
    .map(clean)
    .filter((part) => part.length > 0)
    .flatMap((part) => (part.includes(",") && !looksLikeLocation(part) ? splitCommas(part) : [part]))
    .filter((part) => /[A-Za-z]/.test(part));
}

export type HeaderFields = { title: string; company: string; location: string };

/** Assigns fragments to fields; anything unclassified fills the employer first. */
export function classifyHeader(parts: readonly string[]): HeaderFields {
  const fields: HeaderFields = { title: "", company: "", location: "" };
  const rest: string[] = [];
  for (const part of parts) {
    if (!fields.location && looksLikeLocation(part)) fields.location = part;
    else if (!fields.title && looksLikeTitle(part)) fields.title = part;
    else if (!fields.company && looksLikeCompany(part)) fields.company = part;
    else rest.push(part);
  }
  for (const part of rest) {
    if (!fields.company) fields.company = part;
    else if (!fields.title) fields.title = part;
  }
  return fields;
}
