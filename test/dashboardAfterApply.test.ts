import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FEATURE_IDS } from "./dashboardFeatureSeed.js";
import { bearer, http, jsonBody, startFixture, type Fixture } from "./dashboardFixture.js";

/**
 * The after-applying pages' endpoints: inbox, follow-ups, analytics and
 * exports, interviews and offers, reports, documents and leads. Every one
 * calls the feature's own service; nothing here sends a message.
 */

let fixture: Fixture;
let port: number;

const get = async <T = Record<string, unknown>>(path: string) => {
  const response = await http(port, path, { headers: bearer() });
  expect(response.status, `${path}: ${response.text.slice(0, 300)}`).toBe(200);
  return response.json<T>();
};

const send = (method: string, path: string, body: unknown) => http(port, path, { method, ...jsonBody(port, body) });

const errorCode = (response: { json: <T>() => T }) => response.json<{ error: { code: string } }>().error.code;

/** Every string inside a JSON value, to check none of them carries the home folder. */
function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(allStrings);
  return [];
}

beforeAll(async () => {
  fixture = await startFixture("dashboard-after", {
    features: true,
    campaign: {
      hygiene: {
        liveness: { beforePrepare: false, beforeSubmit: false },
        blacklist: [{ scope: "company", value: "Initrode", reason: "staffing agency", since: "2026-01-01" }],
      },
    },
  });
  port = fixture.port;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await fixture.close();
});

describe("mutations need a session and the same origin", () => {
  const mutations: Array<[string, unknown]> = [
    [`/api/inbox/replies/${FEATURE_IDS.matchedReply}/confirm`, {}],
    [`/api/inbox/replies/${FEATURE_IDS.matchedReply}/dismiss`, {}],
    ["/api/inbox/paste", { text: "Thanks for applying." }],
    ["/api/follow-ups/mark", { applicationId: FEATURE_IDS.followUpApplication, kind: "first", action: "done" }],
    ["/api/exports", { format: "csv" }],
    [`/api/outreach/${FEATURE_IDS.outreach}/mark`, { status: "discarded" }],
    ["/api/documents/app_held/tailor", {}],
    ["/api/documents/variants/ai-security/render", {}],
    ["/api/leads/proposals/accept", { proposals: [{ company: "Hooli", ats: "greenhouse", board: "hooli" }] }],
    ["/api/leads/status", { ids: ["lead_any"], status: "ignored" }],
  ];

  it.each(mutations)("POST %s", async (path, body) => {
    const anonymous = await http(port, path, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify(body),
    });
    expect(anonymous.status).toBe(401);
    const crossSite = await http(port, path, { method: "POST", ...jsonBody(port, body, { origin: "https://evil.example" }) });
    expect(crossSite.status).toBe(403);
  });
});

