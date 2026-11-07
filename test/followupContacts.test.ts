import { beforeEach, describe, expect, it } from "vitest";
import { saveContact } from "../src/career/contacts.js";
import type { Workspace } from "../src/config/load.js";
import { followUpsDue } from "../src/followup/cadence.js";
import { careerContactLookup } from "../src/followup/contacts.js";
import { makeWorkspace, seedApplication } from "./afterApplyFixtures.js";

let workspace: Workspace;
const now = new Date("2026-09-09T12:00:00Z");

beforeEach(() => {
  workspace = makeWorkspace();
  seedApplication(workspace.db, { id: "app_a", company: "Acme", title: "Staff Engineer", submittedAt: "2026-09-01T12:00:00.000Z" });
});

describe("follow-up contacts from the career suite", () => {
  it("addresses a due follow-up to the recruiter on file, by first name", () => {
    saveContact(workspace, { company: "Acme", name: "Jordan Example", role: "Technical Recruiter", kind: "recruiter", email: "jordan@example.com", source: "https://example.com/team" });

    const plan = followUpsDue(workspace, { now, contactLookup: careerContactLookup(workspace.db) });

    expect(plan.due[0]?.channel).toEqual({ channel: "email", detail: "Jordan Example, Technical Recruiter <jordan@example.com>", name: "Jordan" });
    expect(plan.due[0]?.draft).toContain("Hi Jordan,");
  });

  it("falls back to a profile link when no email is known", () => {
    saveContact(workspace, { company: "Acme", name: "Riley Example", kind: "hiring_manager", profileUrl: "https://www.linkedin.com/in/riley-example", source: "https://example.com/talk" });

    const channel = careerContactLookup(workspace.db)({ applicationId: "app_a", company: "Acme", title: "Staff Engineer" });

    expect(channel).toEqual({ channel: "linkedin_message", detail: "Riley Example: https://www.linkedin.com/in/riley-example", name: "Riley" });
  });

  it("never sends a status follow-up to a peer, or to a contact with no way to reach them", () => {
    saveContact(workspace, { company: "Acme", name: "Casey Peer", kind: "peer", email: "casey@example.com", source: "https://example.com/blog" });
    saveContact(workspace, { company: "Acme", name: "Quinn Unreachable", kind: "recruiter", source: "https://example.com/team" });

    const plan = followUpsDue(workspace, { now, contactLookup: careerContactLookup(workspace.db) });

    expect(plan.due[0]?.channel).toEqual({ channel: "none", detail: "no contact on file" });
  });

  it("reports no contact rather than failing when the application is unknown", () => {
    expect(careerContactLookup(workspace.db)({ applicationId: "app_missing", company: "Acme", title: "x" })).toBeNull();
  });
});
