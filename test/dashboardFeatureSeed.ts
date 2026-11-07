import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getWorkspace } from "../src/config/load.js";
import { saveApplication } from "../src/db/repositories/applications.js";
import { appendEvent } from "../src/db/repositories/events.js";
import { saveContactRecord } from "../src/db/repositories/career/contacts.js";
import { insertCompanyNoteRecord } from "../src/db/repositories/career/companyNotes.js";
import { insertSessionRecord, saveInterviewRecord } from "../src/db/repositories/career/interviews.js";
import { saveOfferRecord } from "../src/db/repositories/career/offers.js";
import { insertOutreachDraftRecord } from "../src/db/repositories/career/outreach.js";
import { saveStoryRecord } from "../src/db/repositories/career/stories.js";
import { insertTailoredDocument } from "../src/db/repositories/documents.js";
import { insertHarvestedBoards, recordBoardScan } from "../src/db/repositories/harvest.js";
import { insertInboxMessage, type InboxMessageRecord } from "../src/db/repositories/inbox.js";
import { saveEvaluation, upsertJobs } from "../src/db/repositories/jobs.js";
import { upsertLeads } from "../src/db/repositories/leads.js";
import { recordLiveness } from "../src/db/repositories/liveness.js";
import { insertReport } from "../src/db/repositories/reports.js";
import { finishRun, insertRun, markRunStarted } from "../src/db/repositories/runs.js";
import { fixtureResumePath, makeJob } from "./factories.js";

/**
 * Synthetic data for the after-applying features: an unprepared queue job, a
 * duplicate of a role already applied to, a reposted role, a follow-up that
 * is due, replies to review, an interview, an offer, research, reports,
 * tailored documents, leads, harvested boards and finished runs. Every name
 * is fictional.
 */

const DAY_MS = 86_400_000;

export const FEATURE_IDS = {
  queueJob: "job_initech",
  duplicateJob: "job_acme_dup",
  repostJob: "job_globex_repost",
  followUpApplication: "app_old",
  closedApplication: "app_ready",
  closedJob: "job_vandelay",
  matchedReply: "reply_matched",
  ambiguousReply: "reply_ambiguous",
  interview: "intv_acme",
  offer: "offer_acme",
  outreach: "out_acme",
  report: "rpt_acme",
  outsideReport: "rpt_outside",
  resumeDocument: "doc_resume",
  outsideDocument: "doc_outside",
  proposeRun: "run_propose_seed",
  submitRun: "run_submit_seed",
} as const;

export const CLOSED_REASON =
  'Vandelay is no longer taking applications for "Import Security Engineer" (posting closed: HTTP 404). If that is wrong, re-check with check_liveness force=true.';

function iso(offsetDays: number, from = Date.now()): string {
  return new Date(from + offsetDays * DAY_MS).toISOString();
}

function evaluateAccept(jobId: string, score: number, tier: "A" | "B"): void {
  saveEvaluation(getWorkspace().db, {
    jobId,
    decision: "accept",
    gate: { passed: true, rule: null, reason: "", evidence: "" },
    trackId: "ai-security",
    score,
    tier,
    components: [{ dimension: "roleAlignment", weight: 25, earned: 20, rationale: "title matches the track", evidence: [] }],
    flags: [],
    evaluatedAt: iso(0),
  });
}

