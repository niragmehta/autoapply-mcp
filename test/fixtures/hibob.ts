/**
 * Trimmed from a live HiBob careers-site /api/job-ad response (Nov 2026).
 * Names, ids and text are placeholders.
 */

export const HIBOB_ID = "60446404-5a1b-4950-a397-65adfd6a9f76";

export function hibobAd(overrides: Record<string, unknown> = {}) {
  return {
    id: HIBOB_ID,
    title: "Technical Support Specialist",
    departmentId: "Support",
    department: "Support",
    employmentTypeId: "Permanent",
    employmentType: "Permanent",
    siteId: 2551378,
    site: "Homeoffice US",
    country: "United States",
    language: "en",
    description: "<p>Example Co is looking for a support specialist.</p>",
    requirements: "<ul><li>Three years of support experience</li></ul>",
    responsibilities: null,
    benefits: null,
    sectionLabels: {},
    publishedAt: "2026-09-04T07:25:28.557454Z",
    workspaceTypeId: "remote",
    workspaceType: "Remote",
    payTransparencyMinSalary: 65000,
    payTransparencyMaxSalary: 80000,
    payTransparencySalaryCurrency: "USD",
    payTransparencySalaryPayPeriod: "Annual",
    payTransparencySalaryAdditionalInfo: null,
    postingLocations: [],
    ...overrides,
  };
}

export function hibobResponse(ads: unknown[] = [hibobAd()]) {
  return { filterGroups: [], jobAdDetails: ads, jobOpeningMetadata: {} };
}
