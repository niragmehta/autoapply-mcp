/**
 * Trimmed from the live Gem Job Board API (GET /job_board/v0/<board>/job_posts/, Nov 2026).
 * Names, ids and text are placeholders.
 */

export function gemPost(overrides: Record<string, unknown> = {}) {
  return {
    absolute_url: "https://jobs.gem.com/acme/4003629005",
    content: "<div><strong>ABOUT EXAMPLE CO</strong></div><div>The base salary range for this role is $163,800 - $306,000 per year.</div>",
    content_plain: "ABOUT EXAMPLE CO\nThe base salary range for this role is $163,800 - $306,000 per year.",
    created_at: "2022-03-09T23:08:26.000Z",
    departments: [{ id: "4001703005", name: "Engineering", parent_id: null, child_ids: [] }],
    employment_type: "full_time",
    first_published_at: "2022-03-25T18:46:39.000Z",
    id: "4003629005",
    internal_job_id: "4004000005",
    location: { name: "San Francisco, United States" },
    location_type: "hybrid",
    offices: [{ id: "4000713005", location: { name: "San Francisco, United States" }, name: "San Francisco" }],
    requisition_id: "16",
    title: "Software Engineer",
    updated_at: "2026-10-14T20:22:07.841Z",
    ...overrides,
  };
}
