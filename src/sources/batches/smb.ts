import type { AtsKind } from "../../domain/campaign.js";
import { bambooHrAdapter } from "../bambooHr.js";
import { breezyAdapter } from "../breezy.js";
import type { SourceCatalogEntry } from "../catalog.js";
import { clearCompanyAdapter } from "../clearCompany.js";
import { doverAdapter } from "../dover.js";
import { gemAdapter } from "../gem.js";
import { hibobAdapter } from "../hibob.js";
import { jazzHrAdapter } from "../jazzHr.js";
import { personioAdapter } from "../personio.js";
import { pinpointAdapter } from "../pinpoint.js";
import { ripplingAdapter } from "../rippling.js";
import { teamtailorAdapter } from "../teamtailor.js";
import type { SourceAdapter } from "../types.js";
import { zohoRecruitAdapter } from "../zohoRecruit.js";

/**
 * Startup and SMB ATS adapters: BambooHR, JazzHR, Breezy, Rippling, Gem,
 * Pinpoint, Dover, Teamtailor, Personio, HiBob, Zoho Recruit and ClearCompany.
 * Discovery only; applications to these boards are prepared as manual packets.
 * Board formats and how to find them: docs/SOURCES_SMB_AND_LEADS.md.
 */
export const SMB_ADAPTERS: Partial<Record<AtsKind, SourceAdapter>> = {
  bamboohr: bambooHrAdapter,
  jazzhr: jazzHrAdapter,
  breezy: breezyAdapter,
  rippling: ripplingAdapter,
  gem: gemAdapter,
  pinpoint: pinpointAdapter,
  dover: doverAdapter,
  teamtailor: teamtailorAdapter,
  personio: personioAdapter,
  hibob: hibobAdapter,
  zohorecruit: zohoRecruitAdapter,
  clearcompany: clearCompanyAdapter,
};

const MANUAL_ONLY =
  "Discovery only. Manual submission until new browser support and explicit domains and company permission are configured.";
const DETAIL_CAP =
  "Per-posting detail requests are capped per board (AUTOAPPLY_SMB_DETAIL_LIMIT, default 100); narrow large boards with company.query.";
const QUERY_LOCAL = "No search endpoint: company.query is matched against titles locally.";

function entry(id: AtsKind, label: string, url: string, docs: string, limitations: readonly string[]): SourceCatalogEntry {
  return {
    id, label, url, docs, kind: "ats", integration: "discovery-only", access: "public", readiness: "ready",
    submission: "manual-only", limitations: [...limitations, MANUAL_ONLY],
  };
}