describe("inbox", () => {
  it("reports whether reading is on, and lists replies awaiting review as untrusted text", async () => {
    const inbox = await get<{ enabled: boolean; replies: Record<string, number>; notice: string }>("/api/inbox");
    expect(inbox.enabled).toBe(false);
    expect(inbox.replies.proposed).toBe(2);
    expect(inbox.notice).toMatch(/untrusted/i);

    const replies = await get<{ count: number; replies: Array<{ replyId: string; match: { ambiguous: boolean; applicationId: string | null } }> }>(
      "/api/inbox/replies",
    );
    expect(replies.count).toBe(2);
    expect(replies.replies.find((reply) => reply.replyId === FEATURE_IDS.ambiguousReply)?.match.ambiguous).toBe(true);
    expect((await http(port, "/api/inbox/replies?status=archived", { headers: bearer() })).status).toBe(400);
  });

  it("records a reply only when confirmed, once", async () => {
    const confirmed = await send("POST", `/api/inbox/replies/${FEATURE_IDS.matchedReply}/confirm`, {});
    expect(confirmed.status).toBe(200);
    expect(confirmed.json()).toMatchObject({ applicationId: "app_sent", kind: "recruiter_screen" });
    const again = await send("POST", `/api/inbox/replies/${FEATURE_IDS.matchedReply}/confirm`, {});
    expect(again.status).toBe(409);
    expect(errorCode(again)).toBe("reply_already_recorded");
    const recorded = await get<{ outcomes: Array<{ status: string }> }>("/api/applications/app_sent");
    expect(recorded.outcomes.map((outcome) => outcome.status)).toContain("recruiter_screen");
  });

  it("asks which application an ambiguous reply is about, and can dismiss it instead", async () => {
    const unmatched = await send("POST", `/api/inbox/replies/${FEATURE_IDS.ambiguousReply}/confirm`, {});
    expect(unmatched.status).toBe(409);
    expect(errorCode(unmatched)).toBe("reply_unmatched");
    expect((await send("POST", `/api/inbox/replies/${FEATURE_IDS.ambiguousReply}/confirm`, { kind: "hired" })).status).toBe(400);
    const dismissed = await send("POST", `/api/inbox/replies/${FEATURE_IDS.ambiguousReply}/dismiss`, {});
    expect(dismissed.json()).toMatchObject({ replyId: FEATURE_IDS.ambiguousReply, status: "dismissed" });
    expect((await send("POST", "/api/inbox/replies/reply_missing/dismiss", {})).status).toBe(404);
  });

  it("classifies a pasted reply as a proposal and never records it by itself", async () => {
    const pasted = await send("POST", "/api/inbox/paste", {
      text: "Subject: Your application\nFrom: Acme Talent <talent@acme.example>\n\nUnfortunately we have decided not to move forward with your application.",
      applicationId: "app_sent",
    });
    expect(pasted.status).toBe(201);
    const body = pasted.json<{ replyId: string; proposal: { kind: string; applicationId: string }; notice: string }>();
    expect(body.proposal).toMatchObject({ kind: "rejected", applicationId: "app_sent" });
    const outcomes = await get<{ outcomes: Array<{ status: string }> }>("/api/applications/app_sent");
    expect(outcomes.outcomes.map((outcome) => outcome.status)).not.toContain("rejected");

    expect((await send("POST", "/api/inbox/paste", { text: "" })).status).toBe(400);
    const blank = await send("POST", "/api/inbox/paste", { text: "   " });
    expect(blank.status).toBe(400);
    expect(errorCode(blank)).toBe("reply_text_required");
    expect((await send("POST", "/api/inbox/paste", { text: "Hello", applicationId: "app_missing" })).status).toBe(404);
  });
});

describe("follow-ups", () => {
  it("lists what is due with a draft to copy", async () => {
    const plan = await get<{ enabled: boolean; due: Array<{ applicationId: string; kind: string; draft: string; channel: { channel: string } }> }>(
      "/api/follow-ups",
    );
    expect(plan.enabled).toBe(true);
    const due = plan.due.find((entry) => entry.applicationId === FEATURE_IDS.followUpApplication);
    expect(due).toMatchObject({ kind: "first", channel: { channel: "none" } });
    expect(due?.draft).toContain("Umbrella");
    expect(due?.draft).toContain("Alex Candidate");
    expect((await http(port, "/api/follow-ups?horizonDays=99", { headers: bearer() })).status).toBe(400);
  });

  it("skips a follow-up as skipped, not sent, and lists it as handled", async () => {
    const skipped = await send("POST", "/api/follow-ups/mark", { applicationId: FEATURE_IDS.followUpApplication, kind: "first", action: "skip" });
    expect(skipped.status).toBe(200);
    const result = skipped.json<{ action: string; record: { skipped: boolean; doneAt: string | null; note: string }; next: { kind: string } | null }>();
    expect(result.action).toBe("skip");
    expect(result.record).toMatchObject({ skipped: true, note: "" });
    expect(result.record.doneAt).not.toBeNull();
    expect(result.next?.kind).toBe("second");

    const plan = await get<{
      due: Array<{ applicationId: string }>;
      upcoming: Array<{ applicationId: string; kind: string }>;
      handled: Array<{ applicationId: string; kind: string; skipped: boolean; company: string }>;
    }>("/api/follow-ups");
    expect(plan.due.some((entry) => entry.applicationId === FEATURE_IDS.followUpApplication)).toBe(false);
    expect(plan.upcoming).toEqual(expect.arrayContaining([expect.objectContaining({ applicationId: FEATURE_IDS.followUpApplication, kind: "second" })]));
    expect(plan.handled).toEqual([expect.objectContaining({ applicationId: FEATURE_IDS.followUpApplication, kind: "first", skipped: true, company: "Umbrella" })]);
  });

  it("records a follow-up you sent as done, shown as sent", async () => {
    const sent = await send("POST", "/api/follow-ups/mark", { applicationId: FEATURE_IDS.followUpApplication, kind: "second", action: "done", note: "emailed the recruiter" });
    expect(sent.status).toBe(200);
    expect(sent.json()).toMatchObject({ action: "done", record: { skipped: false, note: "emailed the recruiter" } });
    const handled = (await get<{ handled: Array<{ kind: string; skipped: boolean }> }>("/api/follow-ups")).handled;
    expect(handled.find((entry) => entry.kind === "second")).toMatchObject({ skipped: false });
    expect(handled.find((entry) => entry.kind === "first")).toMatchObject({ skipped: true });
  });

  it("refuses follow-ups before submission and unknown actions", async () => {
    const early = await send("POST", "/api/follow-ups/mark", { applicationId: "app_held", kind: "first", action: "snooze", days: 3 });
    expect(early.status).toBe(409);
    expect(errorCode(early)).toBe("application_not_submitted");
    expect((await send("POST", "/api/follow-ups/mark", { applicationId: "app_held", kind: "first", action: "send" })).status).toBe(400);
    expect((await send("POST", "/api/follow-ups/mark", { applicationId: "app_held", kind: "first", action: "skipped" })).status).toBe(400);
  });
});

