/**
 * Trimmed from live BambooHR /careers/list and /careers/<id>/detail responses
 * (Nov 2026). Names, ids and text are placeholders.
 */

export function bambooRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "363",
    jobOpeningName: "Senior Platform Engineer",
    departmentId: "19091",
    departmentLabel: "Engineering",
    employmentStatusLabel: "Full-Time",
    employmentType: null,
    location: { city: null, state: null },
    atsLocation: { country: "United States", state: "New York", province: null, city: "New York" },
    isRemote: null,
    locationType: "1",
    ...overrides,
  };
}

export function bambooList(rows: unknown[] = [bambooRow()]) {
  return { meta: { totalCount: rows.length }, result: rows };
}

export function bambooDetail(overrides: Record<string, unknown> = {}) {
  return {
    meta: {},
    result: {
      jobOpening: {
        jobOpeningShareUrl: "https://acme.bamboohr.com/careers/363",
        jobOpeningName: "Senior Platform Engineer",
        jobOpeningStatus: "Open",
        departmentLabel: "Engineering",
        employmentStatusLabel: "Full-Time",
        location: { city: null, state: null, postalCode: null, addressCountry: null },
        atsLocation: { country: "United States", countryId: "1", state: "New York", city: "New York" },
        description: "<p>Build reliable infrastructure for Example Co.</p>",
        compensation: "$180,000 - $210,000 per year",
        datePosted: "2026-08-31",
        minimumExperience: "Senior",
        locationType: "1",
        ...overrides,
      },
    },
  };
}
