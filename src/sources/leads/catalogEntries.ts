import type { SourceCatalogEntry } from "../catalog.js";

const VERIFY = "Unverified leads: verify each job on the employer's own careers site or ATS before preparing an application.";
const NO_REPUBLISH = "Credit the source and link back as its terms require; do not republish listings.";

function aggregator(
  id: string, label: string, url: string, docs: string, limitations: readonly string[],
): SourceCatalogEntry {
  return {
    id, label, url, docs, kind: "aggregator", integration: "lead-search", access: "public", readiness: "ready",
    submission: "not-supported", limitations: [...limitations, VERIFY, NO_REPUBLISH],
  };
}

/** Aggregator and VC-network lead sources searched by search_job_sources. */
export const LEAD_SOURCE_CATALOG: readonly SourceCatalogEntry[] = [
  aggregator("builtin", "Built In (US tech boards)", "https://builtin.com/jobs", "https://builtin.com/robots.txt", [
    "Reads one robots.txt-permitted listing page per request (category pages and path-based keyword pages, pages 1-3); no ?search= URLs, no crawling.",
    "Built In's Community Terms prohibit automated access or copying; use only for explicit, person-reviewed searches. Requires category; site selects the city market.",
  ]),
  aggregator("remoteok", "Remote OK", "https://remoteok.com", "https://remoteok.com/api", [
    "Public API with the newest ~100 remote jobs; filters run locally on a 15-minute cache.",
    "API terms require a followed link back to the Remote OK listing and naming Remote OK as the source; robots.txt signals ai-train=no.",
  ]),
  aggregator("remotive", "Remotive", "https://remotive.com", "https://github.com/remotive-com/remote-jobs-api", [
    "Public API with a 24-hour listing delay. Requests are spaced 30 seconds apart (Remotive blocks more than two a minute) and cached six hours.",
    "Terms: link back to the Remotive URL and name Remotive; do not submit its jobs to third-party job sites.",
  ]),
  aggregator("weworkremotely", "We Work Remotely", "https://weworkremotely.com", "https://weworkremotely.com/remote-job-rss-feed", [
    "Public RSS feeds (all jobs or one category), cached for the feed's 60-minute TTL and filtered locally.",
    "Feed terms: anyone may use the feeds if listings link back to We Work Remotely.",
  ]),
  aggregator("jobicy", "Jobicy", "https://jobicy.com", "https://jobicy.com/jobs-rss-feed", [
    "Public API covering the last seven days of remote jobs; cursor pagination is capped at page 5.",
    "Fair use: credit Jobicy with a direct link and send applications through the Jobicy job URL.",
  ]),
  aggregator("themuse", "The Muse", "https://www.themuse.com", "https://www.themuse.com/developers/api/v2", [
    "No keyword search: query must be a Muse category. 500 requests an hour without a key.",
    "Registration is required for use beyond testing; set AUTOAPPLY_THEMUSE_API_KEY. The key is never returned.",
  ]),
  aggregator("jobbankca", "Job Bank (Government of Canada)", "https://www.jobbank.gc.ca", "https://www.jobbank.gc.ca/termsofuseseeker", [
    "Reads Job Bank's anonymous public Atom search feed, one page per explicit request, 5 seconds apart (robots.txt crawl delay). Canada only.",
    "Job Bank's job-seeker terms prohibit automated access to its services: open and verify every posting yourself; never automate sign-in, Job Match or applications.",
  ]),
  aggregator("getro", "Getro VC portfolio boards", "https://www.getro.com", "https://www.getro.com", [
    "site selects a known network (e.g. jobs.generalcatalyst.com, jobs.accel.com), any <name>.getro.com board, or a Getro collection id.",
    "Leads carry the employer's ATS link as applyUrl; results include no description.",
  ]),
  aggregator("consider", "Consider VC talent networks", "https://consider.com", "https://consider.com", [
    "site selects a known board (e.g. jobs.sequoiacap.com, jobs.lsvp.com, jobs.kleinerperkins.com); each search reuses the board page's anonymous session.",
    "Leads carry the employer's ATS link as applyUrl; results include no description.",
  ]),
  aggregator("workingnomads", "Working Nomads", "https://www.workingnomads.com", "https://www.workingnomads.com/api/exposed_jobs/", [
    "Undocumented public feed of its most recent jobs; filters run locally on a 15-minute cache.",
  ]),
];
