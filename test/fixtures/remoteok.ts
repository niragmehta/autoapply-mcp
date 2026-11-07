/**
 * Trimmed from the live Remote OK API (https://remoteok.com/api, Nov 2026).
 * Company names and text are placeholders; field shapes are unchanged,
 * including the leading legal notice and the double-encoded description.
 */

export const remoteOkLegal = {
  last_updated: 1794009602,
  legal: "API Terms of Service: Please link back (with follow, and without nofollow!) to the URL on Remote OK and mention Remote OK as a source.",
};

export function remoteOkJob(overrides: Record<string, unknown> = {}) {
  return {
    slug: "remote-senior-security-engineer-example-co-1137694",
    id: "1137694",
    epoch: 1793923211,
    date: "2026-11-05T17:00:11-07:00",
    company: "Example Co",
    company_logo: "",
    position: "Senior Security Engineer",
    tags: ["security", "cloud", "engineer"],
    description: "<p>At Example Co, we\u00e2\u0080\u0099re securing robots.</p>",
    location: "United States",
    salary_min: 90000,
    salary_max: 110000,
    apply_url: "https://remoteOK.com/remote-jobs/remote-senior-security-engineer-example-co-1137694",
    logo: "",
    url: "https://remoteOK.com/remote-jobs/remote-senior-security-engineer-example-co-1137694",
    ...overrides,
  };
}
