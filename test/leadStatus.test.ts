import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "../src/config/load.js";
import { listEvents } from "../src/db/repositories/events.js";
import { listLeads, upsertLeads } from "../src/db/repositories/leads.js";
import { setLeadsStatus } from "../src/sourcing/leadStatus.js";
import { makeWorkspace } from "./afterApplyFixtures.js";

let workspace: Workspace;

beforeEach(() => {
  workspace = makeWorkspace();
  upsertLeads(workspace.db, [
    { source: "funded", sourceId: "acme", company: "Acme Robotics", title: "Series B" },
    { source: "funded", sourceId: "globex", company: "Globex", title: "Seed" },
  ]);
});

afterEach(() => {
  workspace.db.close();
});

const idOf = (company: string) => listLeads(workspace.db).find((lead) => lead.company === company)!.id;

describe("setting leads aside", () => {
  it("ignores the named leads, reports unknown ids, and logs the change", () => {
    const result = setLeadsStatus(workspace, { ids: [idOf("Acme Robotics"), "lead_missing"], status: "ignored" });

    expect(result).toEqual({ status: "ignored", updated: 1, missing: ["lead_missing"] });
    expect(listLeads(workspace.db, { status: "ignored" }).map((lead) => lead.company)).toEqual(["Acme Robotics"]);
    expect(listLeads(workspace.db, { status: "new" }).map((lead) => lead.company)).toEqual(["Globex"]);
    expect(listEvents(workspace.db, "leads.status")).toHaveLength(1);
  });

  it("puts an ignored lead back to new", () => {
    setLeadsStatus(workspace, { ids: [idOf("Globex")], status: "ignored" });

    expect(setLeadsStatus(workspace, { ids: [idOf("Globex")], status: "new" })).toMatchObject({ updated: 1, missing: [] });
    expect(listLeads(workspace.db, { status: "new" })).toHaveLength(2);
  });

  it("never reopens a lead whose board was already accepted", () => {
    workspace.db.prepare("UPDATE leads SET status = 'resolved' WHERE id = ?").run(idOf("Acme Robotics"));

    expect(setLeadsStatus(workspace, { ids: [idOf("Acme Robotics")], status: "ignored" })).toMatchObject({ updated: 0 });
    expect(listLeads(workspace.db, { status: "resolved" })).toHaveLength(1);
  });

  it("rejects an empty or oversized request", () => {
    expect(() => setLeadsStatus(workspace, { ids: [], status: "ignored" })).toThrow(/at least one lead/);
    expect(() => setLeadsStatus(workspace, { ids: Array.from({ length: 501 }, (_, index) => `lead_${index}`), status: "ignored" })).toThrow(/at most 500/);
  });
});
