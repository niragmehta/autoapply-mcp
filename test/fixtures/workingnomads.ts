/**
 * Trimmed from the live Working Nomads feed (https://www.workingnomads.com/api/exposed_jobs/, Nov 2026).
 * Company names and text are placeholders.
 */

export function nomadJob(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://www.workingnomads.com/job/go/1996233/",
    title: "Senior Site Reliability Engineer",
    description: "<p>100% Remote | Full-time</p><p>Keep our platform up.</p>",
    company_name: "Example Co",
    category_name: "Development",
    tags: "devops,kubernetes,aws",
    location: "USA",
    pub_date: "2026-11-05T01:10:45-07:00",
    ...overrides,
  };
}
