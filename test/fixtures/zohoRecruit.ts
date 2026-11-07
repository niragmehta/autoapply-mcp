/**
 * Trimmed from a live Zoho Recruit /jobs/Careers page (Nov 2026): the job
 * list sits in a hidden input as entity-escaped JSON. Names and text are
 * placeholders.
 */

export function zohoRecord(overrides: Record<string, unknown> = {}) {
  return {
    Remote_Job: false,
    Posting_Title: "Cloud Infrastructure Engineer",
    Is_Locked: false,
    City: "Toronto",
    Industry: "Technology",
    Function: "IT & Infrastructure",
    Job_Description: "<span id=\"spandesc\"><div>Operate our cloud &amp; network.</div></span>",
    Job_Type: "Full time",
    Job_Opening_Name: "Cloud Infrastructure Engineer",
    State: "Ontario",
    Currency: "CAD",
    Country: "Canada",
    id: "747697000006478411",
    Publish: true,
    Date_Opened: "2026-10-30",
    Keep_on_Career_Site: false,
    ...overrides,
  };
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function zohoPage(records: unknown[]): string {
  return `<!DOCTYPE html><html><head><title>Careers</title></head><body>
  <input type="hidden" id="meta" value="{}">
  <input type="hidden" id="jobs" value="${escapeAttribute(JSON.stringify(records))}">
  <div id="root"></div></body></html>`;
}

export const ZOHO_MISSING_PAGE = "<html><head><title>Page does not exist</title></head><body>Sorry</body></html>";
