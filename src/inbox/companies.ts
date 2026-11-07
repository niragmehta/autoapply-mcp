import type { Db } from "../db/database.js";
import { addressDomain, addressLocalPart, isKnownRecruitingHost, isPersonalMailDomain, knownSender, registrableLabel } from "./senders.js";

/**
 * The applications a reply could be about, and how each employer identifies
 * itself in mail: its name as written, the domain it sends from, and the board
 * token or Workday tenant its postings were found under.
 */

export type ApplicationCandidate = {
  applicationId: string;
  status: string;
  submittedAt: string | null;
  createdAt: string;
  companyName: string;
  title: string;
  ats: string;
  board: string;
  url: string;
  applyUrl: string;
  externalId: string;
};

export type CompanyIdentity = {
  name: string;
  full: RegExp;
  short: RegExp | null;
  /** Lower-case first words of the name; a text without one cannot name the company, so its regex is skipped. */
  probes: readonly string[];
  /** One word, such as "Anchor": a body mention must be capitalised to count. */
  singleWord: boolean;
  /** Collapsed names, board tokens and career-site labels a sender domain may carry. */
  keys: ReadonlySet<string>;
  /** Workday tenants, which Workday sends each employer's mail from (`acme@myworkday.com`). */
  tenants: ReadonlySet<string>;
  applications: readonly ApplicationCandidate[];
};

export type ApplicationIndex = {
  applications: readonly ApplicationCandidate[];
  companies: ReadonlyMap<string, CompanyIdentity>;
};

/** Statuses where the employer may have the application. Drafts and retired ones never reached it. */
const REACHABLE_STATUSES = ["submitted", "approved", "failed", "needs_human", "awaiting_approval"];

type Row = Record<string, unknown>;

