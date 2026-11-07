/**
 * Shapes trimmed from the live HDR Taleo Enterprise career section
 * (hdr.taleo.net, section "ex"), November 2026: the search page's portal
 * number and results table header, the anonymous searchjobs JSON, and a job
 * page's `initialHistory` field with its `!|!` separators, URL encoding and
 * `\:` escapes. Text is shortened.
 */

export const TALEO_BOARD = "hdr.taleo.net/ex";

export const TALEO_SHELL = `<!DOCTYPE html><html><head><script>
var _ftl = { config: {
  'fs/FacetedSearchSettings': { waitSeconds: 15, queryString: 'lang=en&amp;portal=101430233' },
  versionNumber: '2026PRD.1.5.9.3.0', lang: 'en', portalNo: '101430233', urlOrigin: 'https://hdr.taleo.net', urlCode: 'ex'
} };</script></head><body>
<table id="jobs" class="table" summary="Job Openings">
  <thead><tr class="headers subtitle">
    <th scope="col"><span class="hidden-audible">Icons</span></th>
    <th width="50%" scope="col">Requisition Title</th>
    <th width="30%" scope="col">Location</th>
    <th width="20%" scope="col">Posting Date</th>
    <th scope="col"> Actions </th>
  </tr></thead><tbody class="jobsbody"></tbody>
</table></body></html>`;

export const TALEO_PRIVATE_SHELL = "<!DOCTYPE html><html><body>This career section is not available.</body></html>";

export function taleoRow(contestNo: string, title: string, location: string, posted: string) {
  return {
    hotJob: false, addedToJobCart: false, draft: false, alreadyAppliedOn: false, toReApply: false,
    jobId: `7${contestNo}`, contestNo, column: [`  ${title}`, location, posted], linkedColumn: 0, locationsColumns: [1],
  };
}

export function taleoPage(rows: unknown[], totalCount: number | string = rows.length, currentPageNo = 1) {
  return {
    requisitionList: rows,
    facetResults: [],
    pagingData: { currentPageNo, pageSize: 25, totalCount },
    queryString: "",
    careerSectionUnAvailable: false,
  };
}

/** Taleo's encoding inside initialHistory: URL escapes plus a backslash before colons. */
function encode(part: string): string {
  return part.replace(/:/g, "%5C:").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/"/g, "%22");
}

export function taleoDetailPage(contestNo = "191953", title = " Aviation Engineer/Project Manager", location = "United States-Colorado-Denver"): string {
  const parts = [
    "ftlx0", "ftlUtil_resetPage!$!requisitionDescriptionInterface", "descRequisition", "rdPager!$!779112", "true", "779112",
    "false", `Submission for the position:  ${title.trim()} - (Job Number: ${contestNo})`, "false", "779112", "false", "true",
    title, contestNo,
    `!*!<p><span style="font-size:14px;">At HDR, our employee-owners are fully engaged.</span></p><p>Travel up to 50% may be required.</p>`,
    `!*!<div><b>Required Qualifications </b><ul><li>Bachelor's degree in Engineering</li></ul></div>`,
    "We provide a comprehensive benefits package.", "", location, location, "", "Aviation", "Aviation", "Full-time", "Full-time",
    "Regular", "Regular", "Airfield Design", "Airfield Design", "Mar 24, 2026", "Mar 24, 2026", "false",
  ];
  // `encode` leaves "50%" literal, as Taleo does, so whole-string decoding fails.
  const value = parts.map(encode).join("!|!");
  return `<!DOCTYPE html><html><body><form id="ftlform">
<input type="hidden" name="rdPager.listId" id="rdPager.listId" value="descRequisition" />
<input type="hidden" name="initialHistory" id="initialHistory" value="${value}" />
</form></body></html>`;
}

export const TALEO_UNAVAILABLE_PAGE = `<!DOCTYPE html><html><body><script>
api.fillInterface('requisitionUnavailableInterface', ['Return to the previous page','The job is no longer available.','The job description you are trying to view is no longer available.']);
</script></body></html>`;