function seedJobs(): void {
  const { db } = getWorkspace();
  upsertJobs(db, [
    makeJob({ id: FEATURE_IDS.queueJob, fingerprint: "fp_initech", externalId: "10", companyName: "Initech", title: "AI Security Engineer", board: "initech" }),
    makeJob({ id: FEATURE_IDS.duplicateJob, fingerprint: "fp_acme", externalId: "11", companyName: "Acme", title: "Senior Security Engineer", ats: "lever", board: "acme" }),
    makeJob({ id: FEATURE_IDS.repostJob, fingerprint: "fp_globex", externalId: "12", companyName: "Globex", title: "Staff Security Engineer", ats: "lever" }),
    makeJob({ id: "job_umbrella", fingerprint: "fp_umbrella", externalId: "13", companyName: "Umbrella", title: "Principal Security Engineer", board: "umbrella" }),
    makeJob({ id: FEATURE_IDS.closedJob, fingerprint: "fp_vandelay", externalId: "14", companyName: "Vandelay", title: "Import Security Engineer", board: "vandelay" }),
  ]);
  evaluateAccept(FEATURE_IDS.queueJob, 70, "B");
  evaluateAccept(FEATURE_IDS.duplicateJob, 86, "A");
  evaluateAccept(FEATURE_IDS.repostJob, 76, "B");
  evaluateAccept("job_umbrella", 82, "A");
  evaluateAccept(FEATURE_IDS.closedJob, 75, "B");
  // The repost is first seen on a later day than the original posting.
  db.prepare("UPDATE jobs SET first_seen_at = ? WHERE id = ?").run(iso(-20), "job_globex");
  db.prepare("UPDATE jobs SET first_seen_at = ? WHERE id = ?").run(iso(-2), FEATURE_IDS.repostJob);
  recordLiveness(db, { jobId: "job_acme", status: "open", via: "api", detail: "greenhouse lists the posting", checkedAt: iso(-0.1) });
  recordLiveness(db, { jobId: FEATURE_IDS.closedJob, status: "closed", via: "page", detail: "HTTP 404", checkedAt: iso(0) });
}

function seedApplications(): void {
  const { db } = getWorkspace();
  const base = {
    resumeId: "ai-security",
    resumePath: fixtureResumePath(),
    packetHash: "",
    coverLetter: "",
    blockedQuestions: [],
    approvedAt: null,
    submissionMode: null,
    confirmationRef: null,
    artifactPath: null,
    notes: "",
    answers: [],
  };
  saveApplication(db, {
    ...base,
    id: FEATURE_IDS.followUpApplication,
    jobId: "job_umbrella",
    status: "submitted",
    createdAt: iso(-11),
    submittedAt: iso(-10),
    submissionMode: "manual",
  });
  saveApplication(db, { ...base, id: FEATURE_IDS.closedApplication, jobId: FEATURE_IDS.closedJob, status: "awaiting_approval", createdAt: iso(-1), submittedAt: null });
}

function inboxMessage(overrides: Partial<InboxMessageRecord> & Pick<InboxMessageRecord, "id">): InboxMessageRecord {
  return {
    messageId: `<${overrides.id}@mail.example>`,
    mailbox: "INBOX",
    uid: null,
    receivedAt: iso(-0.5),
    fromAddress: "talent@acme.example",
    fromName: "Acme Talent",
    subject: "Your application",
    snippet: "Thanks for applying.",
    matchedApplicationId: null,
    matchConfidence: 0,
    classification: "acknowledged",
    classConfidence: 0.5,
    evidence: {},
    status: "proposed",
    processedAt: iso(-0.5),
    createdAt: iso(-0.5),
    ...overrides,
  };
}

function seedInbox(): void {
  const { db } = getWorkspace();
  insertInboxMessage(
    db,
    inboxMessage({
      id: FEATURE_IDS.matchedReply,
      subject: "Next steps: Senior Security Engineer",
      snippet: "We would like to schedule a 30 minute call with our recruiting team.",
      matchedApplicationId: "app_sent",
      matchConfidence: 0.92,
      classification: "recruiter_screen",
      classConfidence: 0.81,
      evidence: { classifier: { evidence: ["schedule a 30 minute call"] }, match: { ambiguous: false, candidates: [] }, decision: { reasons: ["recruiter_screen is not recorded automatically"] } },
    }),
  );
  insertInboxMessage(
    db,
    inboxMessage({
      id: FEATURE_IDS.ambiguousReply,
      fromAddress: "no-reply@ats.example",
      fromName: "",
      subject: "An update on your application",
      snippet: "After careful consideration we have decided to move forward with other candidates.",
      classification: "rejected",
      classConfidence: 0.88,
      evidence: {
        classifier: { evidence: ["move forward with other candidates"] },
        match: { ambiguous: true, candidates: [{ applicationId: "app_sent", company: "Acme" }, { applicationId: FEATURE_IDS.followUpApplication, company: "Umbrella" }] },
        decision: { reasons: ["the sender matches more than one application"] },
      },
    }),
  );
}

