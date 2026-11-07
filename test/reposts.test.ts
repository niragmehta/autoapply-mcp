import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findRepostClusters, repostSignalFor, titleIdentity } from "../src/hygiene/reposts.js";
import { makeJob } from "./factories.js";
import { makeWorkspace, setSeen, storeJobs, type TestWorkspace } from "./hygieneFixtures.js";

describe("titleIdentity", () => {
  it("ignores order, punctuation, bracketed notes, requisition ids and workplace words", () => {
    const base = titleIdentity("Senior Software Engineer, Payments");
    expect(titleIdentity("Payments - Senior Software Engineer")).toBe(base);
    expect(titleIdentity("Senior Software Engineer, Payments (Remote - US)")).toBe(base);
    expect(titleIdentity("Senior Software Engineer, Payments [San Francisco]")).toBe(base);
    expect(titleIdentity("Senior Software Engineer, Payments - R123456")).toBe(base);
    expect(titleIdentity("Sr. Software Engineer - Payments | Job ID: 98765")).toBe(base);
    expect(titleIdentity("Senior Software Engineer, Payments - Hybrid")).toBe(base);
  });

  it("canonicalizes level numerals but never merges different levels", () => {
    expect(titleIdentity("Software Engineer II")).toBe(titleIdentity("Software Engineer 2"));
    expect(titleIdentity("Software Engineer II")).not.toBe(titleIdentity("Software Engineer III"));
    expect(titleIdentity("Software Engineer II")).not.toBe(titleIdentity("Software Engineer"));
  });

  it("keeps words that make a different requisition", () => {
    expect(titleIdentity("Solutions Engineer - Munich")).not.toBe(titleIdentity("Solutions Engineer - Berlin"));
    expect(titleIdentity("Senior Engineer")).not.toBe(titleIdentity("Staff Engineer"));
    expect(titleIdentity("C# Developer")).toContain("c#");
  });
});

describe("repost clusters", () => {
  let workspace: TestWorkspace;
  const now = new Date("2026-11-01T00:00:00.000Z");
  const posting = (id: string, title: string, board = "acme") =>
    makeJob({ id: `job_${id}`, externalId: id, fingerprint: `fp_${id}`, title, board, companyName: "Acme" });

  beforeEach(() => {
    workspace = makeWorkspace();
    storeJobs(workspace, [
      posting("1", "Senior Security Engineer"),
      posting("2", "Senior Security Engineer (Remote)"),
      posting("3", "Security Engineer, Senior"),
      posting("4", "Staff Security Engineer"),
      posting("5", "Platform Engineer"),
      posting("6", "Platform Engineer, Infra"),
      posting("7", "Senior Security Engineer", "acme-eu"),
      posting("8", "Data Engineer"),
      posting("9", "Data Engineer"),
    ]);
    setSeen(workspace, "job_1", "2026-08-01T10:00:00.000Z");
    setSeen(workspace, "job_2", "2026-09-15T10:00:00.000Z");
    setSeen(workspace, "job_3", "2026-10-20T10:00:00.000Z");
    setSeen(workspace, "job_4", "2026-10-20T10:00:00.000Z");
    setSeen(workspace, "job_5", "2026-10-01T10:00:00.000Z");
    setSeen(workspace, "job_6", "2026-10-15T10:00:00.000Z");
    setSeen(workspace, "job_7", "2026-10-10T10:00:00.000Z");
    // Listed side by side on one day: parallel headcount, not a repost.
    setSeen(workspace, "job_8", "2026-10-25T08:00:00.000Z");
    setSeen(workspace, "job_9", "2026-10-25T09:00:00.000Z");
  });

  afterEach(() => workspace.cleanup());

  it("finds a role re-listed under new ids on different days, per board", () => {
    const clusters = findRepostClusters(workspace.db, { windowDays: 120, minPostings: 2, now });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ company: "Acme", board: "acme", postings: 3, distinctDates: 3, reposted: true });
    expect(clusters[0]!.members.map((member) => member.jobId)).toEqual(["job_1", "job_2", "job_3"]);
    expect(clusters[0]!.spanDays).toBe(80);
  });

  it("respects the window and the minimum posting count", () => {
    expect(findRepostClusters(workspace.db, { windowDays: 60, minPostings: 2, now })[0]?.postings).toBe(2);
    expect(findRepostClusters(workspace.db, { windowDays: 120, minPostings: 4, now })).toEqual([]);
    expect(findRepostClusters(workspace.db, { windowDays: 120, minPostings: 2, now, company: "Other" })).toEqual([]);
  });

  it("reports the cluster a posting belongs to, even below the thresholds", () => {
    const signal = repostSignalFor(workspace.db, posting("2", "Senior Security Engineer (Remote)"), { windowDays: 120, minPostings: 2, now });
    expect(signal).toMatchObject({ reposted: true, postings: 3 });
    const sibling = repostSignalFor(workspace.db, posting("8", "Data Engineer"), { windowDays: 120, minPostings: 2, now });
    expect(sibling).toMatchObject({ reposted: false, postings: 2, distinctDates: 1 });
    expect(repostSignalFor(workspace.db, makeJob({ ats: "external" }), { windowDays: 90, minPostings: 2, now })).toBeNull();
  });
});
