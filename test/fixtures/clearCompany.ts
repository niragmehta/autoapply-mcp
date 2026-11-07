/**
 * Trimmed from the live ClearCompany careers API (careers-api.clearcompany.com/v1/<siteId>, Nov 2026).
 * Names, ids and text are placeholders.
 */

export const CLEAR_SITE = "a01e8e2d-0f1d-2586-1830-5910e6e7d498";
export const CLEAR_JOB = "a70330d0-e073-1b14-215b-078b853f69f4";

export function clearRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: CLEAR_JOB,
    userDefinedId: "2",
    positionTitle: "Revenue Cycle  Analyst",
    description: "<p><strong>Revenue Cycle Analyst</strong></p><p>Improve billing accuracy.</p>",
    openDate: "2025-09-10T00:00:00",
    postedDate: "2025-09-10T00:00:00",
    departmentName: "Finance",
    officeName: "Headquarters",
    jobFunctionName: "Finance",
    location: "Maitland FL",
    locations: [{
      city: "Maitland", subdivision: "FL", subdivisionFullName: "Florida", country: "US", postalCode: "32751",
      isRemote: false, isNationwide: false, isStatewide: false,
    }],
    brandName: "Example Co",
    applyLink: `https://acme.clearcompany.com/careers/jobs/${CLEAR_JOB}/apply`,
    canSelfSchedule: false,
    salaryRangeLow: "65000",
    salaryRangeHigh: "80000",
    salaryType: "Per Year",
    customFieldAnswers: [],
    ...overrides,
  };
}

export function clearPage(results: unknown[], totalCount = results.length, currentPageIndex = 0) {
  return { results, currentPageIndex, totalCount, currentPageCount: results.length };
}