function seedCareer(): void {
  const { db } = getWorkspace();
  const now = iso(0);
  saveInterviewRecord(db, {
    id: FEATURE_IDS.interview,
    applicationId: "app_sent",
    stage: "recruiter_screen",
    scheduledAt: iso(2),
    durationMinutes: 30,
    format: "video",
    locationOrLink: "https://meet.example.com/acme-screen",
    interviewers: [{ name: "Jordan Recruiter", role: "Technical Recruiter" }],
    status: "scheduled",
    notes: "",
    createdAt: now,
    updatedAt: now,
  });
  insertSessionRecord(db, {
    id: "isess_plan",
    interviewId: FEATURE_IDS.interview,
    applicationId: "app_sent",
    kind: "plan",
    content: "# Prep plan\n\n- Re-read the posting\n- Prepare the guardrail story",
    createdAt: now,
  });
  saveOfferRecord(db, {
    id: FEATURE_IDS.offer,
    applicationId: "app_sent",
    company: "Acme",
    title: "Senior Security Engineer",
    level: "L5",
    currency: "USD",
    base: 250000,
    bonusTargetAmount: null,
    bonusTargetPct: 15,
    equityValueAnnual: 40000,
    equityDetails: "RSUs over four years",
    signOn: 20000,
    relocation: null,
    benefitsNotes: "",
    location: "Remote (US)",
    remotePolicy: "remote",
    startDate: null,
    deadline: iso(5).slice(0, 10),
    status: "received",
    createdAt: now,
    updatedAt: now,
  });
  saveStoryRecord(db, {
    id: "story_guardrails",
    title: "Shipping a guardrail framework",
    situation: "Model features were shipping without abuse review.",
    task: "Own the guardrail design.",
    action: "Built a policy framework and rolled it out team by team.",
    result: "Every launch now passes the same checks.",
    reflection: "Start with the riskiest team first.",
    skills: ["Python"],
    factIds: ["guardrails"],
    tags: ["leadership"],
    createdAt: now,
    updatedAt: now,
  });
  saveContactRecord(db, {
    id: "contact_jordan",
    company: "Acme",
    name: "Jordan Recruiter",
    role: "Technical Recruiter",
    kind: "recruiter",
    profileUrl: "https://www.linkedin.com/in/example-recruiter",
    email: "jordan@example.com",
    notes: "",
    source: "Acme careers page",
    createdAt: now,
    updatedAt: now,
  });
  insertOutreachDraftRecord(db, {
    id: FEATURE_IDS.outreach,
    applicationId: "app_sent",
    contactId: "contact_jordan",
    company: "Acme",
    channel: "linkedin_message",
    subject: "",
    body: "Hi Jordan, thanks for reaching out about the Senior Security Engineer role. Happy to talk this week.",
    status: "draft",
    createdAt: now,
    updatedAt: now,
  });
  insertCompanyNoteRecord(db, {
    id: "note_acme",
    company: "Acme",
    kind: "research",
    content: "Acme builds security tooling for model providers.",
    sources: ["https://acme.example/blog"],
    createdAt: now,
  });
}

function writeFile(path: string, content: string | Buffer): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function seedReportsAndDocuments(): void {
  const { db, paths } = getWorkspace();
  const reportPath = writeFile(
    join(paths.reports, "001-acme-report.md"),
    "# Senior Security Engineer at Acme\n\n**Verdict:** apply\n\n## Summary\n\nA strong match for the AI security track.\n\n| Dimension | Score |\n| --- | --- |\n| Role | 4.5 |\n",
  );
  const outside = writeFile(join(paths.home, "outside-report.md"), "# Not a report\n");
  const report = (id: string, jobId: string, number: number, markdownPath: string) =>
    insertReport(db, { id, jobId, number, createdAt: iso(0), score: 4.2, verdict: "apply", scaffold: {}, narrative: { summary: "A strong match." }, unverifiedFigures: [], markdownPath });
  report(FEATURE_IDS.report, "job_acme", 1, reportPath);
  report(FEATURE_IDS.outsideReport, "job_globex", 2, outside);

  const pdf = writeFile(join(paths.documents, "app_held", "resume-abcdef12.pdf"), "%PDF-1.4\n% synthetic\n");
  insertTailoredDocument(db, {
    id: FEATURE_IDS.resumeDocument,
    applicationId: "app_held",
    kind: "resume",
    path: pdf,
    sha256: "abcdef12",
    variantId: "ai-security",
    changes: [{ kind: "reorder", detail: "moved guardrail bullet first" }],
    checks: { pages: 1 },
  });
  const stray = writeFile(join(paths.home, "stray.pdf"), "%PDF-1.4\n% outside the documents folder\n");
  insertTailoredDocument(db, {
    id: FEATURE_IDS.outsideDocument,
    applicationId: "app_held",
    kind: "cover-letter",
    path: stray,
    sha256: "0f0f0f0f",
    variantId: "",
    changes: [],
    checks: {},
  });
}

