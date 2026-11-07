/**
 * Trimmed from live Dover careers-page responses (Nov 2026).
 * Names, ids and text are placeholders.
 */

export const DOVER_CLIENT = "ddd0dcc9-a311-4b3a-853c-2529114b313b";
export const DOVER_JOB = "c0523796-c54f-4350-a7f5-25fb0c70ccbb";

export const doverLocations = [
  { location_type: "REMOTE", location_option: { display_name: "Canada", location_type: "COUNTRY", city: "", state: "", country: "CA" }, name: "Canada", is_primary: false },
  { location_type: "REMOTE", location_option: { display_name: "United States", location_type: "COUNTRY", city: "", state: "", country: "US" }, name: "United States", is_primary: false },
  { location_type: "HYBRID", location_option: { display_name: "San Mateo, CA", location_type: "CITY", city: "San Mateo", state: "California", country: "US" }, name: "San Mateo, CA", is_primary: false },
];

export function doverSlug() {
  return { id: DOVER_CLIENT, slug: "acme", name: "Example Co", primary_domain: "example.com" };
}

export function doverJob(overrides: Record<string, unknown> = {}) {
  return { id: DOVER_JOB, title: "Software Engineer - AI", locations: doverLocations, workplace_type: "HYBRID", is_published: true, is_sample: false, ...overrides };
}

export function doverPage(results: unknown[], next: string | null = null) {
  return { count: results.length, next, previous: null, results };
}

export function doverDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: DOVER_JOB,
    client_id: DOVER_CLIENT,
    client_name: "Example Co",
    title: "Software Engineer - AI",
    user_provided_description: "<p>Build AI-native learning tools.</p>",
    locations: doverLocations,
    workplace_type: "HYBRID",
    compensation: {
      upper_bound: 190000, lower_bound: 120000, currency_code: "USD", open_to_sharing_comp: true,
      salary_range_type: "YEARLY", employment_type: "FULL_TIME",
    },
    visa_support: true,
    created: "2024-04-18T23:20:44.866240Z",
    active: true,
    is_private: false,
    ...overrides,
  };
}
