/**
 * Trimmed from a live Consider board (https://jobs.lsvp.com/jobs and its
 * POST /api-boards/search-jobs, Nov 2026). Company names, tokens and ids are placeholders.
 */

export const CONSIDER_TOKEN = "csrf-token-placeholder-0123456789";

export function considerBoardPage(boardId = "lightspeed", token = CONSIDER_TOKEN): string {
  const state = {
    fixedBoard: true,
    hostname: "jobs.lsvp.com",
    environment: "production",
    csrfToken: token,
    board: { id: boardId, isParent: true },
    parents: [],
  };
  return `<!DOCTYPE html><html><head><title>Jobs</title></head><body><div id="root"></div>
<script>window.serverInitialData = ${JSON.stringify(state)};</script>
</body></html>`;
}

export function considerJob(overrides: Record<string, unknown> = {}) {
  return {
    applicationWindow: { status: "accepting" },
    applyUrl: "https://job-boards.greenhouse.io/exampleco/jobs/4751411005",
    companyDomain: "example.com",
    companyId: "Example Co",
    companySlug: "example-co",
    companyName: "Example Co",
    considerHosted: false,
    departments: ["Engineering"],
    locations: ["Remote - Global"],
    normalizedLocations: [],
    salary: {
      period: { label: "Year", value: "year" },
      minValue: 200000,
      maxValue: 300000,
      currency: { label: "USD", value: "USD" },
      isOriginal: true,
    },
    timeStamp: "2026-11-06T11:18:07Z",
    title: "Senior Security Engineer",
    url: "https://job-boards.greenhouse.io/exampleco/jobs/4751411005",
    jobId: "4751411005",
    remote: true,
    hybrid: false,
    isFeatured: false,
    ...overrides,
  };
}

export function considerPage(jobs: unknown[], total = jobs.length, sequence: string | null = null) {
  return {
    version: 2,
    jobs,
    meta: { size: 50, ...(sequence ? { sequence } : {}) },
    availableFilters: {},
    total,
    errors: [],
  };
}
