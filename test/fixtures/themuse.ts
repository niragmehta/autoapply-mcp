/**
 * Trimmed from the live The Muse API
 * (https://www.themuse.com/api/public/jobs?page=0&category=Software%20Engineering, Nov 2026).
 * Company names and text are placeholders.
 */

export function museJob(overrides: Record<string, unknown> = {}) {
  return {
    contents: "<div><p>Example Co builds deployment tooling.</p></div>",
    name: "Lead Deployment Engineer",
    type: "external",
    publication_date: "2026-11-04T18:38:32Z",
    short_name: "lead-deployment-engineer-a54dc0",
    model_type: "jobs",
    id: 22328908,
    locations: [{ name: "New York, NY" }],
    categories: [{ name: "Software Engineering" }],
    levels: [{ name: "Senior Level", short_name: "senior" }],
    tags: [],
    refs: { landing_page: "https://www.themuse.com/jobs/exampleco/lead-deployment-engineer-a54dc0" },
    company: { id: 15000205, short_name: "exampleco", name: "Example Co" },
    ...overrides,
  };
}

export function musePage(results: unknown[], page = 0, pageCount = 4771, total = 95413) {
  return { page, page_count: pageCount, items_per_page: 20, took: 12, timed_out: false, total, results, aggregations: {} };
}