describe("analytics and exports", () => {
  it("returns the campaign analytics with sample sizes, and rejects a bad since date", async () => {
    const analytics = await get<{ funnel: { submitted: number; stages: Array<{ stage: string; fromPrevious: { n: number } | null }> } }>("/api/analytics");
    expect(analytics.funnel.submitted).toBeGreaterThanOrEqual(2);
    expect(analytics.funnel.stages.length).toBeGreaterThan(0);
    const bad = await http(port, "/api/analytics?since=not-a-date", { headers: bearer() });
    expect(bad.status).toBe(400);
    expect(errorCode(bad)).toBe("invalid_since");
  });

  it("writes a tracker export and serves it as a download", async () => {
    const created = await send("POST", "/api/exports", { format: "csv" });
    expect(created.status).toBe(201);
    const exported = created.json<{ name: string; rows: number; href: string }>();
    expect(exported.name).toMatch(/\.csv$/);
    const download = await http(port, exported.href, { headers: bearer() });
    expect(download.status).toBe(200);
    expect(download.headers["content-type"]).toContain("text/csv");
    expect(download.headers["content-disposition"]).toBe(`attachment; filename="${exported.name}"`);
    expect(download.text).toContain("Umbrella");
    const listed = await get<{ files: Array<{ name: string }> }>("/api/exports");
    expect(listed.files.map((file) => file.name)).toContain(exported.name);
  });

  it("serves only export files by plain name", async () => {
    for (const name of ["..%2Fcampaign.json", "..%5C..%5Cprofile.json", "profile.json", "%2E%2E", "missing.csv"]) {
      const response = await http(port, `/api/exports/${name}`, { headers: bearer() });
      expect(response.status, name).toBe(404);
    }
    expect((await send("POST", "/api/exports", { format: "xlsx" })).status).toBe(400);
  });
});

