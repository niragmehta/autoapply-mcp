/**
 * Trimmed from the live Getro search API
 * (POST https://api.getro.com/api/v2/collections/222/search/jobs, Nov 2026) and a
 * Getro board page's Next.js data. Company names and ids are placeholders.
 */

export function getroJob(overrides: Record<string, unknown> = {}) {
  return {
    compensation_public: true,
    featured: false,
    compensation_amount_min_cents: 18_000_000,
    compensation_amount_max_cents: 22_000_000,
    searchable_locations: ["United States", "North America", "New York"],
    created_at: 1793972826,
    weight: 0,
    compensation_amount_max_cents_usd: 22_000_000,
    source: "career_page",
    title: "Senior Security Engineer",
    work_mode: "remote",
    url: "https://job-boards.greenhouse.io/exampleco/jobs/4751411005",
    skills: [],
    location_details: [{ name: "New York, NY, USA", area_type: "locality", point: "POINT (-74.006 40.7128)" }],
    compensation_offers_equity: null,
    compensation_currency: "USD",
    compensation_period: "year",
    organization: {
      stage: "series_e", logo_url: "https://cdn.getro.com/companies/example", topics: [], name: "Example Co",
      head_count: 6, id: 33875, industry_tags: ["Security"], slug: "example-co",
    },
    locations: ["New York, NY, USA"],
    has_description: false,
    slug: "99207013-senior-security-engineer",
    seniority: "senior",
    id: 99207013,
    ...overrides,
  };
}

export function getroResponse(jobs: unknown[], count = jobs.length) {
  return { results: { jobs, count } };
}

export function getroBoardPage(id: unknown): string {
  const data = { props: { pageProps: { network: { id, name: "Example Ventures", slug: "exampleventures" } } }, page: "/jobs" };
  return `<!DOCTYPE html><html><head></head><body><div id="__next"></div>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
}
