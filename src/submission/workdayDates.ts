type WorkdayDateSection = "Month" | "Day" | "Year";
type DatePart = readonly [WorkdayDateSection, string];

const EMPLOYMENT_DATE = /^workExperience-\d+--(startDate|endDate)$/i;
const EDUCATION_YEAR = /^education-\d+--(firstYearAttended|lastYearAttended)$/i;

export function workdayDateLabel(domId = ""): string | null {
  const employment = EMPLOYMENT_DATE.exec(domId);
  if (employment) return `Employment ${employment[1]!.toLowerCase() === "startdate" ? "start" : "end"} date`;
  const education = EDUCATION_YEAR.exec(domId);
  if (education) return `Education ${education[1]!.toLowerCase() === "firstyearattended" ? "start" : "end"} year`;
  return null;
}

/** Preserve the precision actually requested; a month/year does not imply a day. */
export function workdayDateParts(value: string, domId = ""): DatePart[] | null {
  const text = value.trim();
  if (EDUCATION_YEAR.test(domId)) {
    return /^\d{4}$/.test(text) && Number(text) > 0 ? [["Year", text]] : null;
  }
  if (EMPLOYMENT_DATE.test(domId)) {
    const iso = /^(\d{4})-(\d{1,2})$/.exec(text);
    const local = /^(\d{1,2})\/(\d{4})$/.exec(text);
    if (!iso && !local) return null;
    const year = iso?.[1] ?? local![2]!;
    const month = iso?.[2] ?? local![1]!;
    if (Number(year) < 1 || Number(month) < 1 || Number(month) > 12) return null;
    return [["Month", month.padStart(2, "0")], ["Year", year]];
  }
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  const local = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
  if (!iso && !local) return null;
  const year = iso?.[1] ?? local![3]!;
  const month = (iso?.[2] ?? local![1]!).padStart(2, "0");
  const day = (iso?.[3] ?? local![2]!).padStart(2, "0");
  const canonical = `${year}-${month}-${day}`;
  const parsed = new Date(`${canonical}T00:00:00.000Z`);
  if (Number(year) < 1 || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== canonical) return null;
  return [["Month", month], ["Day", day], ["Year", year]];
}

/**
 * A date picker asking when the candidate can start. BlackLine asked "What is
 * your earliest possible start date?", Western Governors University "When are
 * you available to start?" and Early Warning "What is your desired start date?",
 * each as a Workday date control.
 */
const AVAILABILITY_DATE_LABEL =
  /\b(?:(?:desired|earliest|possible|available|anticipated|expected|preferred|proposed|target)\s+(?:possible\s+)?start(?:ing)?\s+date|start(?:ing)? date|date (?:you are |you're )?available|available (?:to|for) (?:start|begin|join|work)|availability(?: date)?|when (?:are you|would you be) available|when (?:can|could) you (?:start|begin|join)|join(?:ing)? date|commencement date)\b/i;

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const QUANTITY = String.raw`(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;
const PERIOD = new RegExp(
  String.raw`\b${QUANTITY}\b(?:\s*(?:-|\u2013|\u2014|to|or)\s*${QUANTITY}\b)?\s*(day|week|month)s?\b`,
  "i",
);
const IMMEDIATELY = /\b(?:immediately|right away|asap|as soon as possible)\b/i;

function quantity(word: string): number {
  return NUMBER_WORDS[word.toLowerCase()] ?? Number(word);
}

/**
 * The day a stated availability works out to, as `YYYY-MM-DD`.
 *
 * The stored answer is a period - "Approximately four weeks from offer
 * acceptance." - and the offer has not been made, so no day is known. The
 * longer end of any range is counted from `now`, and the date moves forward to
 * the next Monday, the day a new job usually starts. Text stating no period
 * gives null, so nothing is invented for it.
 */
export function availabilityDate(text: string, now: Date): string | null {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const period = PERIOD.exec(text);
  if (period) {
    const amount = Math.max(quantity(period[1]!), period[2] ? quantity(period[2]) : 0);
    const unit = period[3]!.toLowerCase();
    if (unit === "day") day.setDate(day.getDate() + amount);
    else if (unit === "week") day.setDate(day.getDate() + amount * 7);
    else day.setMonth(day.getMonth() + amount);
  } else if (!IMMEDIATELY.test(text)) {
    return null;
  }
  day.setDate(day.getDate() + ((8 - day.getDay()) % 7));
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/**
 * The parts to type into a Workday date control, or null when the answer cannot
 * fill it. A date is taken as written. A start-date picker also takes the
 * stored availability, which is turned into a day by availabilityDate; nothing
 * else does, so a notice period can never become an employment, education or
 * birth date.
 */
export function datePickerParts(value: string, domId = "", label = "", now = new Date()): DatePart[] | null {
  const written = workdayDateParts(value, domId);
  if (written) return written;
  if (EMPLOYMENT_DATE.test(domId) || EDUCATION_YEAR.test(domId) || !AVAILABILITY_DATE_LABEL.test(label)) return null;
  const day = availabilityDate(value, now);
  return day ? workdayDateParts(day, domId) : null;
}
