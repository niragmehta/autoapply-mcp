import { z } from "zod";
import { AppError } from "../util/errors.js";
import { normalizeForMatch } from "../text/html.js";

type LocationDriver = {
  search(query: string): Promise<void>;
  options(): Promise<string[]>;
  pick(index: number): Promise<void>;
  selection(): Promise<unknown>;
  hasChallenge(): Promise<boolean>;
};

const selectionSchema = z.object({ display: z.string(), encoded: z.string() });
const locationSchema = z.object({ name: z.string() });

function retainedLocationError(): AppError {
  return new AppError("location_not_verified", "Lever did not retain the selected current location");
}

const COUNTRY_ALIASES: Record<string, string> = {
  "canada": "can", "can": "can", "ca": "can",
  "united states": "usa", "united states of america": "usa", "usa": "usa", "us": "usa", "u s a": "usa",
  "united kingdom": "gbr", "uk": "gbr", "gbr": "gbr", "gb": "gbr",
};

function canonicalCountry(part: string): string {
  const normalized = normalizeForMatch(part);
  return COUNTRY_ALIASES[normalized] ?? normalized;
}

/**
 * Lever renders its own canonical location strings - "Vancouver, BC, CAN" -
 * while a profile records the same place as "Vancouver, British Columbia,
 * Canada". Byte equality therefore rejects the one correct suggestion in the
 * native list and the required field is left blank. Regions are compared by
 * acronym or prefix so "BC" and "British Columbia" agree, which is a
 * difference of notation rather than of place.
 */
function sameRegion(actual: string, approved: string): boolean {
  const left = normalizeForMatch(actual);
  const right = normalizeForMatch(approved);
  if (!left || !right) return !left && !right;
  if (left === right) return true;
  const acronym = (value: string) => value.split(" ").filter(Boolean).map((word) => word[0]).join("");
  if (acronym(left) === right || acronym(right) === left) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.length >= 2 && longer.startsWith(shorter);
}

function splitLocation(value: string): { city: string; region: string; country: string } {
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  const city = normalizeForMatch(parts[0] ?? "");
  if (parts.length <= 1) return { city, region: "", country: "" };
  const country = canonicalCountry(parts[parts.length - 1] ?? "");
  return { city, region: parts.slice(1, -1).join(" "), country };
}

/**
 * Both sides must name the same city and the same country, so "Vancouver, WA,
 * USA" is still rejected for an approved "Vancouver, British Columbia,
 * Canada". A region is only compared when both strings state one.
 */
function sameLocation(actual: string, approved: string): boolean {
  if (normalizeForMatch(actual) === normalizeForMatch(approved)) return true;
  const left = splitLocation(actual);
  const right = splitLocation(approved);
  if (!left.city || left.city !== right.city) return false;
  if (!left.country || !right.country || left.country !== right.country) return false;
  if (!left.region || !right.region) return true;
  return sameRegion(left.region, right.region);
}

async function verifySelection(ui: LocationDriver, approved: string): Promise<void> {
  const result = selectionSchema.safeParse(await ui.selection());
  if (!result.success || !result.data.encoded) throw retainedLocationError();
  let selected: unknown;
  try {
    selected = JSON.parse(result.data.encoded);
  } catch (error) {
    if (error instanceof SyntaxError) throw retainedLocationError();
    throw error;
  }
  const native = locationSchema.safeParse(selected);
  if (!native.success || !sameLocation(result.data.display, approved)
    || !sameLocation(native.data.name, approved)) throw retainedLocationError();
}

export async function fillLeverLocation(ui: LocationDriver, candidates: readonly string[]): Promise<void> {
  const queries = [...new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean))];
  const approved = queries[0];
  if (!approved) throw new AppError("location_missing", "No approved current location was supplied");
  for (const query of queries) {
    if (await ui.hasChallenge()) throw new AppError("captcha_required", "Interactive CAPTCHA detected during location lookup");
    await ui.search(query);
    const options = await ui.options();
    if (await ui.hasChallenge()) throw new AppError("captcha_required", "Interactive CAPTCHA detected during location lookup");
    const index = options.findIndex((option) => sameLocation(option, approved));
    if (index < 0) continue;
    await ui.pick(index);
    await verifySelection(ui, approved);
    return;
  }
  throw new AppError("location_not_verified", "No native option matched the approved current location");
}