export function loadApplicationIndex(db: Db): ApplicationIndex {
  const placeholders = REACHABLE_STATUSES.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT a.id, a.status, a.submitted_at, a.created_at, j.company_name, j.title, j.ats, j.board, j.url,
              j.apply_url, j.external_id
       FROM applications a JOIN jobs j ON j.id = a.job_id
       WHERE a.status IN (${placeholders})`,
    )
    .all(...REACHABLE_STATUSES) as Row[];
  return buildApplicationIndex(
    rows.map((row) => ({
      applicationId: String(row.id),
      status: String(row.status),
      submittedAt: row.submitted_at ? String(row.submitted_at) : null,
      createdAt: String(row.created_at),
      companyName: String(row.company_name),
      title: String(row.title),
      ats: String(row.ats),
      board: String(row.board ?? ""),
      url: String(row.url ?? ""),
      applyUrl: String(row.apply_url ?? ""),
      externalId: String(row.external_id ?? ""),
    })),
  );
}

export function buildApplicationIndex(applications: readonly ApplicationCandidate[]): ApplicationIndex {
  const grouped = new Map<string, ApplicationCandidate[]>();
  for (const application of applications) {
    const key = companyKey(application.companyName);
    grouped.set(key, [...(grouped.get(key) ?? []), application]);
  }
  const companies = new Map<string, CompanyIdentity>();
  for (const [key, members] of grouped) {
    const identity = companyIdentity(members);
    if (identity) companies.set(key, identity);
  }
  return { applications, companies };
}

export function companyKey(name: string): string {
  return name.trim().toLowerCase();
}

const CORPORATE_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "pbc", "gmbh", "plc",
  "sa", "ag", "bv", "nv", "lp", "llp", "holdings", "group",
  // A name written as a domain, such as Contoso.com, signs its mail "Contoso".
  "com", "net", "org",
]);

/** Words a company drops when it names itself in a sentence: "Nimbus" for Nimbus AI. */
const DESCRIPTIVE_SUFFIXES = new Set(["ai", "hq", "io", "labs", "lab", "technologies", "technology", "tech", "software", "systems", "app", "inc"]);

const NAME_GAP = "[\\s.,&'\\u2019-]*";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function namePattern(words: readonly string[], caseSensitive: boolean): RegExp {
  const body = words.map(escapeRegExp).join(NAME_GAP);
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, caseSensitive ? "g" : "gi");
}

function trimTrailing(words: readonly string[], drop: ReadonlySet<string>): string[] {
  const kept = [...words];
  while (kept.length > 1 && drop.has(kept[kept.length - 1]!.toLowerCase())) kept.pop();
  return kept;
}

const collapse = (words: readonly string[]): string => words.join("").toLowerCase();

function companyIdentity(members: readonly ApplicationCandidate[]): CompanyIdentity | null {
  const name = members[0]!.companyName.trim();
  const words = trimTrailing(name.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0), CORPORATE_SUFFIXES);
  if (words.length === 0) return null;
  const shortWords = trimTrailing(words, DESCRIPTIVE_SUFFIXES);
  // Two- and three-letter names (HP, F5, KLA) are ordinary letters in lower case.
  const caseSensitive = collapse(words).length <= 3;
  const short = shortWords.length < words.length && collapse(shortWords).length >= 4 ? namePattern(shortWords, false) : null;
  const keys = new Set<string>([collapse(words)]);
  if (short) keys.add(collapse(shortWords));
  const tenants = new Set<string>();
  for (const member of members) {
    for (const key of boardKeys(member)) keys.add(key);
    for (const tenant of workdayTenants(member)) tenants.add(tenant);
  }
  for (const tenant of tenants) keys.add(tenant);
  return {
    name,
    full: namePattern(words, caseSensitive),
    short,
    probes: [...new Set([words[0]!.toLowerCase(), shortWords[0]!.toLowerCase()])],
    singleWord: words.length === 1,
    keys,
    tenants,
    applications: members,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Board tokens and career-site hosts an employer's own domain is likely to share. */
function boardKeys(application: ApplicationCandidate): string[] {
  const keys: string[] = [];
  const board = application.board.split("/")[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
  if (board.length >= 3) keys.push(board);
  for (const host of [hostOf(application.url), hostOf(application.applyUrl)]) {
    if (!host || isKnownRecruitingHost(host)) continue;
    const label = registrableLabel(host);
    if (label.length >= 2) keys.push(label);
  }
  return keys;
}

function workdayTenants(application: ApplicationCandidate): string[] {
  if (application.ats !== "workday") return [];
  const tenants: string[] = [];
  const fromBoard = application.board.split("/")[0]?.toLowerCase() ?? "";
  if (fromBoard) tenants.push(fromBoard);
  for (const host of [hostOf(application.url), hostOf(application.applyUrl)]) {
    const match = /^([a-z0-9-]+)\.wd\d+\.myworkday(?:jobs|site)\.com$/.exec(host);
    if (match?.[1]) tenants.push(match[1]);
  }
  return tenants;
}

/** A sender domain's organisation label against a company key, tolerating suffixes such as `datadoghq`. */
export function labelMatchesKey(label: string, key: string): boolean {
  if (!label || !key) return false;
  if (label === key) return true;
  if (key.length >= 5 && label.startsWith(key) && label.length - key.length <= 4) return true;
  return label.length >= 5 && key.startsWith(label) && key.length - label.length <= 6;
}

/** The organisation label of a sender that could be an employer: not an ATS, not a free mail provider. */
export function employerLabel(address: string): string {
  const domain = addressDomain(address);
  if (!domain || isPersonalMailDomain(domain) || isKnownRecruitingHost(domain)) return "";
  return registrableLabel(domain);
}

/** The Workday tenant a Workday sender writes for (`acme` for `acme@otp.workday.com`). */
export function workdaySenderTenant(address: string): string {
  return knownSender(address)?.ats === "workday" ? addressLocalPart(address) : "";
}

export type NameHit = { matched: string; form: "full" | "short" };

/**
 * Finds the company named in `text`. In free text a one-word name must be
 * capitalised, so "we will anchor the review" is not Anchor, Inc. Pass the text
 * already lower-cased when checking it against many companies.
 */
export function findCompanyName(
  text: string,
  company: CompanyIdentity,
  requireCapital: boolean,
  lowered: string = text.toLowerCase(),
): NameHit | null {
  if (!company.probes.some((probe) => lowered.includes(probe))) return null;
  for (const [pattern, form] of [[company.full, "full"], [company.short, "short"]] as const) {
    if (!pattern) continue;
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const matched = match[0];
      const capitalised = /^[A-Z0-9]/.test(matched);
      if (requireCapital && (company.singleWord || form === "short") && !capitalised) continue;
      return { matched, form };
    }
  }
  return null;
}
