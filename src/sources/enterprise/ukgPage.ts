/**
 * UKG Pro Recruiting job pages embed the posting as
 * `new US.Opportunity.CandidateOpportunityDetail({...})`, cut out with a
 * string-aware brace walk because descriptions routinely contain braces and
 * quotes that a regex would stop on.
 */

import { balancedObject } from "./markup.js";

const MARKER = "CandidateOpportunityDetail(";
/** Notices UKG renders, instead of a record, for an opportunity a candidate cannot open. */
const NOTICES: readonly [string, string][] = [
  ["Opportunity.OpportunityError.OpportunityUnavailableMessage", "UKG shows the opportunity as currently not available"],
  ["Opportunity.OpportunityError.NotFoundErrorMessage", "UKG cannot find the opportunity"],
  ["Opportunity.OpportunityError.InternalOpportunityRequiresAuth", "UKG now shows the opportunity to internal candidates only"],
];

export type UkgPage =
  | { status: "record"; record: Record<string, unknown> }
  | { status: "unavailable"; reason: string }
  | { status: "unreadable" };

/** What an OpportunityDetail page says about one opportunity id. */
export function readUkgPage(html: string, opportunityId: string): UkgPage {
  const marker = html.indexOf(MARKER);
  if (marker < 0) {
    const notice = NOTICES.find(([key]) => html.includes(`data-i18n="${key}"`));
    return notice ? { status: "unavailable", reason: notice[1] } : { status: "unreadable" };
  }
  const json = balancedObject(html, marker + MARKER.length);
  if (!json) return { status: "unreadable" };
  let record: unknown;
  try {
    record = JSON.parse(json);
  } catch {
    return { status: "unreadable" };
  }
  if (!record || typeof record !== "object") return { status: "unreadable" };
  const id = (record as Record<string, unknown>).Id;
  return typeof id === "string" && id.toLowerCase() === opportunityId.toLowerCase()
    ? { status: "record", record: record as Record<string, unknown> }
    : { status: "unreadable" };
}
