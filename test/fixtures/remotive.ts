/**
 * Trimmed from the live Remotive API (https://remotive.com/api/remote-jobs, Nov 2026).
 * Company names and text are placeholders.
 */

export function remotiveJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 1185979,
    url: "https://remotive.com/remote-jobs/software-development/senior-security-engineer-1185979",
    title: "Senior Security Engineer",
    company_name: "Example Co",
    company_logo: "https://remotive.com/job/1185979/logo",
    category: "Software Development",
    tags: ["security", "aws"],
    job_type: "full_time",
    publication_date: "2026-11-04T16:53:35",
    candidate_required_location: "USA",
    salary: "$50-$75 /hour",
    description: "<p>Own detection engineering.</p>",
    company_logo_url: "https://remotive.com/job/1185979/logo",
    ...overrides,
  };
}

export function remotivePage(jobs: unknown[]) {
  return {
    "00-warning": "Please link back to Remotive and mention it as the source.",
    "0-legal-notice": "Remotive API Legal Notice",
    "job-count": jobs.length,
    "total-job-count": jobs.length,
    jobs,
  };
}
