/**
 * Trimmed from the live CloudBees Paylocity board
 * (recruiting.paylocity.com/Recruiting/Jobs/All/a432d829-…), November 2026:
 * the board page's `window.pageData` script and a Details page. Text is
 * shortened.
 */

export const PAYLOCITY_BOARD = "a432d829-f701-4cf3-9108-56ef703b2ac5";

export function paylocityJob(overrides: Record<string, unknown> = {}) {
  return {
    JobId: 4628579,
    JobTitle: "Principal Software Engineer, CBCI",
    LocationName: "Denver, CO - Hybrid",
    ShouldDisplayLocation: true,
    PublishedDate: "2026-10-30T09:31:56-06:00",
    Description: "Job Title: Principal Software Engineer, CBCIJob Type: Full-timeLocation: Hybrid - Denver, CO (3 days on-s",
    IsInternal: false,
    HiringDepartment: "Engineering",
    JobLocation: { LocationId: 1, ModuleId: 23600, Name: "Denver, CO - Hybrid", City: "Denver", State: "CO", Zip: "80202", Country: "USA" },
    IsRemote: true,
    IndeedRemoteType: 1,
    ...overrides,
  };
}

export function paylocityBoardPage(jobs: unknown[]): string {
  const data = { CookieBannerScriptSource: "", Departments: [], Jobs: jobs, Locations: [], ModuleId: 23600, ModuleTitle: "CloudBees Inc", ShowInternal: false };
  return `<!DOCTYPE html><html><head><title>CloudBees Inc - Current Openings</title></head><body>
<script>
    window.pageData = ${JSON.stringify(data)};
</script></body></html>`;
}

export function paylocityDetailPage(title = "Principal Software Engineer, CBCI"): string {
  return `<!DOCTYPE html><html><head><title>CloudBees Inc - ${title}</title></head><body>
    <div class="job-preview-header">
        <span class="job-preview-title left">

          <span>${title}</span>

        </span>
        <br />
        <div class="preview-location">
          Denver, CO                        <span> &bull; </span>
Engineering        </div>
    </div>
    <div class="job-preview-details">
      <div class="mobile-apply-btn">
        <a class="apply-link-marker button apply-button" href="/Recruiting/Jobs/Apply/4628579">Apply</a>
      </div>
      <div class="job-listing-header">Description</div>
      <div><p><strong>Job Title:</strong> ${title}</p><p>The base salary range for this role is $200,000 - $230,000 per year.</p></div>
    </div>
    <a href="/Recruiting/Jobs/All/${PAYLOCITY_BOARD}">Back to all jobs</a>
  <script>
    window.pageData = {"jobTitle":"${title}","moduleName":"CloudBees Inc","showSocialWidget":true};
  </script></body></html>`;
}

export const PAYLOCITY_NOT_FOUND = `<!DOCTYPE html><html><head>
  <title>Job Not Found</title></head><body><h1>Sorry, this job is no longer available.</h1></body></html>`;
