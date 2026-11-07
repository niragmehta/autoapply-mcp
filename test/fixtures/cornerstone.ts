/**
 * Shapes trimmed from Cornerstone OnDemand's own career site
 * (cornerstone.csod.com, career site 2), November 2026: the home page's
 * bootstrap JSON, the career-site search, job-details and postings
 * endpoints. The token is a dummy; real anonymous tokens are never stored.
 */

export const CSOD_BOARD = "cornerstone.csod.com/2";
export const CSOD_TOKEN = "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.test-only-signature";

export const CSOD_HOME = `<!DOCTYPE html><html><head><title>Careers</title></head><body><script>
window.csod = window.csod || {}; csod.context={"corp":"cornerstone","user":-101,"cultureID":1,"cultureName":"en-US","timezone":1,"package":"career-site","page":"home","basePath":"/player-career-site/1.25.6/","endpoints":{"cloud":"https://us-galaxy.api.csod.com/","api":"/"},"token":"${CSOD_TOKEN}","expiresIn":3600};
</script></body></html>`;

export function csodRequisition(id: number, title: string, country = "US", city = "Santa Monica", state: string | null = "CA") {
  return { requisitionId: id, postingEffectiveDate: "11/6/2026", displayJobTitle: title, locations: [{ city, state, country }] };
}

export function csodSearch(requisitions: unknown[], totalCount = requisitions.length) {
  return { status: 0, timestamp: "2026-11-07T00:08:19Z", data: { totalCount, requisitions, filters: [], customFieldFilters: [] } };
}

export function csodDetail(overrides: Record<string, unknown> = {}) {
  return {
    status: 0,
    data: {
      displayTitle: "Senior Software Engineer",
      externalDescription: "<p><strong>About the Role:</strong></p><p>Build the learning platform. The base pay range is $150,000 - $190,000 per year.</p>",
      ref: "req11779",
      requisitionStatusId: 2,
      allowApply: true,
      primaryLocation: { title: "Santa Monica Office", city: "Santa Monica", state: "CA", country: "US", postalCode: "" },
      additionalLocations: [],
      openDate: "2026-11-06T23:00:14",
      ...overrides,
    },
  };
}

export function csodPostings(postings: { careerSiteId: number; startDate?: string | null; endDate?: string | null }[]) {
  return { status: 0, data: { postings: postings.map((posting, index) => ({ id: 20460 + index, isDefault: true, startDate: null, endDate: null, ...posting })) } };
}

export const CSOD_NOT_FOUND = { status: 2, error: { code: 40, message: "Resource not found" } };
