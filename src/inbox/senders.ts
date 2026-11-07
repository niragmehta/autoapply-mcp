/**
 * Who sends hiring mail.
 *
 * A reply to an application comes from the employer's own domain, from the
 * applicant tracking system that hosts its board, or from a scheduling or
 * assessment service it uses. Only mail from one of those is ever downloaded:
 * the inbox scanner decides from the envelope alone, so unrelated mail in the
 * same mailbox is never read.
 */

export type SenderKind = "ats" | "scheduling" | "assessment" | "network";
export type KnownSender = { domain: string; kind: SenderKind; ats?: string };

const ats = (domain: string, kind?: string): KnownSender => ({ domain, kind: "ats", ...(kind ? { ats: kind } : {}) });
const scheduling = (domain: string): KnownSender => ({ domain, kind: "scheduling" });
const assessment = (domain: string): KnownSender => ({ domain, kind: "assessment" });
const network = (domain: string): KnownSender => ({ domain, kind: "network" });

export const KNOWN_RECRUITING_SENDERS: readonly KnownSender[] = [
  ats("greenhouse-mail.io", "greenhouse"),
  ats("greenhouse.io", "greenhouse"),
  ats("myworkday.com", "workday"),
  ats("workday.com", "workday"),
  ats("myworkdayjobs.com", "workday"),
  ats("myworkdaysite.com", "workday"),
  ats("lever.co", "lever"),
  ats("ashbyhq.com", "ashby"),
  ats("smartrecruiters.com", "smartrecruiters"),
  ats("icims.com", "icims"),
  ats("jobvite.com", "jobvite"),
  ats("successfactors.com", "successfactors"),
  ats("successfactors.eu", "successfactors"),
  ats("sapsf.com", "successfactors"),
  ats("sapsf.eu", "successfactors"),
  ats("taleo.net", "taleo"),
  ats("oraclecloud.com", "oraclecloud"),
  ats("bamboohr.com", "bamboohr"),
  ats("breezy.hr", "breezy"),
  ats("breezyhr.com", "breezy"),
  ats("rippling.com", "rippling"),
  ats("gem.com", "gem"),
  ats("dover.com", "dover"),
  ats("dover.io", "dover"),
  ats("teamtailor.com", "teamtailor"),
  ats("teamtailor-mail.com", "teamtailor"),
  ats("personio.com", "personio"),
  ats("personio.de", "personio"),
  ats("hibob.com", "hibob"),
  ats("applytojob.com", "jazzhr"),
  ats("jazzhr.com", "jazzhr"),
  ats("workable.com", "workable"),
  ats("workablemail.com", "workable"),
  ats("recruitee.com", "recruitee"),
  ats("pinpointhq.com", "pinpoint"),
  ats("zohorecruit.com", "zohorecruit"),
  ats("zohorecruit.eu", "zohorecruit"),
  ats("clearcompany.com", "clearcompany"),
  ats("ultipro.com", "ultipro"),
  ats("ukg.com", "ultipro"),
  ats("adp.com", "adp"),
  ats("paylocity.com", "paylocity"),
  ats("avature.net", "avature"),
  ats("eightfold.ai", "eightfold"),
  ats("phenompeople.com", "phenom"),
  ats("phenom.com", "phenom"),
  ats("csod.com", "csod"),
  ats("cornerstoneondemand.com", "csod"),
  ats("comeet.co"),
  ats("paradox.ai"),
  scheduling("calendly.com"),
  scheduling("goodtime.io"),
  scheduling("modernloop.io"),
  scheduling("cal.com"),
  scheduling("prelude.co"),
  scheduling("yello.co"),
  assessment("hackerrank.com"),
  assessment("hackerrankforwork.com"),
  assessment("codesignal.com"),
  assessment("codility.com"),
  assessment("karat.com"),
  assessment("karat.io"),
  assessment("coderpad.io"),
  assessment("testgorilla.com"),
  assessment("hirevue.com"),
  assessment("byteboard.dev"),
  assessment("qualified.io"),
  assessment("coderbyte.com"),
  assessment("criteriacorp.com"),
  assessment("mettl.com"),
  network("linkedin.com"),
  network("indeed.com"),
  network("indeedemail.com"),
  network("glassdoor.com"),
  network("wellfound.com"),
  network("workatastartup.com"),
  network("welcometothejungle.com"),
  network("otta.com"),
  network("hired.com"),
  network("dice.com"),
  network("ziprecruiter.com"),
  network("builtin.com"),
];

/**
 * Free mail providers. A recruiter writing from one is real, but the domain
 * says nothing about the employer, so it is never taken as a company match.
 */
const PERSONAL_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "fastmail.com",
  "hey.com",
]);

/** Two-label public suffixes common enough to matter for employer domains. */
const SECOND_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "com.au", "net.au", "co.nz", "co.jp", "co.in", "co.kr", "com.br",
  "com.mx", "com.sg", "com.hk", "com.cn", "co.za", "com.tr", "co.il", "com.ar",
]);

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/** The domain part of an address such as `Name <a@b.com>` or `a@b.com`. */
export function addressDomain(address: string): string {
  const bare = address.trim().replace(/^.*</, "").replace(/>.*$/, "");
  const at = bare.lastIndexOf("@");
  return at < 0 ? "" : normalizeHost(bare.slice(at + 1));
}

export function addressLocalPart(address: string): string {
  const bare = address.trim().replace(/^.*</, "").replace(/>.*$/, "");
  const at = bare.lastIndexOf("@");
  return at < 0 ? "" : bare.slice(0, at).toLowerCase();
}

/** Whether `host` is `domain` or a subdomain of it, on a dot boundary. */
export function hostWithin(host: string, domain: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === domain || normalized.endsWith(`.${domain}`);
}

export function knownSender(address: string): KnownSender | null {
  const domain = addressDomain(address);
  if (!domain) return null;
  return KNOWN_RECRUITING_SENDERS.find((sender) => hostWithin(domain, sender.domain)) ?? null;
}

export function isKnownRecruitingHost(host: string): boolean {
  return KNOWN_RECRUITING_SENDERS.some((sender) => hostWithin(host, sender.domain));
}

export function isPersonalMailDomain(domain: string): boolean {
  return PERSONAL_MAIL_DOMAINS.has(normalizeHost(domain));
}

/** The registrable domain: `mail.acme.co.uk` becomes `acme.co.uk`. */
export function registrableDomain(host: string): string {
  const labels = normalizeHost(host).split(".").filter((label) => label.length > 0);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return SECOND_LEVEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

/** The label that names the organisation: `acme` for `careers.acme.com`. */
export function registrableLabel(host: string): string {
  return registrableDomain(host).split(".")[0] ?? "";
}
