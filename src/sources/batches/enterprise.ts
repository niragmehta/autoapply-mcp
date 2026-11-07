import type { AtsKind } from "../../domain/campaign.js";
import { adpAdapter } from "../adp.js";
import { avatureAdapter } from "../avature.js";
import type { SourceCatalogEntry } from "../catalog.js";
import { cornerstoneAdapter } from "../cornerstone.js";
import { eightfoldAdapter } from "../eightfold.js";
import { icimsAdapter } from "../icims.js";
import { jobviteAdapter } from "../jobvite.js";
import { oracleCloudAdapter } from "../oracleCloud.js";
import { paylocityAdapter } from "../paylocity.js";
import { phenomAdapter } from "../phenom.js";
import { successFactorsAdapter } from "../successFactors.js";
import { taleoAdapter } from "../taleo.js";
import type { SourceAdapter } from "../types.js";
import { ukgAdapter } from "../ukg.js";

/**
 * Enterprise ATS adapters: iCIMS, Taleo, SuccessFactors, Oracle Cloud HCM,
 * Phenom, Eightfold, Avature, Cornerstone, UKG, ADP, Paylocity and Jobvite.
 * Discovery only; applications to these boards are prepared as manual packets.
 * Board formats and limits are documented in docs/SOURCES_ENTERPRISE.md.
 */
export const ENTERPRISE_ADAPTERS: Partial<Record<AtsKind, SourceAdapter>> = {
  icims: icimsAdapter,
  taleo: taleoAdapter,
  successfactors: successFactorsAdapter,
  oraclecloud: oracleCloudAdapter,
  phenom: phenomAdapter,
  eightfold: eightfoldAdapter,
  avature: avatureAdapter,
  csod: cornerstoneAdapter,
  ultipro: ukgAdapter,
  adp: adpAdapter,
  paylocity: paylocityAdapter,
  jobvite: jobviteAdapter,
};

const MANUAL =
  "Discovery only: postings are fetched, gated and scored; applications are prepared as manual packets for a person to submit.";
const CAPS =
  "Lists up to AUTOAPPLY_<ATS>_MAX_POSTINGS postings (500) and reads up to AUTOAPPLY_<ATS>_MAX_DETAILS descriptions (100) per board; narrow large boards with the company query.";

function entry(id: AtsKind, label: string, url: string, docs: string, limitations: readonly string[]): SourceCatalogEntry {
  return {
    id, label, url, docs,
    kind: "ats", integration: "discovery-only", access: "public", readiness: "ready", submission: "manual-only",
    limitations: [...limitations, MANUAL],
  };
}

