import { beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "../src/config/load.js";
import { listOutcomes } from "../src/db/repositories/applications.js";
import { listEvents } from "../src/db/repositories/events.js";
import { getFollowup, listFollowups } from "../src/db/repositories/followups.js";
import { insertInboxMessage } from "../src/db/repositories/inbox.js";
import { followUpsDue, markFollowUp } from "../src/followup/cadence.js";
import { closeStaleApplications } from "../src/followup/stale.js";
import { advancesApplication, summarizeOutcomes } from "../src/followup/stages.js";
import { makeWorkspace, seedApplication, seedOutcome } from "./afterApplyFixtures.js";

let workspace: Workspace;
const at = (iso: string) => new Date(iso);

beforeEach(() => {
  workspace = makeWorkspace();
});

describe("reading an outcome history", () => {
  it("counts stages cumulatively and keeps the first time each was reached", () => {
    const summary = summarizeOutcomes([
      { status: "acknowledged", notedAt: "2026-09-02T00:00:00Z" },
      { status: "interview", notedAt: "2026-09-10T00:00:00Z" },
      { status: "rejected", notedAt: "2026-09-20T00:00:00Z" },
    ]);
    expect(summary).toMatchObject({ furthestStage: "interview", furthestRank: 4, terminal: "rejected", responded: true, respondedBeyondAcknowledgement: true });
    expect(summary.firstAt.interview).toBe("2026-09-10T00:00:00Z");
  });

  it("reopens a ghosted application on any reply, a rejected one only on a real step forward", () => {
    expect(summarizeOutcomes([{ status: "ghosted", notedAt: "2026-09-01" }, { status: "acknowledged", notedAt: "2026-09-02" }]).terminal).toBeNull();
    expect(summarizeOutcomes([{ status: "rejected", notedAt: "2026-09-01" }, { status: "acknowledged", notedAt: "2026-09-02" }]).terminal).toBe("rejected");
    expect(summarizeOutcomes([{ status: "rejected", notedAt: "2026-09-01" }, { status: "recruiter_screen", notedAt: "2026-09-02" }]).terminal).toBeNull();
  });

  it("only lets a step forward or an ending be recorded without a person", () => {
    const atInterview = summarizeOutcomes([{ status: "interview", notedAt: "2026-09-01" }]);
    expect(advancesApplication("acknowledged", atInterview)).toMatchObject({ advances: false });
    expect(advancesApplication("interview", atInterview)).toMatchObject({ advances: false, reason: "already at interview" });
    expect(advancesApplication("offer", atInterview).advances).toBe(true);
    expect(advancesApplication("rejected", atInterview).advances).toBe(true);
    const rejected = summarizeOutcomes([{ status: "rejected", notedAt: "2026-09-01" }]);
    expect(advancesApplication("rejected", rejected)).toMatchObject({ advances: false });
    const ghosted = summarizeOutcomes([{ status: "ghosted", notedAt: "2026-09-01" }]);
    expect(advancesApplication("rejected", ghosted).advances).toBe(true);
  });
});

describe("follow-up cadence", () => {
  it("lists the first follow-up once it falls due, with a draft and no invented contact", () => {
    seedApplication(workspace.db, { id: "app_a", company: "Acme", title: "Staff Engineer", submittedAt: "2026-09-01T12:00:00.000Z" });
    seedApplication(workspace.db, { id: "app_b", company: "Globex", title: "Platform Engineer", submittedAt: "2026-09-05T12:00:00.000Z" });
    const plan = followUpsDue(workspace, { now: at("2026-09-09T12:00:00Z") });
    expect(plan.due).toHaveLength(1);
    expect(plan.due[0]).toMatchObject({
      applicationId: "app_a",
      kind: "first",
      dueDate: "2026-09-08",
      daysSinceSubmission: 8,
      overdueDays: 1,
      channel: { channel: "none", detail: "no contact on file" },
    });
    expect(plan.due[0]?.draft).toContain("Staff Engineer role at Acme on 2026-09-01");
    expect(plan.due[0]?.draft).toContain("Alex Candidate");
    expect(plan.due[0]?.suggestion).toContain("No contact is on file");
    expect(plan.upcoming).toEqual([{ applicationId: "app_b", company: "Globex", title: "Platform Engineer", kind: "first", dueDate: "2026-09-12" }]);
  });

  it("seeds reminder rows for every stage", () => {
    seedApplication(workspace.db, { id: "app_a", company: "Acme", title: "Staff Engineer", submittedAt: "2026-09-01T12:00:00.000Z" });
    followUpsDue(workspace, { now: at("2026-09-02T12:00:00Z") });
    expect(listFollowups(workspace.db).map((row) => [row.kind, row.dueAt])).toEqual([
      ["first", "2026-09-08T12:00:00.000Z"],
      ["second", "2026-09-15T12:00:00.000Z"],
      ["close", "2026-10-16T12:00:00.000Z"],
    ]);
  });

  it("leaves out applications that heard back, closed, or have a reply waiting for review", () => {
    seedApplication(workspace.db, { id: "app_ack", company: "Acme", title: "Engineer", submittedAt: "2026-09-01T00:00:00.000Z" });
    seedOutcome(workspace.db, "app_ack", "acknowledged", "2026-09-01T01:00:00.000Z");
    seedApplication(workspace.db, { id: "app_screen", company: "Globex", title: "Engineer", submittedAt: "2026-09-01T00:00:00.000Z" });
    seedOutcome(workspace.db, "app_screen", "recruiter_screen", "2026-09-03T00:00:00.000Z");
    seedApplication(workspace.db, { id: "app_rejected", company: "Initech", title: "Engineer", submittedAt: "2026-09-01T00:00:00.000Z" });
    seedOutcome(workspace.db, "app_rejected", "rejected", "2026-09-04T00:00:00.000Z");
    seedApplication(workspace.db, { id: "app_pending", company: "Umbrella", title: "Engineer", submittedAt: "2026-09-01T00:00:00.000Z" });
    insertInboxMessage(workspace.db, {
      id: "reply_1",
      messageId: "<m1@example.com>",
      mailbox: "INBOX",
      uid: 1,
      receivedAt: "2026-09-05T00:00:00.000Z",
      fromAddress: "talent@umbrella.example",
      fromName: "",
      subject: "Interview",
      snippet: "",
      matchedApplicationId: "app_pending",
      matchConfidence: 0.9,
      classification: "interview",
      classConfidence: 0.9,
      evidence: {},
      status: "proposed",
      processedAt: null,
      createdAt: "2026-09-05T00:00:00.000Z",
    });
    const plan = followUpsDue(workspace, { now: at("2026-09-10T00:00:00Z") });
    expect(plan.due.map((entry) => entry.applicationId)).toEqual(["app_ack"]);
    expect(plan.excluded).toEqual({ "employer replied": 1, "closed as rejected": 1, "a reply is awaiting review": 1 });
  });

  it("moves to the second follow-up once the first is done, keeping the gap between them", () => {
    seedApplication(workspace.db, { id: "app_a", company: "Acme", title: "Staff Engineer", submittedAt: "2026-09-01T12:00:00.000Z" });
    const marked = markFollowUp(workspace, { applicationId: "app_a", kind: "first", action: "done", now: at("2026-09-10T12:00:00Z") });
    expect(marked.record.doneAt).toBe("2026-09-10T12:00:00.000Z");
    // Second is planned for day 14 (09-15) but never sooner than 7 days after the first was sent.
    expect(marked.next).toEqual({ kind: "second", dueDate: "2026-09-17" });
    expect(followUpsDue(workspace, { now: at("2026-09-16T12:00:00Z") }).due).toEqual([]);
    expect(followUpsDue(workspace, { now: at("2026-09-17T13:00:00Z") }).due[0]).toMatchObject({ kind: "second" });
    expect(listEvents(workspace.db, "followup.done")).toHaveLength(1);
  });

  it("hides a snoozed follow-up until the snooze ends", () => {
    seedApplication(workspace.db, { id: "app_a", company: "Acme", title: "Staff Engineer", submittedAt: "2026-09-01T12:00:00.000Z" });
    const marked = markFollowUp(workspace, { applicationId: "app_a", kind: "first", action: "snooze", days: 3, now: at("2026-09-09T12:00:00Z") });
    expect(marked.record.snoozedUntil).toBe("2026-09-12T12:00:00.000Z");
    expect(marked.next).toEqual({ kind: "first", dueDate: "2026-09-12" });
    expect(followUpsDue(workspace, { now: at("2026-09-11T12:00:00Z") }).due).toEqual([]);
    expect(followUpsDue(workspace, { now: at("2026-09-12T13:00:00Z") }).due).toHaveLength(1);
  });

  it("resolves a skipped follow-up without counting it as contact", () => {
    seedApplication(workspace.db, { id: "app_a", company: "Acme", title: "Staff Engineer", submittedAt: "2026-09-01T12:00:00.000Z" });
    const marked = markFollowUp(workspace, { applicationId: "app_a", kind: "first", action: "skip", now: at("2026-09-10T12:00:00Z") });
    expect(marked.record).toMatchObject({ doneAt: "2026-09-10T12:00:00.000Z", skipped: true });
    // Nothing went out, so the second keeps its planned day 14 instead of waiting a week after the skip.
    expect(marked.next).toEqual({ kind: "second", dueDate: "2026-09-15" });
    expect(listEvents(workspace.db, "followup.skipped")).toHaveLength(1);
    expect(listEvents(workspace.db, "followup.done")).toHaveLength(0);

    markFollowUp(workspace, { applicationId: "app_a", kind: "second", action: "skip", now: at("2026-09-15T12:00:00Z") });
    // With nothing sent, closing waits only for the planned day 45, not a grace period after the skips.
    expect(followUpsDue(workspace, { now: at("2026-10-16T13:00:00Z") }).due[0]).toMatchObject({ kind: "close" });
  });

  it("turns a skip back into a sent follow-up when it is later marked done", () => {
    seedApplication(workspace.db, { id: "app_a", company: "Acme", title: "Staff Engineer", submittedAt: "2026-09-01T12:00:00.000Z" });
    markFollowUp(workspace, { applicationId: "app_a", kind: "first", action: "skip", now: at("2026-09-09T12:00:00Z") });
    const marked = markFollowUp(workspace, { applicationId: "app_a", kind: "first", action: "done", now: at("2026-09-10T12:00:00Z") });
    expect(marked.record).toMatchObject({ doneAt: "2026-09-10T12:00:00.000Z", skipped: false });
    expect(marked.next).toEqual({ kind: "second", dueDate: "2026-09-17" });
  });

  it("suggests closing once both follow-ups are done and the silence continues", () => {
    seedApplication(workspace.db, { id: "app_a", company: "Acme", title: "Staff Engineer", submittedAt: "2026-07-01T12:00:00.000Z" });
    markFollowUp(workspace, { applicationId: "app_a", kind: "first", action: "done", now: at("2026-07-08T12:00:00Z") });
    markFollowUp(workspace, { applicationId: "app_a", kind: "second", action: "done", now: at("2026-07-15T12:00:00Z") });
    const plan = followUpsDue(workspace, { now: at("2026-08-20T12:00:00Z") });
    expect(plan.due[0]).toMatchObject({ kind: "close", draft: "" });
    expect(plan.due[0]?.suggestion).toContain("close_stale_applications");
  });

  it("suggests closing, not a first follow-up, once the close date has passed without any follow-up", () => {
    seedApplication(workspace.db, { id: "app_old", company: "Acme", title: "Staff Engineer", submittedAt: "2026-07-01T12:00:00.000Z" });
    seedApplication(workspace.db, { id: "app_recent", company: "Globex", title: "Platform Engineer", submittedAt: "2026-09-20T12:00:00.000Z" });
    const now = at("2026-10-07T12:00:00Z");

    const plan = followUpsDue(workspace, { now });

    expect(plan.due.find((entry) => entry.applicationId === "app_old")).toMatchObject({ kind: "close", draft: "", dueDate: "2026-08-15" });
    expect(plan.due.find((entry) => entry.applicationId === "app_recent")).toMatchObject({ kind: "first" });
    // The follow-up list and the stale closer agree on what is stale.
    expect(closeStaleApplications(workspace, { now }).closed.map((entry) => entry.applicationId)).toEqual(["app_old"]);
  });

  it("holds a stale application back while any of its reminders is snoozed", () => {
    seedApplication(workspace.db, { id: "app_old", company: "Acme", title: "Staff Engineer", submittedAt: "2026-07-01T12:00:00.000Z" });
    markFollowUp(workspace, { applicationId: "app_old", kind: "first", action: "snooze", days: 5, now: at("2026-10-05T12:00:00Z") });

    const plan = followUpsDue(workspace, { now: at("2026-10-07T12:00:00Z"), horizonDays: 7 });

    expect(plan.due).toEqual([]);
    expect(plan.upcoming).toEqual([expect.objectContaining({ applicationId: "app_old", kind: "close", dueDate: "2026-10-10" })]);
  });

  it("greets the contact the lookup hook supplies", () => {
    seedApplication(workspace.db, { id: "app_a", company: "Acme", title: "Staff Engineer", submittedAt: "2026-09-01T12:00:00.000Z" });
    const plan = followUpsDue(workspace, {
      now: at("2026-09-09T12:00:00Z"),
      contactLookup: () => ({ channel: "email", detail: "recruiter@acme.example", name: "Jordan" }),
    });
    expect(plan.due[0]?.channel).toMatchObject({ channel: "email" });
    expect(plan.due[0]?.draft.startsWith("Hi Jordan,")).toBe(true);
  });

  it("does nothing when follow-ups are turned off", () => {
    workspace = makeWorkspace({ campaign: { followUps: { enabled: false } } });
    seedApplication(workspace.db, { id: "app_a", company: "Acme", title: "Staff Engineer", submittedAt: "2026-09-01T12:00:00.000Z" });
    const plan = followUpsDue(workspace, { now: at("2026-10-01T00:00:00Z") });
    expect(plan).toMatchObject({ enabled: false, due: [], upcoming: [] });
    expect(getFollowup(workspace.db, "app_a", "first")).toBeNull();
  });

  it("refuses to mark a follow-up on an application that was never submitted", () => {
    seedApplication(workspace.db, { id: "app_draft", company: "Acme", title: "Engineer", status: "drafted", submittedAt: null });
    expect(() => markFollowUp(workspace, { applicationId: "app_draft", kind: "first", action: "done" })).toThrow(/no submitted application/);
  });
});

describe("closing stale applications", () => {
  beforeEach(() => {
    seedApplication(workspace.db, { id: "app_silent", company: "Acme", title: "Engineer", submittedAt: "2026-07-01T00:00:00.000Z" });
    seedApplication(workspace.db, { id: "app_acked", company: "Globex", title: "Engineer", submittedAt: "2026-07-01T00:00:00.000Z" });
    seedOutcome(workspace.db, "app_acked", "acknowledged", "2026-07-01T01:00:00.000Z");
    seedApplication(workspace.db, { id: "app_screen", company: "Initech", title: "Engineer", submittedAt: "2026-07-01T00:00:00.000Z" });
    seedOutcome(workspace.db, "app_screen", "recruiter_screen", "2026-07-05T00:00:00.000Z");
    seedApplication(workspace.db, { id: "app_recent", company: "Umbrella", title: "Engineer", submittedAt: "2026-08-20T00:00:00.000Z" });
    seedApplication(workspace.db, { id: "app_nudged", company: "Hooli", title: "Engineer", submittedAt: "2026-07-01T00:00:00.000Z" });
  });

  it("finds applications silent past ghostAfterDays and records nothing on a dry run", () => {
    markFollowUp(workspace, { applicationId: "app_nudged", kind: "second", action: "done", now: at("2026-08-30T00:00:00Z") });
    const result = closeStaleApplications(workspace, { now: at("2026-09-01T00:00:00Z") });
    expect(result.dryRun).toBe(true);
    expect(result.closed.map((entry) => entry.applicationId).sort()).toEqual(["app_acked", "app_silent"]);
    expect(result.closed.find((entry) => entry.applicationId === "app_silent")?.silentDays).toBe(62);
    expect(result.skipped).toEqual([{ applicationId: "app_screen", company: "Initech", title: "Engineer", reason: "employer replied (recruiter_screen)" }]);
    expect(listOutcomes(workspace.db, "app_silent")).toEqual([]);
  });

  it("records ghosted, tagged as an automatic closure, and does not close twice", () => {
    const result = closeStaleApplications(workspace, { dryRun: false, now: at("2026-09-01T00:00:00Z") });
    expect(result.closed).toHaveLength(3);
    const [ghosted] = listOutcomes(workspace.db, "app_silent");
    expect(ghosted).toMatchObject({ status: "ghosted" });
    expect(ghosted?.detail).toBe("no response in 62 days since 2026-07-01 (auto-closed 2026-09-01)");
    expect(listEvents(workspace.db, "outcome.auto_closed")).toHaveLength(3);
    expect(closeStaleApplications(workspace, { dryRun: false, now: at("2026-09-02T00:00:00Z") }).closed).toEqual([]);
  });

  it("leaves a snoozed application open", () => {
    markFollowUp(workspace, { applicationId: "app_silent", kind: "close", action: "snooze", days: 10, now: at("2026-08-31T00:00:00Z") });
    const result = closeStaleApplications(workspace, { now: at("2026-09-01T00:00:00Z") });
    expect(result.closed.map((entry) => entry.applicationId)).not.toContain("app_silent");
    expect(result.skipped).toContainEqual({ applicationId: "app_silent", company: "Acme", title: "Engineer", reason: "snoozed until 2026-09-10" });
  });
});
