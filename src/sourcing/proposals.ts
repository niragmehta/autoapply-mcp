import type { Workspace } from "../config/load.js";
import { readCompanyFile, upsertCompany } from "../config/companies.js";
import { AtsKindSchema, CompanySchema, type AtsKind, type Company } from "../domain/campaign.js";
import { appendEvent } from "../db/repositories/events.js";
import { markHarvestedTracked } from "../db/repositories/harvest.js";
import { listLeads, markLeadsChecked, markLeadsResolved, type Lead } from "../db/repositories/leads.js";
import { boardFromUrl } from "../sources/boardLinks.js";
import { resolveBoards, verifyBoard } from "../sources/registry.js";
import type { BoardVerification } from "../sources/types.js";
import { toErrorMessage } from "../util/errors.js";
import { companyKey } from "./fundedParse.js";

/**
 * Turning leads into boards.
 *
 * Every lead source names companies; only a verified ATS board lets the
 * pipeline read their postings. This proposes boards for companies seen in
 * leads but absent from companies.json, each one verified to serve postings,
 * and saves them only when the candidate accepts. Companies with no findable
 * board are remembered for a while so they are not probed on every run.
 */

export type RegistryDeps = {
  resolveBoards: (companyName: string) => Promise<Array<{ ats: AtsKind; board: string; ok: boolean }>>;
  verifyBoard: (company: Company) => Promise<BoardVerification>;
};

const REGISTRY: RegistryDeps = { resolveBoards: (name) => resolveBoards(name), verifyBoard };

export type ProposedBoard = { ats: AtsKind; board: string; region: "global" | "eu"; postings: number; sampleTitles: string[] };

export type CompanyProposal = {
  company: string;
  leadIds: string[];
  sources: string[];
  boards: ProposedBoard[];
};

export type ProposalResult = {
  proposals: CompanyProposal[];
  unresolved: Array<{ company: string; leadIds: string[] }>;
  skipped: { alreadyTracked: number; excluded: number; recentlyChecked: number };
  remaining: number;
};

export type ProposeOptions = {
  limit?: number;
  /** Companies with no board found are not probed again for this many days. */
  recheckAfterDays?: number;
  now?: Date;
  signal?: AbortSignal;
};

type Group = { key: string; company: string; leads: Lead[] };

function groupLeads(leads: readonly Lead[]): Group[] {
  const groups = new Map<string, Group>();
  for (const lead of leads) {
    const key = companyKey(lead.company);
    if (!key) continue;
    const group = groups.get(key) ?? { key, company: lead.company.trim(), leads: [] };
    group.leads.push(lead);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.leads.length - a.leads.length || a.company.localeCompare(b.company));
}

const boardKey = (ats: string, board: string) => `${ats}:${board.toLowerCase()}`;

/** Boards a lead already points at: a harvested board, or an ATS posting URL. */
function hintedBoards(group: Group): Array<{ ats: AtsKind; board: string; region: "global" | "eu" }> {
  const hints: Array<{ ats: AtsKind; board: string; region: "global" | "eu" }> = [];
  for (const lead of group.leads) {
    const ats = AtsKindSchema.safeParse(lead.details.ats);
    if (ats.success && typeof lead.details.board === "string") {
      hints.push({ ats: ats.data, board: lead.details.board, region: lead.details.region === "eu" ? "eu" : "global" });
    }
    for (const url of [lead.applyUrl, lead.url]) {
      const link = url ? boardFromUrl(url) : null;
      if (link) hints.push({ ats: link.ats, board: link.board, region: link.region });
    }
  }
  return hints;
}

function excludedKeys(workspace: Pick<Workspace, "campaign">): Set<string> {
  const names = [
    ...workspace.campaign.exclusions.companies,
    ...workspace.campaign.hygiene.blacklist.filter((entry) => entry.scope === "company").map((entry) => entry.value),
  ];
  return new Set(names.map(companyKey).filter(Boolean));
}