describe("interviews and offers", () => {
  it("lists upcoming interviews and one interview with its prep sessions", async () => {
    const upcoming = await get<{ interviews: Array<{ id: string; company: string; daysUntil: number }> }>("/api/interviews");
    expect(upcoming.interviews).toEqual([expect.objectContaining({ id: FEATURE_IDS.interview, company: "Acme" })]);
    expect((await get<{ count: number }>("/api/interviews?scope=all&status=done")).count).toBe(0);
    const detail = await get<{ interview: { title: string }; sessions: Array<{ kind: string }> }>(`/api/interviews/${FEATURE_IDS.interview}`);
    expect(detail.interview.title).toBe("Senior Security Engineer");
    expect(detail.sessions.map((session) => session.kind)).toEqual(["plan"]);
    expect((await get<{ count: number }>("/api/interview-sessions?applicationId=app_sent")).count).toBe(1);
    expect((await http(port, "/api/interviews/intv_missing", { headers: bearer() })).status).toBe(404);
  });

  it("downloads a calendar file for an interview", async () => {
    const ics = await http(port, `/api/interviews/${FEATURE_IDS.interview}/ics`, { headers: bearer() });
    expect(ics.status).toBe(200);
    expect(ics.headers["content-type"]).toContain("text/calendar");
    expect(ics.headers["content-disposition"]).toMatch(/^attachment; filename="interview-Acme-\d{4}-\d{2}-\d{2}\.ics"$/);
    expect(ics.text).toContain("BEGIN:VCALENDAR");
    expect(ics.text).toContain("SUMMARY:Interview: Senior Security Engineer at Acme");
    expect(ics.text).toContain("URL:https://meet.example.com/acme-screen");
    expect((await http(port, "/api/interviews/intv_missing/ics", { headers: bearer() })).status).toBe(404);
  });

  it("lists and compares offers", async () => {
    expect((await get<{ count: number }>("/api/offers")).count).toBe(1);
    const compared = await get<{ currency: string; offers: Array<{ company: string; daysToDeadline: number | null }>; assumptions: string[] }>(
      "/api/offers/compare",
    );
    expect(compared.currency).toBe("USD");
    expect(compared.offers).toEqual([expect.objectContaining({ company: "Acme" })]);
    expect(compared.assumptions.length).toBeGreaterThan(0);
    expect((await http(port, "/api/offers?status=pending", { headers: bearer() })).status).toBe(400);
  });

  it("lists stories, the story-bank scaffold, contacts and company notes", async () => {
    expect((await get<{ count: number }>("/api/stories")).count).toBe(1);
    expect(await get<{ targetStoryCount: unknown }>("/api/stories/scaffold")).toHaveProperty("targetStoryCount");
    expect((await get<{ contacts: Array<{ name: string }> }>("/api/contacts?company=Acme")).contacts.map((contact) => contact.name)).toEqual(["Jordan Recruiter"]);
    expect((await get<{ count: number }>("/api/company-notes")).count).toBe(1);
    expect((await get<{ count: number }>("/api/company-notes?company=acme")).count).toBe(1);
    expect((await get<{ count: number }>("/api/company-notes?company=Nobody")).count).toBe(0);
  });

  it("marks an outreach draft sent by the person, and refuses a transition back", async () => {
    expect((await get<{ drafts: Array<{ id: string; status: string }> }>("/api/outreach")).drafts).toEqual([
      expect.objectContaining({ id: FEATURE_IDS.outreach, status: "draft" }),
    ]);
    const sent = await send("POST", `/api/outreach/${FEATURE_IDS.outreach}/mark`, { status: "sent_by_user" });
    expect(sent.status).toBe(200);
    expect(sent.json()).toMatchObject({ changed: true, draft: { status: "sent_by_user" } });
    const back = await send("POST", `/api/outreach/${FEATURE_IDS.outreach}/mark`, { status: "draft" });
    expect(back.status).toBe(400);
    expect(errorCode(back)).toBe("invalid_transition");
    expect((await send("POST", `/api/outreach/${FEATURE_IDS.outreach}/mark`, { status: "sent" })).status).toBe(400);
  });
});

