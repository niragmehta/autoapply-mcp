import type { Workspace } from "../../config/load.js";
import { countSubmittedSince } from "../../db/repositories/applications.js";
import { countDismissals } from "../../db/repositories/dismissals.js";
import type { RunRecord } from "../../db/repositories/runs.js";
import { runCountsByStatus } from "../../db/repositories/runs.js";
import { summarizeRound, type RoundSummary } from "../../runner/roundCap.js";
import type { RunQueue } from "../../runner/queue.js";
import { startOfDayIso } from "../../submission/guards.js";
import { toErrorMessage } from "../../util/errors.js";
import { afterApplySummary, type AfterApplySummary } from "./afterApply.js";
import { unpreparedAcceptedCount } from "./jobs.js";
import { RESPONSE_OUTCOMES, outcomeTaxonomy } from "./outcomes.js";
import { annotateRun } from "./runs.js";

/** The campaign at a glance: one query set behind the Overview page and GET /api/status. */

type Row = Record<string, unknown>;

function countsBy(rows: Row[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [String(row.value ?? "none"), Number(row.total ?? 0)]));
}

function scalar(workspace: Workspace, sql: string, ...values: Array<string | number>): number {
  const row = workspace.db.prepare(sql).get(...values) as Row | undefined;
  return Number(row?.total ?? 0);
}

export type NextAction = { id: string; label: string; detail: string; count: number; href: string; tone: "attention" | "info" };

function nextActions(input: {
  needsHuman: number;
  awaitingApproval: number;
  approved: number;
  queueDepth: number;
  failedRuns: number;
  interruptedRuns: number;
  after: AfterApplySummary;
}): NextAction[] {
  const { after } = input;
  const actions: NextAction[] = [
    {
      id: "needs-human",
      label: "Answer blocked questions",
      detail: "Applications held until a person answers a required question.",
      count: input.needsHuman,
      href: "/needs-human",
      tone: "attention",
    },
    {
      id: "replies",
      label: "Review employer replies",
      detail: "Replies read from the inbox with a proposed outcome. Nothing is recorded until you confirm.",
      count: after.repliesToReview,
      href: "/inbox",
      tone: "attention",
    },
    {
      id: "offers",
      label: "Decide on offers",
      detail: "Offers with a deadline in the next seven days.",
      count: after.offersDueThisWeek,
      href: "/offers",
      tone: "attention",
    },
    {
      id: "approve",
      label: "Review and approve packets",
      detail: "Prepared applications waiting for approval of their exact packet.",
      count: input.awaitingApproval,
      href: "/applications?status=awaiting_approval",
      tone: "attention",
    },
    {
      id: "follow-ups",
      label: "Send follow-ups",
      detail: "Follow-ups due today. Drafts are ready to copy; you send them yourself.",
      count: after.followUpsDue,
      href: "/follow-ups",
      tone: "info",
    },
    {
      id: "interviews",
      label: "Prepare for interviews",
      detail: "Interviews scheduled in the next seven days.",
      count: after.interviewsThisWeek,
      href: "/interviews",
      tone: "info",
    },
    {
      id: "submit",
      label: "Submit approved applications",
      detail: "Approved and not yet sent. Start a submit run or send the packet by hand.",
      count: input.approved,
      href: "/applications?status=approved",
      tone: "info",
    },
    {
      id: "prepare",
      label: "Prepare accepted jobs",
      detail: "Accepted postings with no application yet, not dismissed.",
      count: input.queueDepth,
      href: "/jobs?decision=accept&hasApplication=no",
      tone: "info",
    },
    {
      id: "proposals",
      label: "Review company proposals",
      detail: "Verified boards for companies seen in leads, waiting for you to accept.",
      count: after.pendingProposals,
      href: "/leads",
      tone: "info",
    },
    {
      id: "failed-runs",
      label: "Check failed runs",
      detail: "Runs that stopped with an error in the last 24 hours.",
      count: input.failedRuns,
      href: "/runs?status=failed",
      tone: "attention",
    },
    {
      id: "interrupted-runs",
      label: "Check interrupted runs",
      detail: "Runs whose host stopped before they finished, in the last 24 hours.",
      count: input.interruptedRuns,
      href: "/runs?status=interrupted",
      tone: "info",
    },
  ];
  return actions.filter((action) => action.count > 0);
}