/** Catalog entries describing each adapter above, shown by list_sources. */
export const ENTERPRISE_CATALOG: readonly SourceCatalogEntry[] = [
  entry("icims", "iCIMS", "https://www.icims.com", "https://developer.icims.com", [
    'Board is the portal host, e.g. "careers-gdms.icims.com" from https://careers-gdms.icims.com/jobs/search?ss=1; a bare tenant means careers-<tenant>.icims.com.',
    "Reads the public portal pages (no anonymous API); descriptions and dates come from each posting page's schema.org data.",
    CAPS,
  ]),
  entry("taleo", "Oracle Taleo Enterprise", "https://www.oracle.com/human-capital-management/taleo/", "https://docs.oracle.com/en/cloud/saas/taleo-enterprise/", [
    'Board is "host/careersection", e.g. "hdr.taleo.net/ex" from https://hdr.taleo.net/careersection/ex/jobsearch.ftl. Taleo Business Edition is not supported.',
    "Replays the career section's anonymous search; private sections without a public portal are refused.",
    CAPS,
  ]),
  entry("successfactors", "SAP SuccessFactors Recruiting", "https://www.sap.com/products/hcm/recruiting-software.html", "https://help.sap.com/docs/SAP_SUCCESSFACTORS_RECRUITING", [
    'Board is the career-site host (plus a brand path if any), e.g. "jobs.zf.com" from https://jobs.zf.com/search/.',
    "Career Site Builder sites are read in the en_US locale without descriptions; sites behind a Cloudflare challenge (jobs.sap.com) cannot be read.",
    CAPS,
  ]),
  entry("oraclecloud", "Oracle Recruiting Cloud", "https://www.oracle.com/human-capital-management/recruiting/", "https://docs.oracle.com/en/cloud/saas/human-resources/", [
    'Board is "host/siteNumber", e.g. "jpmc.fa.oraclecloud.com/CX_1002" from .../hcmUI/CandidateExperience/en/sites/CX_1002/jobs.',
    "Some tenants put a WAF in front of the API that refuses cloud and datacenter IP addresses.",
    CAPS,
  ]),
  entry("phenom", "Phenom", "https://www.phenom.com", "https://developer.phenom.com", [
    'Board is "host/country/language", e.g. "careers.mastercard.com/us/en" from https://careers.mastercard.com/us/en/search-results.',
    "Uses the site's public widget API; postings often apply on another ATS, linked from the posting page.",
    CAPS,
  ]),
  entry("eightfold", "Eightfold AI", "https://eightfold.ai", "https://docs.eightfold.ai", [
    'Board is "tenant" or "tenant/domain", e.g. "qualcomm/qualcomm.com" from https://qualcomm.eightfold.ai/careers?domain=qualcomm.com.',
    "Ten postings per request and a strict rate limit: a listing stops early, keeping what was read, when Eightfold answers 429.",
    CAPS,
  ]),
  entry("avature", "Avature", "https://www.avature.net", "https://www.avature.net", [
    'Board is "host/site path", e.g. "bloomberg.avature.net/careers" from https://bloomberg.avature.net/careers/SearchJobs.',
    "Reads the server-rendered search and job pages; some tenants show no posting dates.",
    CAPS,
  ]),
  entry("csod", "Cornerstone OnDemand", "https://www.cornerstoneondemand.com", "https://csod.dev", [
    'Board is "host/siteId", e.g. "cornerstone.csod.com/2" from https://cornerstone.csod.com/ux/ats/careersite/2/home?c=cornerstone.',
    "Uses the anonymous token the career site boots with; tenants that also demand session cookies answer 401 and are reported as failing.",
    CAPS,
  ]),
  entry("ultipro", "UKG Pro Recruiting (UltiPro)", "https://www.ukg.com", "https://developer.ukg.com", [
    'Board is "host/tenant/boardId", e.g. "recruiting.ultipro.com/MIC1014MICS/aba7ab7f-e037-4961-b6cf-c1491e2105e0".',
    "Descriptions, pay ranges and the open/closed flag come from each opportunity page.",
    CAPS,
  ]),
  entry("adp", "ADP Workforce Now Recruitment", "https://www.adp.com", "https://developers.adp.com", [
    'Board is the career center "cid" (plus "/ccId" when the URL has one), e.g. "1774d0ee-6390-4d36-9333-1f675e3b3058".',
    "The public staffing API has no keyword search, so the company query is not used.",
    CAPS,
  ]),
  entry("paylocity", "Paylocity Recruiting", "https://www.paylocity.com", "https://developer.paylocity.com", [
    "Board is the board GUID from https://recruiting.paylocity.com/Recruiting/Jobs/All/<guid>.",
    "No keyword search; a posting URL does not name its board, so pasted Paylocity posting URLs need the board configured first.",
    CAPS,
  ]),
  entry("jobvite", "Jobvite", "https://www.jobvite.com", "https://www.jobvite.com", [
    'Board is the vanity slug, e.g. "tylertech" from https://jobs.jobvite.com/tylertech/jobs.',
    "Reads the company XML feed (full descriptions); when the feed is rate-limited it falls back to posting pages. No keyword search.",
    CAPS,
  ]),
];
