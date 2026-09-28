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
