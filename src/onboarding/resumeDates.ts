/**
 * Date handling for resume text: finds a "start - end" range on a line and
 * normalizes each side to the profile's "YYYY-MM" / "YYYY" / "present" form.
 */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const YEAR = "(?:19[5-9]\\d|20\\d{2})";
const DATE = `(?:${MONTH}\\s*,?\\s*${YEAR}|(?:0?[1-9]|1[0-2])\\s*[/.-]\\s*${YEAR}|${YEAR}\\s*[/-]\\s*(?:0[1-9]|1[0-2])(?!\\d)|${YEAR})`;
const OPEN_END = "(?:present|current(?:ly)?|now|today|to date|ongoing)";
const SEPARATOR = "\\s*(?:-|\u2013|\u2014|~|to|until|through|thru)\\s*";

const RANGE = new RegExp(`(${DATE})${SEPARATOR}(${DATE}|${OPEN_END})(?![\\w])`, "i");
const SINGLE_YEAR = new RegExp(`(?<![\\d/.-])(${YEAR})(?!\\d|[/.-]\\d)`);

/** Normalizes one side of a range: "Jan 2020" -> "2020-01", "03/2019" -> "2019-03", "Present" -> "present". */
export function normalizeDate(raw: string): string {
  const value = raw.trim().toLowerCase().replace(/\.$/, "");
  if (new RegExp(`^${OPEN_END}$`, "i").test(value)) return "present";
  const named = new RegExp(`^(${MONTH})\\s*,?\\s*(${YEAR})$`, "i").exec(value);
  if (named) {
    const month = MONTHS[named[1]!.replace(/\.$/, "")];
    return month ? `${named[2]}-${String(month).padStart(2, "0")}` : named[2]!;
  }
  const numericFirst = new RegExp(`^(0?[1-9]|1[0-2])\\s*[/.-]\\s*(${YEAR})$`).exec(value);
  if (numericFirst) return `${numericFirst[2]}-${numericFirst[1]!.padStart(2, "0")}`;
  const yearFirst = new RegExp(`^(${YEAR})\\s*[/-]\\s*(0[1-9]|1[0-2])$`).exec(value);
  if (yearFirst) return `${yearFirst[1]}-${yearFirst[2]}`;
  const year = new RegExp(`^(${YEAR})$`).exec(value);
  return year ? year[1]! : "";
}

export type DateRange = { start: string; end: string; matched: string; index: number };

export function findDateRange(line: string): DateRange | null {
  const match = RANGE.exec(line);
  if (!match) return null;
  const start = normalizeDate(match[1]!);
  const end = normalizeDate(match[2]!);
  if (!start || !end) return null;
  return { start, end, matched: match[0], index: match.index };
}

/** A lone year, as in a graduation date: "B.Sc. Computer Science, 2014". */
export function findSingleYear(line: string): string | null {
  return SINGLE_YEAR.exec(line)?.[1] ?? null;
}
