import type { Job } from "../domain/job.js";
import type { BlacklistEntry } from "../domain/policies/hygiene.js";

/**
 * The candidate's own do-not-apply list: matching. (Adding entries lives in
 * blacklistStore.ts, so the gates never depend on configuration I/O.)
 *
 * Nothing is ever added automatically: an entry is a decision the candidate
 * recorded, so a match is a hard gate. Company entries match the employer name
 * case-, accent- and punctuation-insensitively, ignoring legal-entity suffixes
 * ("Acme, Inc." is "acme"). Other words are kept, so "Acme Labs" is not
 * "Acme". Domain entries match the posting or apply URL's host or any
 * subdomain of it ("ibm.com" matches "jobs.ibm.com", never "notibm.com").
 */

const LEGAL_SUFFIXES = /\b(?:inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|plc|gmbh|ag|sa|bv|pty|llp|lp)\b\.?/g;

export function normalizeEmployerName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,]/g, " ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/[^a-z0-9]+/g, "");
}

/** Reduces "https://Jobs.Example.com/x", "*.example.com." and "example.com" to a bare host. */
export function normalizeDomain(value: string): string {
  let host = value.trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      return "";
    }
  }
  return host.replace(/^\*\./, "").split(/[/?#]/)[0]!.replace(/:\d+$/, "").replace(/\.$/, "");
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

export type BlacklistMatch = { entry: BlacklistEntry; matched: string };

/** The first entry that matches the posting, or null. */
export function matchBlacklist(
  job: Pick<Job, "companyName" | "url" | "applyUrl">,
  entries: readonly BlacklistEntry[],
): BlacklistMatch | null {
  if (entries.length === 0) return null;
  const company = normalizeEmployerName(job.companyName);
  const hosts = [job.url, job.applyUrl].map(hostOf).filter((host): host is string => host !== null);
  for (const entry of entries) {
    if (entry.scope === "company") {
      const wanted = normalizeEmployerName(entry.value);
      if (wanted.length > 0 && wanted === company) return { entry, matched: job.companyName };
      continue;
    }
    const domain = normalizeDomain(entry.value);
    if (domain.length === 0) continue;
    const host = hosts.find((candidate) => candidate === domain || candidate.endsWith(`.${domain}`));
    if (host) return { entry, matched: host };
  }
  return null;
}

/** Whether two entries record the same decision. */
export function sameBlacklistEntry(a: BlacklistEntry, b: BlacklistEntry): boolean {
  if (a.scope !== b.scope) return false;
  return a.scope === "company"
    ? normalizeEmployerName(a.value) === normalizeEmployerName(b.value)
    : normalizeDomain(a.value) === normalizeDomain(b.value);
}
