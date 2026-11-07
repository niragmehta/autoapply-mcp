/**
 * Trimmed from a live JPMorgan Chase Oracle Recruiting Cloud board
 * (jpmc.fa.oraclecloud.com, site CX_1002), November 2026. Descriptions are
 * shortened; field names and value shapes are exactly as served.
 */

export function oracleRow(overrides: Record<string, unknown> = {}) {
  return {
    Id: "210690282",
    Title: "2027 Markets Summer Analyst Program - Research",
    PostedDate: "2026-11-06",
    PostingEndDate: null,
    Language: "US",
    PrimaryLocationCountry: "US",
    WorkplaceTypeCode: null,
    JobFamily: "Analysts",
    JobSchedule: null,
    ShortDescriptionStr: "In ever-changing global markets you'll spend your time exploring the sophisticated financial solutions we deliver across asset classes",
    PrimaryLocation: "New York, NY, United States",
    WorkplaceType: "",
    secondaryLocations: [],
    workLocation: [],
    ...overrides,
  };
}

export function oracleRowWithSecondary(overrides: Record<string, unknown> = {}) {
  return oracleRow({
    Id: "210713605",
    Title: "Software Engineer III - Java",
    PostedDate: "2026-11-05",
    PrimaryLocation: "Columbus, OH, United States",
    secondaryLocations: [
      { RequisitionLocationId: 300092505497412, Name: "Nashville, TN, United States", CountryCode: "US" },
      { RequisitionLocationId: 300092505497413, Name: "New York, NY, United States", CountryCode: "US" },
    ],
    workLocation: [{ LocationId: 1, TownOrCity: "Columbus", Region2: "US-OH", Country: "US" }],
    ...overrides,
  });
}

export function oracleListPage(rows: unknown[], total: number | null = rows.length) {
  return {
    items: [{ SearchId: 1, Keyword: null, Offset: 0, Limit: 200, TotalJobsCount: total, SiteNumber: "CX_1002", requisitionList: rows }],
    count: 1,
    hasMore: false,
  };
}

export function oracleDetail(overrides: Record<string, unknown> = {}) {
  return {
    items: [{
      Id: "210690282",
      Title: "2027 Markets Summer Analyst Program - Research",
      Category: "Analysts",
      ExternalPostedStartDate: "2026-11-06T19:48:29+00:00",
      ExternalPostedEndDate: "2099-11-09T05:00:00+00:00",
      JobSchedule: "Full time",
      ExternalDescriptionStr: "<p>If you're ambitious and eager to apply your knowledge to real-world financial scenarios, this role is for you.</p>",
      ExternalResponsibilitiesStr: "",
      ExternalQualificationsStr: "<ul><li>Strong analytical skills</li></ul>",
      CorporateDescriptionStr: "<div>JPMorganChase, one of the oldest financial institutions...</div>",
      ShortDescriptionStr: "In ever-changing global markets...",
      PrimaryLocation: "New York, NY, United States",
      PrimaryLocationCountry: "US",
      WorkplaceTypeCode: null,
      WorkplaceType: "",
      secondaryLocations: [],
      workLocation: [],
      requisitionFlexFields: [{ Prompt: "Base Pay/Salary", Value: "New York,NY $100,000.00-$110,000.00", ControlType: "TextArea", SequenceNumber: 30 }],
      ...overrides,
    }],
    count: 1,
    hasMore: false,
  };
}

export const oracleEmptyDetail = { items: [], count: 0, hasMore: false, limit: 499, offset: 0 };