describe("reports", () => {
  it("lists evaluation reports without file paths and reads one report's Markdown", async () => {
    const list = await get<{ reports: Array<Record<string, unknown>> }>("/api/reports");
    expect(list.reports).toHaveLength(2);
    expect(list.reports[0]).not.toHaveProperty("markdownPath");
    const report = await get<{ markdown: string | null; job: { company: string }; report: { verdict: string } }>(`/api/reports/${FEATURE_IDS.report}`);
    expect(report.markdown).toContain("# Senior Security Engineer at Acme");
    expect(report.job.company).toBe("Acme");
    expect((await http(port, "/api/reports/rpt_missing", { headers: bearer() })).status).toBe(404);
  });

  it("does not read a report file outside the reports folder", async () => {
    const outside = await get<{ markdown: string | null; markdownNote: string }>(`/api/reports/${FEATURE_IDS.outsideReport}`);
    expect(outside.markdown).toBeNull();
    expect(outside.markdownNote).toMatch(/outside the reports folder/);
  });

  it("finds reposted roles and lists the do-not-apply list", async () => {
    const reposts = await get<{ count: number; clusters: Array<{ company: string; postings: number }> }>("/api/reposts");
    expect(reposts.clusters).toEqual([expect.objectContaining({ company: "Globex", postings: 2 })]);
    expect((await http(port, "/api/reposts?minPostings=1", { headers: bearer() })).status).toBe(400);
    const blacklist = await get<{ entries: Array<{ value: string; reason: string }> }>("/api/blacklist");
    expect(blacklist.entries).toEqual([expect.objectContaining({ value: "Initrode", reason: "staffing agency" })]);
  });
});

describe("documents", () => {
  it("lists each application's resume and letter state", async () => {
    const overview = await get<{ resumeSource: { present: boolean }; variants: Array<{ id: string; exists: boolean }>; rows: Array<{ applicationId: string; documents: number }> }>(
      "/api/documents",
    );
    expect(overview.resumeSource.present).toBe(false);
    expect(overview.variants).toEqual([expect.objectContaining({ id: "ai-security", exists: true })]);
    expect(overview.rows.find((row) => row.applicationId === "app_held")?.documents).toBe(2);
  });

  it("serves a tailored PDF from the documents folder only", async () => {
    const status = await get<{ history: Array<{ id: string; href: string | null; fileName: string }> }>("/api/documents/app_held");
    expect(allStrings(status).filter((text) => text.includes(homedir()))).toEqual([]);
    const byId = Object.fromEntries(status.history.map((entry) => [entry.id, entry]));
    expect(byId[FEATURE_IDS.resumeDocument]).toMatchObject({ href: `/api/documents/files/${FEATURE_IDS.resumeDocument}`, fileName: "resume-abcdef12.pdf" });
    expect(byId[FEATURE_IDS.outsideDocument]?.href).toBeNull();

    const pdf = await http(port, `/api/documents/files/${FEATURE_IDS.resumeDocument}`, { headers: bearer() });
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.text.startsWith("%PDF")).toBe(true);
    expect((await http(port, `/api/documents/files/${FEATURE_IDS.outsideDocument}`, { headers: bearer() })).status).toBe(404);
    expect((await http(port, "/api/documents/files/doc_missing", { headers: bearer() })).status).toBe(404);
    expect((await http(port, "/api/documents/app_missing", { headers: bearer() })).status).toBe(404);
  });

  it("explains why a resume cannot be rendered yet, without the home folder in the message", async () => {
    const tailor = await send("POST", "/api/documents/app_held/tailor", {});
    expect(tailor.status).toBe(409);
    expect(errorCode(tailor)).toBe("resume_source_missing");
    expect(tailor.json<{ error: { message: string } }>().error.message).not.toContain(homedir());
    const variant = await send("POST", "/api/documents/variants/ai-security/render", {});
    expect(errorCode(variant)).toBe("resume_source_missing");
    expect((await send("POST", "/api/documents/app_held/tailor", { headline: "" })).status).toBe(400);
  });
});

