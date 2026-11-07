import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspacePaths } from "../src/config/paths.js";
import { CompanySchema, type Company } from "../src/domain/campaign.js";
import { openDatabase, type Db } from "../src/db/database.js";
import { listEvents } from "../src/db/repositories/events.js";
import { listLeads, upsertLeads } from "../src/db/repositories/leads.js";
import { acceptCompanyProposals, proposeCompanies, type RegistryDeps } from "../src/sourcing/proposals.js";
import type { BoardVerification } from "../src/sources/types.js";
import { makeCampaign } from "./factories.js";

/** The ATS registry is stubbed: no network. Companies are fictional. */

let db: Db;
let home: string;
const NOW = new Date("2026-11-06T12:00:00Z");

const tracked: Company[] = [CompanySchema.parse({ name: "Tracked Co", ats: "lever", board: "trackedco" })];

function paths(): Pick<WorkspacePaths, "companies"> {
  return { companies: join(home, "companies.json") };
}

beforeEach(() => {
  db = openDatabase(":memory:");
  home = mkdtempSync(join(tmpdir(), "autoapply-proposals-"));
  writeFileSync(join(home, "companies.json"), JSON.stringify({ version: 1, companies: tracked }));
  upsertLeads(db, [
    { source: "linkedin-alert", sourceId: "4012345678", title: "Senior Platform Engineer", company: "Acme Robotics" },
    { source: "linkedin-alert", sourceId: "4012345679", title: "Staff Engineer", company: "Acme Robotics" },
    { source: "funded", sourceId: "globexanalytics", title: "Globex Analytics raises $12M", company: "Globex Analytics" },
    { source: "linkedin-alert", sourceId: "4034567890", title: "Backend Developer", company: "Initech", applyUrl: "https://job-boards.greenhouse.io/initech/jobs/123" },
    { source: "funded", sourceId: "trackedco", title: "Tracked Co raises $5M", company: "Tracked Co" },
    { source: "funded", sourceId: "vandelay", title: "Vandelay raises $9M", company: "Vandelay Industries" },
    { source: "linkedin-alert", sourceId: "4045678901", title: "Engineer", company: "" },
  ]);
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

function registry(): RegistryDeps & { resolved: string[]; verified: string[] } {
  const resolved: string[] = [];
  const verified: string[] = [];
  const verifications: Record<string, BoardVerification> = {
    "greenhouse:acmerobotics": { ok: true, postings: 12, sampleTitles: ["Senior Platform Engineer", "Staff Engineer", "SRE", "PM"], detail: "board returned postings" },
    "greenhouse:initech": { ok: true, postings: 3, sampleTitles: ["Backend Developer"], detail: "board returned postings" },
  };
  return {
    resolved,
    verified,
    resolveBoards: async (name) => {
      resolved.push(name);
      return name === "Acme Robotics"
        ? [
            { ats: "greenhouse", board: "acmerobotics", ok: true },
            { ats: "lever", board: "acme-robotics", ok: true },
            { ats: "ashby", board: "acmerobotics", ok: false },
          ]
        : [];
    },
    verifyBoard: async (company) => {
      verified.push(`${company.ats}:${company.board}`);
      return verifications[`${company.ats}:${company.board}`] ?? { ok: false, postings: 0, sampleTitles: [], detail: "board responded but published no postings" };
    },
  };
}

const workspace = () => ({ db, companies: tracked, campaign: makeCampaign({ exclusions: { companies: ["Vandelay Industries"] } }) });

describe("proposeCompanies", () => {
  it("proposes verified boards for untracked companies and remembers dead ends", async () => {
    const deps = registry();
    const result = await proposeCompanies(workspace(), { now: NOW }, deps);

    expect(result.proposals).toEqual([
      {
        company: "Acme Robotics",
        leadIds: expect.any(Array),
        sources: ["linkedin-alert"],
        boards: [{ ats: "greenhouse", board: "acmerobotics", region: "global", postings: 12, sampleTitles: ["Senior Platform Engineer", "Staff Engineer", "SRE"] }],
      },
      expect.objectContaining({ company: "Initech", boards: [expect.objectContaining({ ats: "greenhouse", board: "initech", postings: 3 })] }),
    ]);
    expect(result.proposals[0]!.leadIds).toHaveLength(2);
    // Initech's lead already named its board, so nothing was guessed for it.
    expect(deps.resolved).toEqual(["Acme Robotics", "Globex Analytics"]);
    expect(deps.verified).toEqual(["greenhouse:acmerobotics", "lever:acme-robotics", "greenhouse:initech"]);
    expect(result.unresolved).toEqual([{ company: "Globex Analytics", leadIds: [expect.any(String)] }]);
    expect(result.skipped).toEqual({ alreadyTracked: 1, excluded: 1, recentlyChecked: 0 });

    const leads = listLeads(db);
    expect(leads.find((lead) => lead.company === "Tracked Co")).toMatchObject({ status: "resolved", resolvedBoard: "already-tracked" });
    expect(leads.find((lead) => lead.company === "Globex Analytics")?.checkedAt).toBe(NOW.toISOString());
    expect(leads.find((lead) => lead.company === "Vandelay Industries")?.status).toBe("new");

    const again = await proposeCompanies(workspace(), { now: NOW }, registry());
    expect(again.skipped.recentlyChecked).toBe(1);
  });

  it("stops at the limit and reports what is left", async () => {
    const result = await proposeCompanies(workspace(), { now: NOW, limit: 1 }, registry());
    expect(result.proposals.map((proposal) => proposal.company)).toEqual(["Acme Robotics"]);
    expect(result.remaining).toBe(2);
  });
});

describe("acceptCompanyProposals", () => {
  it("re-verifies, saves with the proposed tag and resolves the leads", async () => {
    const deps = registry();
    const result = await acceptCompanyProposals({ db, paths: paths() as WorkspacePaths }, [
      { company: "Acme Robotics", ats: "greenhouse", board: "acmerobotics" },
      { company: "Globex Analytics", ats: "lever", board: "globex" },
      { company: "Tracked Co", ats: "greenhouse", board: "trackedco" },
    ], deps);

    expect(result.saved).toEqual([{ company: "Acme Robotics", ats: "greenhouse", board: "acmerobotics", postings: 12, action: "added" }]);
    expect(result.rejected).toEqual([
      { company: "Globex Analytics", ats: "lever", board: "globex", reason: "board responded but published no postings" },
      { company: "Tracked Co", ats: "greenhouse", board: "trackedco", reason: "already in companies.json; edit that entry by hand to change its board" },
    ]);
    const written = JSON.parse(readFileSync(paths().companies, "utf8")) as { companies: Array<Record<string, unknown>> };
    expect(written.companies).toHaveLength(2);
    expect(written.companies[1]).toMatchObject({ name: "Acme Robotics", ats: "greenhouse", board: "acmerobotics", tier: "C", tags: ["proposed"] });
    expect(written.companies[0]).toMatchObject({ name: "Tracked Co", board: "trackedco" });
    expect(listLeads(db).filter((lead) => lead.company === "Acme Robotics").every((lead) => lead.status === "resolved" && lead.resolvedBoard === "greenhouse:acmerobotics")).toBe(true);
    expect(listEvents(db, "board.added")).toHaveLength(1);
  });
});
