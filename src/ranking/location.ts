import type { LocationClass } from "../domain/campaign.js";
import type { WorkplaceType } from "../domain/job.js";
import { normalizeForMatch } from "../text/html.js";

/**
 * Location classification.
 *
 * City names are not globally unique: Richmond, Vancouver, Newark, London and
 * Waterloo all exist in more than one country. Ambiguous names therefore only
 * match when the string also carries a state, province or country signal.
 */

const BAY_AREA_REGIONS = [
  "bay area",
  "sf bay",
  "san francisco bay",
  "silicon valley",
  "south bay",
  "east bay",
  "north bay",
  "peninsula ca",
];

const BAY_AREA_UNAMBIGUOUS = [
  "san francisco",
  "palo alto",
  "mountain view",
  "sunnyvale",
  "santa clara",
  "san jose",
  "menlo park",
  "redwood city",
  "cupertino",
  "foster city",
  "burlingame",
  "south san francisco",
  "emeryville",
  "milpitas",
  "los gatos",
  "san mateo",
  "san carlos",
  "los altos",
  "atherton",
  "portola valley",
  "sausalito",
  "mill valley",
  "half moon bay",
  "morgan hill",
  "gilroy",
  "san leandro",
  "castro valley",
  "orinda",
  "moraga",
  "san ramon",
  "pleasanton",
  "livermore",
  "walnut creek",
  "daly city",
  "san bruno",
  "millbrae",
  "san rafael",
  "novato",
  "petaluma",
  "rohnert park",
  "benicia",
  "vallejo",
  "alameda",
  "tiburon",
  "corte madera",
  "larkspur",
  "san anselmo",
  "sunnyvale ca",
];

/** Bay Area cities that share a name with places elsewhere. */
const BAY_AREA_AMBIGUOUS = [
  "oakland",
  "berkeley",
  "fremont",
  "newark",
  "richmond",
  "hayward",
  "concord",
  "fairfield",
  "antioch",
  "pittsburg",
  "martinez",
  "lafayette",
  "danville",
  "dublin",
  "brisbane",
  "union city",
  "belmont",
  "hillsborough",
  "saratoga",
  "campbell",
  "santa rosa",
  "pleasant hill",
  "sonoma",
  "napa",
  "brentwood",
  "clayton",
  "hercules",
  "windsor",
  "cotati",
];

const CALIFORNIA_SIGNALS = ["california", "\\bca\\b", "\\bcalif\\b", "bay area", "silicon valley"];

const CANADA_UNAMBIGUOUS = [
  "toronto",
  "montreal",
  "montréal",
  "ottawa",
  "calgary",
  "edmonton",
  "winnipeg",
  "saskatoon",
  "regina",
  "halifax",
  "mississauga",
  "brampton",
  "markham",
  "oakville",
  "kitchener",
  "burnaby",
  "coquitlam",
  "laval",
  "gatineau",
  "sherbrooke",
  "kelowna",
  "guelph",
  "oshawa",
  "vaughan",
  "richmond hill",
  "etobicoke",
  "north york",
  "quebec city",
  "moncton",
  "fredericton",
  "charlottetown",
  "st john's",
  "st. john's",
  "thunder bay",
  "sudbury",
  "barrie",
  "brossard",
  "longueuil",
  "saanich",
  "nanaimo",
  "kamloops",
  "abbotsford",
  "port coquitlam",
  "new westminster",
  "chilliwack",
  "red deer",
  "lethbridge",
  "medicine hat",
  "sarnia",
  "brantford",
  "trois-rivieres",
  "trois-rivières",
  "yellowknife",
  "whitehorse",
  "iqaluit",
];

const CANADA_AMBIGUOUS = [
  "vancouver",
  "victoria",
  "richmond",
  "london",
  "windsor",
  "waterloo",
  "surrey",
  "hamilton",
  "kingston",
  "cambridge",
  "milton",
  "delta",
  "langley",
  "whitby",
  "ajax",
  "scarborough",
  "dartmouth",
  "peterborough",
  "niagara falls",
  "chatham",
  "stratford",
  "woodstock",
  "burlington",
];

const CANADA_SIGNALS = [
  "canada",
  "canadian",
  "ontario",
  "quebec",
  "québec",
  "british columbia",
  "alberta",
  "manitoba",
  "saskatchewan",
  "nova scotia",
  "new brunswick",
  "newfoundland",
  "labrador",
  "prince edward island",
  "yukon",
  "nunavut",
  "northwest territories",
  "\\bon\\b",
  "\\bqc\\b",
  "\\bbc\\b",
  "\\bab\\b",
  "\\bmb\\b",
  "\\bsk\\b",
  "\\bns\\b",
  "\\bnb\\b",
  "\\bnl\\b",
  "\\bpe\\b",
  "\\byt\\b",
  "\\bnu\\b",
  "\\bnt\\b",
];

const US_STATE_NAMES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware",
  "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky",
  "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
  "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico",
  "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
  "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont",
  "virginia", "washington", "west virginia", "wisconsin", "wyoming", "district of columbia",
];

/**
 * State abbreviations, excluding IN, OR, ME, OK and HI: those collide with
 * common English words and full state names cover them instead.
 */
const US_STATE_ABBREVIATIONS = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "IA", "ID", "IL", "KS", "KY",
  "LA", "MA", "MD", "MI", "MN", "MO", "MS", "MT", "NC", "ND", "NE", "NH", "NJ", "NM", "NV", "NY",
  "OH", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VA", "VT", "WA", "WI", "WV", "WY",
];