describe("leads", () => {
  it("lists leads with counts per source and status", async () => {
    const leads = await get<{ count: number; counts: Array<{ source: string; status: string; count: number }> }>("/api/leads");
    expect(leads.count).toBe(2);
    expect(leads.counts).toEqual(expect.arrayContaining([expect.objectContaining({ source: "funded", status: "new", count: 1 })]));
    expect((await http(port, "/api/leads?status=archived", { headers: bearer() })).status).toBe(400);
  });

  it("offers the latest propose run's boards for companies not yet tracked", async () => {
    const proposals = await get<{ runId: string; proposals: Array<{ company: string }>; alreadyTracked: number; unresolved: Array<{ company: string }> }>(
      "/api/leads/proposals",
    );
    expect(proposals.runId).toBe(FEATURE_IDS.proposeRun);
    expect(proposals.proposals.map((proposal) => proposal.company)).toEqual(["Hooli"]);
    expect(proposals.alreadyTracked).toBe(1);
    expect(proposals.unresolved.map((entry) => entry.company)).toEqual(["Initrode"]);
    const harvest = await get<{ matching: Array<{ board: string; matching: number }> }>("/api/harvest");
    expect(harvest.matching).toEqual([expect.objectContaining({ board: "hooli", matching: 2 })]);
  });

  it("saves an accepted proposal only after verifying its board again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ jobs: [{ id: 7, title: "Security Engineer", absolute_url: "https://job-boards.greenhouse.io/hooli/jobs/7", location: { name: "Remote" }, content: "" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const accepted = await send("POST", "/api/leads/proposals/accept", { proposals: [{ company: "Hooli", ats: "greenhouse", board: "hooli", tier: "B" }] });
    expect(accepted.status).toBe(200);
    expect(accepted.json()).toMatchObject({ saved: [expect.objectContaining({ company: "Hooli", board: "hooli" })], rejected: [] });
    const companies = JSON.parse(readFileSync(join(fixture.home, "companies.json"), "utf8"));
    expect(companies.companies.map((company: { name: string }) => company.name)).toContain("Hooli");
    expect((await get<{ proposals: unknown[] }>("/api/leads/proposals")).proposals).toEqual([]);

    expect((await send("POST", "/api/leads/proposals/accept", { proposals: [] })).status).toBe(400);
    expect((await send("POST", "/api/leads/proposals/accept", { proposals: [{ company: "X", ats: "myspace", board: "x" }] })).status).toBe(400);
  });

  it("reports what board harvesting found, with an accepted board now tracked", async () => {
    const harvest = await get<{ boards: Array<{ ats: string; status: string; count: number }>; matching: Array<{ board: string; matching: number }> }>("/api/harvest");
    expect(harvest.boards).toEqual([expect.objectContaining({ ats: "greenhouse", status: "tracked", count: 1 })]);
    expect(harvest.matching).toEqual([]);
  });

  it("ignores and restores leads, never touching a resolved one", async () => {
    const leads = (await get<{ leads: Array<{ id: string; company: string; status: string }> }>("/api/leads?status=")).leads;
    const hooli = leads.find((lead) => lead.company === "Hooli");
    const initrode = leads.find((lead) => lead.company === "Initrode");
    expect(hooli?.status).toBe("resolved");
    expect(initrode?.status).toBe("new");

    const ignored = await send("POST", "/api/leads/status", { ids: [initrode!.id, hooli!.id, "lead_missing"], status: "ignored" });
    expect(ignored.status).toBe(200);
    expect(ignored.json()).toEqual({ status: "ignored", updated: 1, missing: ["lead_missing"] });
    const statuses = async () => Object.fromEntries((await get<{ leads: Array<{ company: string; status: string }> }>("/api/leads?status=")).leads.map((lead) => [lead.company, lead.status]));
    expect(await statuses()).toMatchObject({ Initrode: "ignored", Hooli: "resolved" });

    const restored = await send("POST", "/api/leads/status", { ids: [initrode!.id], status: "new" });
    expect(restored.json()).toEqual({ status: "new", updated: 1, missing: [] });
    expect(await statuses()).toMatchObject({ Initrode: "new", Hooli: "resolved" });

    expect((await send("POST", "/api/leads/status", { ids: [initrode!.id], status: "resolved" })).status).toBe(400);
    expect((await send("POST", "/api/leads/status", { ids: [], status: "ignored" })).status).toBe(400);
  });
});

describe("health", () => {
  it("adds profile readiness, reply reading and the feature tables", async () => {
    const health = await get<{
      profile: { readiness: number; nextSteps: unknown[] };
      inbox: { enabled: boolean };
      database: { counts: Record<string, number> };
      checks: Array<{ id: string }>;
    }>("/api/health");
    expect(typeof health.profile.readiness).toBe("number");
    expect(health.inbox.enabled).toBe(false);
    expect(health.database.counts.liveness_checks).toBe(2);
    expect(health.database.counts.leads).toBe(2);
    expect(health.checks.map((check) => check.id)).toContain("reply-inbox");
  });
});