/** Catalog entries describing each adapter above, shown by list_sources. */
export const SMB_CATALOG: readonly SourceCatalogEntry[] = [
  entry("bamboohr", "BambooHR", "https://www.bamboohr.com", "https://documentation.bamboohr.com/docs", [
    "Board is the tenant subdomain of <tenant>.bamboohr.com, e.g. \"acme\".",
    "Reads the public careers list, then one detail request per posting for description, date and pay.",
    QUERY_LOCAL, DETAIL_CAP,
  ]),
  entry("jazzhr", "JazzHR", "https://www.jazzhr.com", "https://www.jazzhr.com", [
    "Board is the tenant subdomain of <tenant>.applytojob.com, e.g. \"acme\".",
    "Reads the server-rendered ApplyToJob board and each posting page's schema.org metadata; the API needs an employer key.",
    "HTML-only host: resolve_company_board cannot probe it; add the board from the employer's careers link instead.",
    QUERY_LOCAL, DETAIL_CAP,
  ]),
  entry("breezy", "Breezy HR", "https://breezy.hr", "https://developer.breezy.hr", [
    "Board is the tenant subdomain of <tenant>.breezy.hr, e.g. \"acme\".",
    "Reads the public /json position feed and each posting page's schema.org metadata; the authenticated API is not used.",
    QUERY_LOCAL, DETAIL_CAP,
  ]),
  entry("rippling", "Rippling ATS", "https://www.rippling.com/recruiting", "https://ats.rippling.com", [
    "Board is the slug in ats.rippling.com/<slug>/jobs, e.g. \"acme\".",
    "Reads the board's public listing API, then one detail request per posting for description, date and pay ranges.",
    QUERY_LOCAL, DETAIL_CAP,
  ]),
  entry("gem", "Gem", "https://www.gem.com", "https://api.gem.com/job_board/v0/reference", [
    "Board is the vanity path of jobs.gem.com/<board>, e.g. \"acme\".",
    "Uses the documented unauthenticated Job Board API; one request returns every post with its description.",
    QUERY_LOCAL,
  ]),
  entry("pinpoint", "Pinpoint", "https://www.pinpointhq.com", "https://www.pinpointhq.com", [
    "Board is the tenant subdomain of <tenant>.pinpointhq.com, e.g. \"acme\".",
    "Reads the public postings.json feed; posting pages add dates and countries. Pinpoint's seeded demo postings are dropped.",
    QUERY_LOCAL, DETAIL_CAP,
  ]),
  entry("dover", "Dover", "https://www.dover.com", "https://app.dover.com", [
    "Board is the company slug in app.dover.com/apply/<slug>/<job-id>, e.g. \"acme\".",
    "Resolves the slug to Dover's client id, lists published jobs, then one detail request per posting.",
    QUERY_LOCAL, DETAIL_CAP,
  ]),
  entry("teamtailor", "Teamtailor", "https://www.teamtailor.com", "https://www.teamtailor.com", [
    "Board is the subdomain of <slug>.teamtailor.com, e.g. \"acme\"; North American sites use \"acme.na\" (<slug>.na.teamtailor.com).",
    "Reads the public jobs.json feed, which carries descriptions, dates, locations and published pay.",
    "Branded careers domains are not read directly; use the tenant's teamtailor.com subdomain.",
    QUERY_LOCAL,
  ]),
  entry("personio", "Personio", "https://www.personio.com", "https://developer.personio.de/docs/integration-of-personio-xml-feed", [
    "Board is the subdomain of <slug>.jobs.personio.de, e.g. \"acme\".",
    "Reads the documented XML feed (or the career site's search.json when the feed is disabled); posting pages add descriptions.",
    QUERY_LOCAL, DETAIL_CAP,
  ]),
  entry("hibob", "HiBob", "https://www.hibob.com", "https://www.hibob.com", [
    "Board is the tenant label of <tenant>.careers.hibob.com, e.g. \"acme\" (keep any suffix the host shows).",
    "Reads the career site's own job-ad JSON, which names the tenant in a header; no login or token is involved.",
    "resolve_company_board cannot probe HiBob (the endpoint needs that header); add the board from the careers link instead.",
    QUERY_LOCAL,
  ]),
  entry("zohorecruit", "Zoho Recruit", "https://www.zoho.com/recruit/", "https://www.zoho.com/recruit/", [
    "Board is the tenant subdomain of <tenant>.zohorecruit.com, e.g. \"acme\"; other data centres use \"acme.eu\", \"acme.in\" or \"acme.com.au\".",
    "Reads the server-rendered /jobs/Careers page's embedded job list without executing scripts; legacy career sites are unsupported.",
    "HTML-only host: resolve_company_board cannot probe it.",
    QUERY_LOCAL,
  ]),
  entry("clearcompany", "ClearCompany", "https://www.clearcompany.com", "https://www.clearcompany.com", [
    "Board is the siteId GUID from the employer careers page's career-site.js?siteId=<GUID> embed script.",
    "Reads the public careers API behind that widget; pay is kept only for US or Canadian postings because no currency is published.",
    "A GUID cannot be guessed, so resolve_company_board cannot probe ClearCompany.",
    QUERY_LOCAL,
  ]),
];