const US_SIGNALS = [
  "united states",
  "\\busa\\b",
  "\\bu\\.s\\.",
  "\\bus\\b",
  "seattle",
  "austin",
  "boston",
  "chicago",
  "denver",
  "atlanta",
  "los angeles",
  "san diego",
  "portland",
  "new york city",
  ...US_STATE_NAMES,
  ...US_STATE_ABBREVIATIONS.map((code) => `\\b${code.toLowerCase()}\\b`),
];

const REMOTE_SIGNALS = ["remote", "work from home", "wfh", "distributed", "anywhere", "virtual"];
const HYBRID_SIGNALS = ["hybrid", "flexible onsite", "in-office days"];
const ONSITE_SIGNALS = ["on-site", "onsite", "in office", "in-office"];

function matchesAny(haystack: string, needles: readonly string[]): string | null {
  for (const needle of needles) {
    const pattern = needle.includes("\\b") ? new RegExp(needle, "i") : new RegExp(`(^|[^a-z0-9])${escapeRegex(needle)}([^a-z0-9]|$)`, "i");
    if (pattern.test(haystack)) return needle.replace(/\\b/g, "");
  }
  return null;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type LocationAnalysis = {
  locationClass: LocationClass;
  country: string;
  workplaceType: WorkplaceType;
  matched: string;
};

export type LocationHints = {
  isRemote?: boolean;
  workplaceType?: WorkplaceType;
};

function detectWorkplace(text: string, hints: LocationHints): WorkplaceType {
  if (hints.workplaceType && hints.workplaceType !== "unknown") return hints.workplaceType;
  if (matchesAny(text, HYBRID_SIGNALS)) return "hybrid";
  if (hints.isRemote === true) return "remote";
  if (matchesAny(text, REMOTE_SIGNALS)) return "remote";
  if (matchesAny(text, ONSITE_SIGNALS)) return "onsite";
  return "unknown";
}

function classifyOne(raw: string, hints: LocationHints): LocationAnalysis {
  const text = normalizeForMatch(raw);
  const workplaceType = detectWorkplace(text, hints);
  const isRemote = workplaceType === "remote";

  const hasCanadaSignal = matchesAny(text, CANADA_SIGNALS);
  const hasCaliforniaSignal = matchesAny(text, CALIFORNIA_SIGNALS);
  const hasUsSignal = matchesAny(text, US_SIGNALS);

  const bayHit =
    matchesAny(text, BAY_AREA_REGIONS) ??
    matchesAny(text, BAY_AREA_UNAMBIGUOUS) ??
    (hasCaliforniaSignal && !hasCanadaSignal ? matchesAny(text, BAY_AREA_AMBIGUOUS) : null);

  // Only a named place counts as a physical location; a bare country or
  // province signal alongside "remote" is a remote scope, not an office.
  const canadaCityHit =
    matchesAny(text, CANADA_UNAMBIGUOUS) ?? (hasCanadaSignal ? matchesAny(text, CANADA_AMBIGUOUS) : null);

  if (isRemote && !canadaCityHit && !bayHit) {
    if (hasCanadaSignal) return { locationClass: "remote-canada", country: "CA", workplaceType, matched: hasCanadaSignal };
    if (hasUsSignal) return { locationClass: "remote-us", country: "US", workplaceType, matched: hasUsSignal };
    return { locationClass: "remote-global", country: "unknown", workplaceType, matched: "remote" };
  }

  // A Canadian signal wins over an ambiguous Bay Area name (Richmond, Windsor).
  const canadaHit = canadaCityHit ?? (hasCanadaSignal && !bayHit ? hasCanadaSignal : null);
  if (canadaHit && (!bayHit || hasCanadaSignal)) {
    return { locationClass: "canada", country: "CA", workplaceType, matched: canadaHit };
  }
  if (bayHit) {
    return { locationClass: "bay-area", country: "US", workplaceType, matched: bayHit };
  }
  if (hasUsSignal) return { locationClass: "us-other", country: "US", workplaceType, matched: hasUsSignal };
  if (text.length === 0) return { locationClass: "unknown", country: "unknown", workplaceType, matched: "" };
  return { locationClass: "other", country: "unknown", workplaceType, matched: text.slice(0, 40) };
}

const CLASS_PRIORITY: Record<LocationClass, number> = {
  "bay-area": 100,
  canada: 90,
  "remote-canada": 80,
  "remote-us": 60,
  "us-other": 50,
  "remote-global": 40,
  other: 20,
  unknown: 10,
};

/**
 * Classifies a posting that may list several offices, keeping the strongest
 * match so a "Toronto / New York / Remote" listing is not discarded.
 */
export function analyzeLocation(rawLocations: readonly string[], hints: LocationHints = {}): LocationAnalysis {
  const candidates = rawLocations.filter((value) => typeof value === "string" && value.trim().length > 0);
  if (candidates.length === 0) {
    const workplaceType = hints.workplaceType ?? (hints.isRemote ? "remote" : "unknown");
    return { locationClass: "unknown", country: "unknown", workplaceType, matched: "" };
  }
  const analyses = candidates.map((value) => classifyOne(value, hints));
  return analyses.reduce((best, current) =>
    CLASS_PRIORITY[current.locationClass] > CLASS_PRIORITY[best.locationClass] ? current : best,
  );
}

export function allLocationClasses(rawLocations: readonly string[], hints: LocationHints = {}): LocationClass[] {
  const classes = rawLocations
    .filter((value) => value.trim().length > 0)
    .map((value) => classifyOne(value, hints).locationClass);
  return [...new Set(classes)];
}