/** Proposes verified boards for companies seen in leads but not yet in companies.json. Writes nothing to companies.json. */
export async function proposeCompanies(
  workspace: Pick<Workspace, "db" | "companies" | "campaign">,
  options: ProposeOptions = {},
  deps: RegistryDeps = REGISTRY,
): Promise<ProposalResult> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 5), 1), 25);
  const now = options.now ?? new Date();
  const recheckBefore = now.getTime() - (options.recheckAfterDays ?? 14) * 86_400_000;
  const trackedNames = new Set(workspace.companies.map((company) => companyKey(company.name)));
  const trackedBoards = new Set(workspace.companies.map((company) => boardKey(company.ats, company.board)));
  const excluded = excludedKeys(workspace);

  const result: ProposalResult = { proposals: [], unresolved: [], skipped: { alreadyTracked: 0, excluded: 0, recentlyChecked: 0 }, remaining: 0 };
  const due: Group[] = [];
  for (const group of groupLeads(listLeads(workspace.db, { status: "new", limit: 5000 }))) {
    const hinted = hintedBoards(group);
    if (trackedNames.has(group.key) || hinted.some((hint) => trackedBoards.has(boardKey(hint.ats, hint.board)))) {
      result.skipped.alreadyTracked += 1;
      markLeadsResolved(workspace.db, group.leads.map((lead) => lead.id), "already-tracked");
    } else if (excluded.has(group.key)) {
      result.skipped.excluded += 1;
    } else if (group.leads.every((lead) => lead.checkedAt && Date.parse(lead.checkedAt) > recheckBefore)) {
      result.skipped.recentlyChecked += 1;
    } else {
      due.push(group);
    }
  }

  for (const [index, group] of due.entries()) {
    if (index >= limit || options.signal?.aborted) {
      result.remaining = due.length - index;
      break;
    }
    const leadIds = group.leads.map((lead) => lead.id);
    const hinted = hintedBoards(group);
    const candidates = hinted.length > 0
      ? hinted
      : (await deps.resolveBoards(group.company).catch(() => []))
          .filter((candidate) => candidate.ok)
          .map((candidate) => ({ ats: candidate.ats, board: candidate.board, region: "global" as const }));
    const unique = [...new Map(candidates.map((candidate) => [boardKey(candidate.ats, candidate.board), candidate])).values()]
      .filter((candidate) => !trackedBoards.has(boardKey(candidate.ats, candidate.board)))
      .slice(0, 4);

    const boards: ProposedBoard[] = [];
    for (const candidate of unique) {
      const parsed = CompanySchema.safeParse({ name: group.company, ...candidate });
      if (!parsed.success) continue;
      const check = await deps.verifyBoard(parsed.data).catch((error: unknown) => ({ ok: false, postings: 0, sampleTitles: [], detail: toErrorMessage(error) }));
      if (check.ok) boards.push({ ...candidate, postings: check.postings, sampleTitles: check.sampleTitles.slice(0, 3) });
    }

    if (boards.length > 0) {
      result.proposals.push({
        company: group.company,
        leadIds,
        sources: [...new Set(group.leads.map((lead) => lead.source))],
        boards: boards.sort((a, b) => b.postings - a.postings),
      });
    } else {
      result.unresolved.push({ company: group.company, leadIds });
      markLeadsChecked(workspace.db, leadIds, `no verified public board found (${now.toISOString().slice(0, 10)})`, now.toISOString());
    }
  }
  return result;
}

export type AcceptInput = { company: string; ats: AtsKind; board: string; region?: "global" | "eu"; tier?: "A" | "B" | "C" };

export type AcceptResult = {
  saved: Array<{ company: string; ats: AtsKind; board: string; postings: number; action: "added" | "updated" }>;
  rejected: Array<{ company: string; ats: string; board: string; reason: string }>;
};

/**
 * Saves proposals the candidate accepted. Each board is verified again before
 * it is written - the proposal travelled through an agent and could have been
 * altered - and an existing company entry is never replaced.
 */
export async function acceptCompanyProposals(
  workspace: Pick<Workspace, "db" | "paths">,
  proposals: readonly AcceptInput[],
  deps: Pick<RegistryDeps, "verifyBoard"> = REGISTRY,
): Promise<AcceptResult> {
  const result: AcceptResult = { saved: [], rejected: [] };
  for (const proposal of proposals) {
    const parsed = CompanySchema.safeParse({
      name: proposal.company,
      ats: proposal.ats,
      board: proposal.board,
      region: proposal.region ?? "global",
      tier: proposal.tier ?? "C",
      tags: ["proposed"],
    });
    if (!parsed.success) {
      result.rejected.push({ company: proposal.company, ats: String(proposal.ats), board: proposal.board, reason: "not a valid company entry" });
      continue;
    }
    const company = parsed.data;
    const existing = readCompanyFile(workspace.paths.companies);
    if (existing.some((entry) => companyKey(entry.name) === companyKey(company.name))) {
      result.rejected.push({ company: company.name, ats: company.ats, board: company.board, reason: "already in companies.json; edit that entry by hand to change its board" });
      continue;
    }
    const check = await deps.verifyBoard(company);
    if (!check.ok) {
      result.rejected.push({ company: company.name, ats: company.ats, board: company.board, reason: check.detail });
      continue;
    }
    const written = upsertCompany(workspace.paths.companies, company);
    const key = companyKey(company.name);
    const leadIds = listLeads(workspace.db, { status: "new", limit: 5000 })
      .filter((lead) => companyKey(lead.company) === key)
      .map((lead) => lead.id);
    markLeadsResolved(workspace.db, leadIds, `${company.ats}:${company.board}`);
    markHarvestedTracked(workspace.db, company.ats, company.board);
    appendEvent(workspace.db, "board.added", "campaign", { company: company.name, ats: company.ats, board: company.board, source: "proposal" });
    result.saved.push({ company: company.name, ats: company.ats, board: company.board, postings: check.postings, action: written.action });
  }
  return result;
}