function seedSourcing(): void {
  const { db } = getWorkspace();
  upsertLeads(db, [
    { source: "funded", sourceId: "hooli-series-b", company: "Hooli", url: "https://news.example/hooli-series-b", details: { round: "Series B" } },
    { source: "linkedin-alert", sourceId: "4242", company: "Initrode", title: "Security Engineer", location: "Remote", url: "https://www.linkedin.com/jobs/view/4242" },
  ]);
  insertHarvestedBoards(db, [{ ats: "greenhouse", board: "hooli", region: "global", hits: 3, sourceIndex: "CC-MAIN-2026-40" }]);
  recordBoardScan(db, "greenhouse", "hooli", { status: "matching", postings: 12, matching: 2, company: "Hooli" });
}

function finishedRun(id: string, type: string, params: unknown, summary: unknown, startedAt: string): void {
  const { db } = getWorkspace();
  insertRun(db, { id, type, params, createdAt: startedAt, hostPid: process.pid, hostName: "fixture" });
  markRunStarted(db, id, startedAt);
  finishRun(db, id, { status: "succeeded", finishedAt: iso(0), summary });
}

function seedRuns(): void {
  const startedAt = iso(-0.01);
  finishedRun(
    FEATURE_IDS.proposeRun,
    "propose",
    { limit: 5 },
    {
      proposals: [
        { company: "Hooli", leadIds: ["lead_hooli"], sources: ["funded"], boards: [{ ats: "greenhouse", board: "hooli", region: "global", postings: 12, sampleTitles: ["Security Engineer"] }] },
        { company: "Acme", leadIds: [], sources: ["linkedin-alert"], boards: [{ ats: "greenhouse", board: "acme", region: "global", postings: 4, sampleTitles: ["Senior Security Engineer"] }] },
      ],
      unresolved: [{ company: "Initrode", leadIds: ["lead_initrode"] }],
      skipped: { alreadyTracked: 0, excluded: 0, recentlyChecked: 0 },
      remaining: 0,
    },
    startedAt,
  );
  const { db } = getWorkspace();
  appendEvent(db, "submission.blocked", "app_held", { code: "posting_closed", mode: "auto" });
  finishedRun(
    FEATURE_IDS.submitRun,
    "submit",
    { applicationIds: [FEATURE_IDS.closedApplication, "app_held", "app_sent"], mode: "auto" },
    {
      requested: 3,
      sent: 0,
      prepared: 0,
      failed: 0,
      skipped: 2,
      alreadySubmitted: 1,
      stoppedEarly: null,
      items: [
        { applicationId: FEATURE_IDS.closedApplication, company: "Vandelay", title: "Import Security Engineer", outcome: "skipped", reason: CLOSED_REASON, code: "posting_closed", attempted: false },
        // A blocked-submission event and closed-sounding wording, but no code: the dashboard must not infer a closure.
        { applicationId: "app_held", company: "Globex", title: "Staff Security Engineer", outcome: "skipped", reason: "the posting is no longer taking applications, says a note", attempted: false },
        { applicationId: "app_sent", company: "Acme", title: "Senior Security Engineer", outcome: "already_submitted", attempted: false },
      ],
    },
    startedAt,
  );
}

/** Seeds every feature table. Call after the base fixture has seeded its jobs and applications. */
export function seedFeatureData(): void {
  seedJobs();
  seedApplications();
  seedInbox();
  seedCareer();
  seedReportsAndDocuments();
  seedSourcing();
  seedRuns();
}