function roundOf(workspace: Workspace): (RoundSummary & { error?: undefined }) | { error: string } | null {
  const cap = workspace.campaign.runner.roundCap;
  if (!cap) return null;
  try {
    return summarizeRound(workspace.db, cap);
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

export function campaignStatus(workspace: Workspace, queue: RunQueue) {
  const { db, campaign } = workspace;
  const today = startOfDayIso();
  const decisions = countsBy(db.prepare("SELECT decision AS value, COUNT(*) AS total FROM evaluations GROUP BY decision").all() as Row[]);
  const tiers = countsBy(
    db.prepare("SELECT tier AS value, COUNT(*) AS total FROM evaluations WHERE decision = 'accept' GROUP BY tier").all() as Row[],
  );
  const tracks = countsBy(
    db.prepare("SELECT track_id AS value, COUNT(*) AS total FROM evaluations WHERE decision = 'accept' GROUP BY track_id").all() as Row[],
  );
  const statuses = countsBy(db.prepare("SELECT status AS value, COUNT(*) AS total FROM applications GROUP BY status").all() as Row[]);
  const outcomes = countsBy(
    db.prepare("SELECT status AS value, COUNT(DISTINCT application_id) AS total FROM outcomes GROUP BY status").all() as Row[],
  );
  const responded = scalar(
    workspace,
    `SELECT COUNT(DISTINCT application_id) AS total FROM outcomes WHERE status IN (${RESPONSE_OUTCOMES.map(() => "?").join(", ")})`,
    ...RESPONSE_OUTCOMES,
  );
  const queueDepth = unpreparedAcceptedCount(db);
  const dismissed = countDismissals(db);
  const after = afterApplySummary(workspace);
  const discovered = scalar(workspace, "SELECT COUNT(*) AS total FROM jobs");
  const discoveredToday = scalar(workspace, "SELECT COUNT(*) AS total FROM jobs WHERE first_seen_at >= ?", today);
  const applications = Object.values(statuses).reduce((sum, value) => sum + value, 0);
  const runCounts = runCountsByStatus(queue.db);
  const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
  const recentlyEnded = (status: "failed" | "interrupted") =>
    queue.list({ statuses: [status], limit: 100 }).filter((run) => (run.finishedAt ?? run.createdAt) >= dayAgo).length;
  const describeRun = (run: RunRecord) => ({ ...annotateRun(run), hostedHere: queue.isLocal(run.id) });

  return {
    campaign: {
      name: campaign.name,
      targetApplications: campaign.targetApplications,
      submissionMode: campaign.submission.mode,
      dailyLimit: campaign.submission.dailyLimit,
      tracks: campaign.tracks.map((track) => ({ id: track.id, label: track.label })),
    },
    jobs: {
      discovered,
      discoveredToday,
      byDecision: decisions,
      acceptedByTier: { A: tiers.A ?? 0, B: tiers.B ?? 0, C: tiers.C ?? 0 },
      acceptedByTrack: tracks,
      queueDepth,
      dismissed,
    },
    applications: {
      total: applications,
      byStatus: statuses,
      ready: (statuses.awaiting_approval ?? 0) + (statuses.approved ?? 0),
      needsHuman: statuses.needs_human ?? 0,
      submitted: statuses.submitted ?? 0,
    },
    today: { submitted: countSubmittedSince(db, today), dailyLimit: campaign.submission.dailyLimit, since: today },
    round: roundOf(workspace),
    companies: { configured: workspace.companies.length, active: workspace.companies.filter((company) => company.active).length },
    outcomes: { byStatus: outcomes, responded, taxonomy: outcomeTaxonomy() },
    afterApply: after,
    funnel: [
      { id: "discovered", label: "Discovered", count: discovered, href: "/jobs" },
      { id: "accepted", label: "Accepted", count: decisions.accept ?? 0, href: "/jobs?decision=accept" },
      { id: "prepared", label: "Prepared", count: applications, href: "/applications" },
      { id: "submitted", label: "Submitted", count: statuses.submitted ?? 0, href: "/applications?status=submitted" },
      { id: "responded", label: "Responded", count: responded, href: "/analytics" },
    ],
    runs: {
      counts: runCounts,
      active: queue.list({ statuses: ["queued", "running"], limit: 20 }).map(describeRun),
      recent: queue.list({ limit: 8 }).map(describeRun),
    },
    nextActions: nextActions({
      needsHuman: statuses.needs_human ?? 0,
      awaitingApproval: statuses.awaiting_approval ?? 0,
      approved: statuses.approved ?? 0,
      queueDepth,
      failedRuns: recentlyEnded("failed"),
      interruptedRuns: recentlyEnded("interrupted"),
      after,
    }),
  };
}
