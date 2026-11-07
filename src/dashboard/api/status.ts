import {
  CONTACT_KINDS,
  INTERVIEW_STAGES,
  INTERVIEW_STATUSES,
  NOTE_KINDS,
  OFFER_STATUSES,
  OUTREACH_CHANNELS,
  OUTREACH_STATUSES,
  SESSION_KINDS,
} from "../../career/types.js";
import { FOLLOWUP_KINDS } from "../../db/repositories/followups.js";
import { INBOX_STATUSES } from "../../db/repositories/inbox.js";
import { LEAD_STATUSES } from "../../db/repositories/leads.js";
import { AtsKindSchema, LocationClassSchema } from "../../domain/campaign.js";
import { ApplicationStatusSchema } from "../../domain/job.js";
import { RUN_STATUSES } from "../../db/repositories/runs.js";
import { outcomeTaxonomy } from "../queries/outcomes.js";
import { campaignStatus } from "../queries/status.js";
import type { Router } from "../router.js";
import { OUTCOME_STATUSES } from "./applications.js";

/** GET /api/status (the Overview) and GET /api/meta (enumerations the filter controls need). */
export function registerRoutes(router: Router): void {
  router.get("/api/status", ({ ctx }) => campaignStatus(ctx.workspace(), ctx.queue));

  router.get("/api/meta", ({ ctx }) => {
    const workspace = ctx.workspace();
    const { campaign } = workspace;
    return {
      campaign: campaign.name,
      tracks: campaign.tracks.map((track) => ({ id: track.id, label: track.label })),
      tiers: ["A", "B", "C"],
      decisions: ["accept", "review", "reject"],
      locationClasses: LocationClassSchema.options,
      atsKinds: AtsKindSchema.options,
      applicationStatuses: ApplicationStatusSchema.options,
      outcomeStatuses: OUTCOME_STATUSES,
      outcomes: outcomeTaxonomy(),
      runStatuses: RUN_STATUSES,
      runTypes: ctx.queue.taskTypes(),
      inboxStatuses: INBOX_STATUSES,
      followUpKinds: FOLLOWUP_KINDS,
      leadStatuses: LEAD_STATUSES,
      career: {
        interviewStages: INTERVIEW_STAGES,
        interviewStatuses: INTERVIEW_STATUSES,
        sessionKinds: SESSION_KINDS,
        noteKinds: NOTE_KINDS,
        contactKinds: CONTACT_KINDS,
        outreachChannels: OUTREACH_CHANNELS,
        outreachStatuses: OUTREACH_STATUSES,
        offerStatuses: OFFER_STATUSES,
      },
      companies: workspace.companies.map((company) => company.name).sort((a, b) => a.localeCompare(b)),
      compensation: {
        profileCurrency: workspace.profile.compensation.currency.toUpperCase(),
        campaignCurrency: campaign.compensation.currency.toUpperCase(),
        fx: campaign.compensation.fx,
      },
      documents: campaign.documents,
      submission: {
        mode: campaign.submission.mode,
        dailyLimit: campaign.submission.dailyLimit,
        maxBatchSize: campaign.submission.maxBatchSize,
        maxPerCompany: campaign.submission.maxPerCompany,
        minDelaySeconds: campaign.submission.minDelaySeconds,
      },
      inbox: { enabled: campaign.inbox.enabled, autoRecord: campaign.inbox.autoRecord },
      followUps: { enabled: campaign.followUps.enabled, ghostAfterDays: campaign.followUps.ghostAfterDays },
      runner: campaign.runner,
    };
  });
}
