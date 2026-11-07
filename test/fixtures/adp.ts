/**
 * Trimmed from the live Palmetto State Armory ADP Workforce Now career center
 * (cid 1774d0ee-…), November 2026: the staffing API's job-requisitions list
 * and detail shapes, including the custom field groups and pay grade range.
 */

export const ADP_BOARD = "1774d0ee-6390-4d36-9333-1f675e3b3058";

export function adpRequisition(overrides: Record<string, unknown> = {}) {
  return {
    itemID: "9200956893617_18",
    postingInstructions: [],
    links: [],
    clientRequisitionID: "4406",
    customFieldGroup: {
      codeFields: [
        { codeValue: "HR", nameCode: { codeValue: "SalaryType" }, shortName: "Hourly" },
        { codeValue: "RANGE", nameCode: { codeValue: "SalaryRangeType" }, shortName: "RANGE" },
      ],
      dateFields: [
        { dateValue: "2026-11-06T15:58Z", nameCode: { codeValue: "PostingDate" } },
        { dateValue: "2026-11-06T19:10Z", nameCode: { codeValue: "CurrentServerDateTime" } },
      ],
      stringFields: [
        { nameCode: { codeValue: "ExternalJobID" }, stringValue: "580568" },
        { nameCode: { codeValue: "JobClass" }, stringValue: "Manual Labor" },
        { nameCode: { codeValue: "SalaryRange" }, stringValue: "18 to 22 (USD) Hourly" },
      ],
    },
    organizationalUnits: [],
    payGradeRange: { minimumRate: { amountValue: 18, currencyCode: "USD" }, maximumRate: { amountValue: 22, currencyCode: "USD" } },
    postDate: "2026-11-07T02:28:00",
    requisitionLocations: [{
      address: { cityName: "Summerville", countrySubdivisionLevel1: { codeValue: "SC" }, postalCode: "29483" },
      aliasNames: [],
      nameCode: { shortName: "DC Machine, Summerville, SC, US" },
    }],
    requisitionTitle: "Polisher",
    screeningRequirements: [],
    sponsoredVisaTypeCodes: [],
    workLevelCode: { shortName: "Full Time" },
    ...overrides,
  };
}

export function adpList(requisitions: unknown[], totalNumber = requisitions.length) {
  return { jobRequisitions: requisitions, meta: { startSequence: 1, totalNumber, links: [] } };
}

export function adpDetail(overrides: Record<string, unknown> = {}) {
  return adpRequisition({
    requisitionDescription: "<div><p>JOB PURPOSE</p><p>This position is responsible for the polish and deburring of all barrels.</p></div>",
    ...overrides,
  });
}

/** What the detail endpoint answers for a requisition it no longer has. */
export const ADP_MISSING = { postingInstructions: [], links: [], organizationalUnits: [], requisitionLocations: [], screeningRequirements: [], sponsoredVisaTypeCodes: [] };
