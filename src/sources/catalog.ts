import type { SourceReadiness } from "./leadTypes.js";

export interface SourceCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly docs: string;
  readonly kind: "ats" | "aggregator" | "community" | "lead-page";
  readonly integration: "board-discovery" | "discovery-only" | "lead-search" | "thread-discovery" | "page-scan";
  readonly access: "public" | "api-key-pro-plus" | "public-page";
  readonly readiness: SourceReadiness;
  readonly submission: "guarded-browser" | "manual-only" | "not-supported";
  readonly limitations: readonly string[];
}

const GUARDED_SUBMISSION =
  "Submission is subject to browser support, explicit campaign domains and company permission, packet approval and all submission guards.";
const NEW_ATS_LIMITATION =
  "Discovery only. Manual submission until new browser support and explicit domains and company permission are configured.";
const LEAD_PAGE_LIMITATION =
  "scan_source_page reads one public lead page, not an anonymous bulk API. Client-rendered content may require manual follow-up. Verify employer postings before registering boards.";

const SOURCE_CATALOG: readonly SourceCatalogEntry[] = [
  {
    id: "greenhouse", label: "Greenhouse", url: "https://www.greenhouse.com",
    docs: "https://developers.greenhouse.io/job-board.html",
    kind: "ats", integration: "board-discovery", access: "public", readiness: "ready", submission: "guarded-browser",
    limitations: ["Requires a verified employer board token; not a global job search API.", GUARDED_SUBMISSION],
  },
  {
    id: "lever", label: "Lever", url: "https://www.lever.co",
    docs: "https://github.com/lever/postings-api",
    kind: "ats", integration: "board-discovery", access: "public", readiness: "ready", submission: "guarded-browser",
    limitations: ["Requires a verified employer board slug and correct global/EU region.", GUARDED_SUBMISSION],
  },
  {
    id: "ashby", label: "Ashby", url: "https://www.ashbyhq.com",
    docs: "https://developers.ashbyhq.com/docs/public-job-posting-api",
    kind: "ats", integration: "board-discovery", access: "public", readiness: "ready", submission: "guarded-browser",
    limitations: ["Requires a verified employer board name; employer verification gates may require a human.", GUARDED_SUBMISSION],
  },
  {
    id: "workday", label: "Workday", url: "https://www.workday.com",
    docs: "https://www.workday.com/en-us/products/talent-management/recruiting.html",
    kind: "ats", integration: "board-discovery", access: "public", readiness: "ready", submission: "guarded-browser",
    limitations: ["Requires the employer's real tenant/datacenter/site URL; cannot resolve it by guessing.", GUARDED_SUBMISSION],
  },
  {
    id: "hackernews", label: "Hacker News Who is hiring?", url: "https://news.ycombinator.com",
    docs: "https://github.com/HackerNews/API",
    kind: "community", integration: "thread-discovery", access: "public", readiness: "ready", submission: "not-supported",
    limitations: ["Thread prose is only a lead source. Verify extracted employer ATS boards before campaign ingestion."],
  },
  {
    id: "smartrecruiters", label: "SmartRecruiters", url: "https://www.smartrecruiters.com",
    docs: "https://developers.smartrecruiters.com/docs/endpoints",
    kind: "ats", integration: "discovery-only", access: "public", readiness: "ready", submission: "manual-only",
    limitations: ["Uses public postings for a verified employer identifier, not a global job API.", NEW_ATS_LIMITATION],
  },
  {
    id: "recruitee", label: "Recruitee", url: "https://recruitee.com",
    docs: "https://support.recruitee.com/en/articles/8213076-faq-api",
    kind: "ats", integration: "discovery-only", access: "public", readiness: "ready", submission: "manual-only",
    limitations: [
      "Uses the public company XML offers feed. JSON requires employer tokens from February 10, 2027; XML is exempt.",
      "Authentication notice: https://docs.recruitee.com/reference/authentication-1",
      NEW_ATS_LIMITATION,
    ],
  },
  {
    id: "workable", label: "Workable", url: "https://apply.workable.com",
    docs: "https://workable.readme.io/reference/jobs-1",
    kind: "ats", integration: "discovery-only", access: "public", readiness: "ready", submission: "manual-only",
    limitations: ["Public hosted careers postings only; the authenticated employer management API is a separate product.", NEW_ATS_LIMITATION],
  },
  {
    id: "himalayas", label: "Himalayas", url: "https://himalayas.app",
    docs: "https://himalayas.app/api",
    kind: "aggregator", integration: "lead-search", access: "public", readiness: "ready", submission: "not-supported",
    limitations: [
      "No API key required. Fetches a bounded filtered page, not a full-feed scan.",
      "Verify each lead with its employer before preparing an application; never treat aggregate results as verified ATS jobs.",
      "Credit Himalayas and link back. Do not republish to third-party job sites.",
      "Geographic restrictions and pay periods remain source-reported; no inferred worldwide eligibility or annual salary.",
    ],
  },
  {
    id: "foorilla", label: "Foorilla (isecjobs successor)", url: "https://foorilla.com",
    docs: "https://foorilla.com/api/llms.txt",
    kind: "aggregator", integration: "lead-search", access: "api-key-pro-plus", readiness: "credentials-required",
    submission: "not-supported",
    limitations: [
      "Requires AUTOAPPLY_FOORILLA_API_KEY and an active PRO+ subscription; readiness checks key presence only, not verified account access.",
      "Verify each lead with the employer. The documented API has no job description or pay period; estimated salaries are not reported pay.",
      "CC BY-SA 4.0 attribution, license link, change indication and share-alike requirements apply.",
      "Rate limits are 5 requests/second and 600/minute; this connector retains at least 700ms per-host throttling.",
    ],
  },
  {
    id: "a16z", label: "a16z portfolio jobs", url: "https://jobs.a16z.com/jobs",
    docs: "https://jobs.a16z.com/jobs",
    kind: "lead-page", integration: "page-scan", access: "public-page", readiness: "ready",
    submission: "not-supported", limitations: [LEAD_PAGE_LIMITATION],
  },
  {
    id: "sequoia", label: "Sequoia portfolio jobs", url: "https://jobs.sequoiacap.com/jobs",
    docs: "https://jobs.sequoiacap.com/jobs",
    kind: "lead-page", integration: "page-scan", access: "public-page", readiness: "ready",
    submission: "not-supported", limitations: [LEAD_PAGE_LIMITATION],
  },
  {
    id: "yc", label: "Y Combinator Work at a Startup", url: "https://www.workatastartup.com/jobs",
    docs: "https://www.ycombinator.com/jobs",
    kind: "lead-page", integration: "page-scan", access: "public-page", readiness: "ready",
    submission: "not-supported", limitations: [LEAD_PAGE_LIMITATION, "Some application or matching features require a user account."],
  },
  {
    id: "builtinsf", label: "Built In San Francisco", url: "https://www.builtinsf.com/jobs",
    docs: "https://www.builtinsf.com/jobs",
    kind: "lead-page", integration: "page-scan", access: "public-page", readiness: "ready",
    submission: "not-supported", limitations: [LEAD_PAGE_LIMITATION],
  },
];

/** Catalog entries are built in; credentials are neither persisted nor returned. */
export function listSourceCatalog(): readonly SourceCatalogEntry[] {
  const foorillaConfigured = Boolean(process.env.AUTOAPPLY_FOORILLA_API_KEY?.trim());
  return SOURCE_CATALOG.map((source) => ({
    ...source,
    ...(source.id === "foorilla"
      ? { readiness: foorillaConfigured ? "credentials-configured" as const : "credentials-required" as const }
      : {}),
    limitations: [...source.limitations],
  }));
}
