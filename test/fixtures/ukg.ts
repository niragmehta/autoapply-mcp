/**
 * Trimmed from a live UKG Pro Recruiting board
 * (recruiting.ultipro.com/MIC1014MICS/JobBoard/aba7ab7f-…), November 2026:
 * the LoadSearchResults JSON and an OpportunityDetail page's embedded record.
 * The notice markers for removed, unknown and internal-only opportunities are
 * the `data-i18n` keys UKG renders in their place.
 */

export const UKG_BOARD = "recruiting.ultipro.com/MIC1014MICS/aba7ab7f-e037-4961-b6cf-c1491e2105e0";
export const UKG_ID = "165dff48-43db-4a54-b847-10645a686e85";

export function ukgOpportunity(overrides: Record<string, unknown> = {}) {
  return {
    Id: UKG_ID,
    Featured: false,
    Title: "2nd Shift QA Inspector",
    RequisitionNumber: "2NDSH001088",
    FullTime: true,
    JobCategoryName: "Miscellaneous",
    Locations: [{
      Id: "373819da-ad5f-5180-8c10-a1fc4a0c8748",
      LocalizedName: null,
      LocalizedDescription: "Manchester",
      Address: {
        Line1: "1050 Perimeter Rd", City: "Manchester", PostalCode: "03103",
        State: { Code: "NH", Name: "New Hampshire" }, Country: { Code: "USA", Name: "United States" },
      },
    }],
    PostedDate: "2025-10-22T18:35:00.879Z",
    BriefDescription: "The role of Quality Component Process Inspector is to evaluate completed product for conformance.",
    MatchScore: 1,
    JobLocationType: 1,
    OpportunityType: 0,
    ...overrides,
  };
}

export function ukgSearch(opportunities: unknown[], totalCount = opportunities.length) {
  return { opportunities, totalCount, initialTotalOpportunitiesCount: totalCount, locations: [] };
}

export function ukgDetailPage(overrides: Record<string, unknown> = {}): string {
  const record = {
    ...ukgOpportunity(),
    Description: "<p><strong>Responsibilities</strong></p><ul><li>Evaluate conformance of components {first piece} before \"release\"</li></ul>",
    OpportunityIsClosed: false,
    Salaried: false,
    CompensationAnnualMinimum: null,
    CompensationAnnualMaximum: null,
    CompensationHourlyMinimum: null,
    CompensationHourlyMaximum: null,
    CompensationCurrencyCode: null,
    PayRangeVisible: true,
    PayRange: { PayRangeMinimum: 22, PayRangeMaximum: 28 },
    PayRangeCurrencyCode: "USD",
    ...overrides,
  };
  return `<!DOCTYPE html><html><body><div id="Successbanner"></div>
<script>
    $(function () {
        var opportunity = new US.Opportunity.CandidateOpportunityDetail(${JSON.stringify(record)});
        var applicantSourceId = null;
    });
</script></body></html>`;
}

function noticePage(key: string): string {
  return `<!DOCTYPE html><html><body>
<h3 data-i18n="${key}" data-automation="opportunity-message"></h3>
<span data-i18n="Opportunity.OpportunityError.StillCurious"></span><a href="/MIC1014MICS/JobBoardView" data-i18n="Opportunity.OpportunityError.ViewOtherOpportunities"></a>
</body></html>`;
}

export const UKG_UNAVAILABLE_PAGE = noticePage("Opportunity.OpportunityError.OpportunityUnavailableMessage");
export const UKG_NOT_FOUND_PAGE = noticePage("Opportunity.OpportunityError.NotFoundErrorMessage");
export const UKG_INTERNAL_PAGE = noticePage("Opportunity.OpportunityError.InternalOpportunityRequiresAuth");
