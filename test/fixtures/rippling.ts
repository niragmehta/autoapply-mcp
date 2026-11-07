/**
 * Trimmed from live Rippling ATS v2 board responses (Nov 2026).
 * Names, ids and text are placeholders.
 */

export const RIPPLING_ID = "2227d59b-20f2-4973-8a75-0dd151399b59";

export function ripplingItem(overrides: Record<string, unknown> = {}) {
  return {
    id: RIPPLING_ID,
    name: "Technical Program Manager",
    url: `https://ats.rippling.com/acme/jobs/${RIPPLING_ID}`,
    department: { name: "Operations" },
    locations: [{
      name: "Remote (District of Columbia, US)", country: "United States", countryCode: "US",
      state: "District of Columbia", stateCode: "DC", city: null, workplaceType: "REMOTE",
    }],
    language: "en-US",
    ...overrides,
  };
}

export function ripplingPage(items: unknown[], page = 0, totalPages = 1) {
  return { items, page, pageSize: 100, totalItems: items.length, totalPages };
}

export function ripplingDetail(overrides: Record<string, unknown> = {}) {
  return {
    uuid: RIPPLING_ID,
    name: "Technical Program Manager",
    description: {
      company: "<p>Example Co builds networks.</p>",
      role: "<h2>Role Overview</h2><p>Coordinate delivery across teams.</p>",
    },
    workLocations: ["Remote (DC, US)"],
    department: { name: "Operations" },
    employmentType: { label: "SALARIED_FT", id: "Salaried, full-time" },
    createdOn: "2026-08-24T09:38:14.937000-07:00",
    payRangeDetails: [{
      location: "Remote (DC, US)", currency: "USD", frequency: "YEAR", rangeStart: 187000, rangeEnd: 207000, isRemote: true,
    }],
    url: `https://ats.rippling.com/acme/jobs/${RIPPLING_ID}`,
    unlistedFromSearch: false,
    ...overrides,
  };
}
