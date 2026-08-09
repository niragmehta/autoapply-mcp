import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getWorkspace } from "../config/load.js";
import {
  countSubmittedSince,
  getApplication,
  lastSubmissionAt,
  latestApproval,
  recordApproval,
  saveApplication,
} from "../db/repositories/applications.js";
import { appendEvent } from "../db/repositories/events.js";
import { getEvaluation, getJob } from "../db/repositories/jobs.js";import { runApplicationForm } from "../submission/browser.js";
import { checkSubmissionAllowed, startOfDayIso } from "../submission/guards.js";
import { computePacketHash, renderPacketPreview, type SubmissionPacket } from "../submission/packet.js";
import { AppError } from "../util/errors.js";
import { personalResolverFor } from "../submission/personalResolver.js";
import { experienceResolverFor } from "../submission/experienceResolver.js";
import { narrativeResolverFor } from "../submission/narrativeResolver.js";
import { newId, nowIso } from "../util/hash.js";
import { handler, ok, okText } from "./helpers.js";

/**
 * Approval and submission.
 *
 * These are the only tools that can cause an employer-visible action, so each
 * one re-checks the guards rather than trusting earlier state.
 */

function packetFor(applicationId: string) {
  const workspace = getWorkspace();
  const application = getApplication(workspace.db, applicationId);
  if (!application) throw new AppError("application_not_found", `no application ${applicationId}`);
  const job = getJob(workspace.db, application.jobId);
  if (!job) throw new AppError("job_not_found", `job ${application.jobId} is missing`);
  const packet: SubmissionPacket = {
    applicationId: application.id,
    jobId: application.jobId,
    company: job.companyName,
    jobTitle: job.title,
    applyUrl: job.applyUrl,
    resumeId: application.resumeId,
    resumePath: application.resumePath,
    coverLetter: application.coverLetter,
    answers: application.answers,
  };
  return { workspace, application, job, packet, currentHash: computePacketHash(packet) };
}

export function registerSubmissionTools(server: McpServer): void {
  server.registerTool(
    "approve_application",
    {
      title: "Approve an application for submission",
      description:
        "Records the human decision that authorizes submission. The supplied packetHash must match the current content exactly; any later edit invalidates the approval.",
      inputSchema: {
        applicationId: z.string().min(1),
        packetHash: z.string().min(8).describe("Hash shown by preview_application, proving the approved content."),
        decision: z.enum(["approved", "rejected"]).default("approved"),
        note: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    handler(async (args: { applicationId: string; packetHash: string; decision?: "approved" | "rejected"; note?: string }) => {
      const { workspace, application, currentHash } = packetFor(args.applicationId);
      const decision = args.decision ?? "approved";

      if (args.packetHash !== currentHash) {
        throw new AppError(
          "packet_hash_mismatch",
          `supplied hash does not match current content (current: ${currentHash}). Re-run preview_application and approve the current packet.`,
        );
      }

      recordApproval(workspace.db, {
        id: newId("apr"),
        applicationId: application.id,
        packetHash: currentHash,
        decision,
        note: args.note ?? "",
      });

      const updated = {
        ...application,
        packetHash: currentHash,
        status: decision === "approved" ? ("approved" as const) : ("skipped" as const),
        approvedAt: decision === "approved" ? nowIso() : null,
      };
      saveApplication(workspace.db, updated);
      appendEvent(workspace.db, "application.approval", application.id, { decision, packetHash: currentHash });

      return ok({
        applicationId: application.id,
        decision,
        status: updated.status,
        packetHash: currentHash,
        nextStep: decision === "approved" ? "Call submit_application." : "No further action; application skipped.",
      });
    }),
  );

  server.registerTool(
    "submit_application",
    {
      title: "Submit an approved application",
      description:
        "Runs every submission guard, then acts according to mode. 'manual' returns the packet for a person to submit. 'assisted' fills the hosted form in a visible browser and leaves it for a person to submit. 'auto' fills and clicks submit, and is only available when the campaign and company allowlists permit it.",
      inputSchema: {
        applicationId: z.string().min(1),
        mode: z.enum(["manual", "assisted", "auto"]).default("manual"),
        headless: z.boolean().optional().describe("Run the browser headless. Ignored in assisted mode."),
        keepOpenSeconds: z
          .number()
          .int()
          .min(0)
          .max(1800)
          .optional()
          .describe("Assisted mode: how long to leave the filled form open for review."),
        verificationCode: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The one-time code the board emailed after a previous attempt hit its verification gate. Each attempt emails a new code, so use the most recent one.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    handler(async (args: { applicationId: string; mode?: "manual" | "assisted" | "auto"; headless?: boolean; keepOpenSeconds?: number; verificationCode?: string }) => {
      const { workspace, application, job, packet, currentHash } = packetFor(args.applicationId);
      const mode = args.mode ?? "manual";
      const approval = latestApproval(workspace.db, application.id);

      const guard = checkSubmissionAllowed({
        application: { ...application, packetHash: currentHash },
        job,
        campaign: workspace.campaign,
        approval,
        submittedToday: countSubmittedSince(workspace.db, startOfDayIso()),
        lastSubmissionAt: lastSubmissionAt(workspace.db),
        requestedMode: mode,
      });

      if (!guard.allowed) {
        appendEvent(workspace.db, "submission.blocked", application.id, { code: guard.code, mode });
        throw new AppError(guard.code, guard.reason, { applicationId: application.id, mode });
      }

      if (mode === "manual") {
        appendEvent(workspace.db, "submission.manual_packet", application.id, { applyUrl: job.applyUrl });
        return okText(
          [
            "Submission guards passed. This packet is ready for you to submit by hand.",
            "",
            `Apply URL: ${job.applyUrl}`,
            "",
            renderPacketPreview(packet),
            "",
            "After submitting, call record_submission with the confirmation reference.",
          ].join("\n"),
        );
      }

      const result = await runApplicationForm(packet, {
        submit: mode === "auto",
        headless: mode === "assisted" ? false : args.headless ?? true,
        artifactsDir: workspace.paths.artifacts,
        policy: workspace.campaign.submission,
        candidateCountry: workspace.profile.identity.location.country,
        answerBank: workspace.profile.answers,
        personalResolver: personalResolverFor(workspace.profile),
        experienceResolver: experienceResolverFor(workspace.profile),
        narrativeResolver: narrativeResolverFor(job, getEvaluation(workspace.db, job.id), workspace.profile, workspace.campaign),
        accountEmail: workspace.profile.identity.email,
        // Registering on an employer's tenant is a bigger step than filling a
        // public form, so it is only done when a person is watching the window.
        allowAccountCreation: mode === "assisted",
        keepOpenMs: mode === "assisted" ? (args.keepOpenSeconds ?? 240) * 1000 : 0,
        verificationCode: args.verificationCode,
      });

      if (result.status === "submitted") {
        saveApplication(workspace.db, {
          ...application,
          packetHash: currentHash,
          status: "submitted",
          submittedAt: nowIso(),
          submissionMode: mode,
          confirmationRef: result.confirmationText.slice(0, 200),
          artifactPath: result.screenshotPath,
        });
        appendEvent(workspace.db, "submission.submitted", application.id, {
          mode,
          finalUrl: result.finalUrl,
          company: job.companyName,
        });
      } else if (result.status === "aborted") {
        saveApplication(workspace.db, {
          ...application,
          packetHash: currentHash,
          status: "needs_human",
          notes: `${application.notes}\n[${nowIso()}] aborted: ${result.reason}`.trim(),
          artifactPath: result.screenshotPath,
        });
        appendEvent(workspace.db, "submission.aborted", application.id, { mode, reason: result.reason });
      } else {
        appendEvent(workspace.db, "submission.prepared", application.id, { mode, finalUrl: result.finalUrl });
      }

      return ok({
        applicationId: application.id,
        mode,
        result,
        nextStep:
          result.status === "submitted"
            ? "Submitted. Track the outcome with record_outcome."
            : result.status === "prepared"
              ? "Form filled. Review the open window or the screenshot, submit, then call record_submission."
              : "Blocked. Resolve the reason above; this application needs a human.",
      });
    }),
  );

  server.registerTool(
    "record_submission",
    {
      title: "Record a manual submission",
      description: "Marks an application as submitted after a person sent it, so counts, pacing and duplicate checks stay accurate.",
      inputSchema: {
        applicationId: z.string().min(1),
        confirmationRef: z.string().optional(),
        notes: z.string().optional(),
      },
      annotations: { readOnlyHint: false },
    },
    handler(async (args: { applicationId: string; confirmationRef?: string; notes?: string }) => {
      const { workspace, application, currentHash } = packetFor(args.applicationId);
      if (application.status === "submitted") {
        throw new AppError("already_submitted", `already recorded as submitted at ${application.submittedAt}`);
      }
      const submittedAt = nowIso();
      saveApplication(workspace.db, {
        ...application,
        packetHash: currentHash,
        status: "submitted",
        submittedAt,
        submissionMode: "manual",
        confirmationRef: args.confirmationRef ?? null,
        notes: args.notes ?? application.notes,
      });
      appendEvent(workspace.db, "submission.recorded", application.id, { submittedAt });
      return ok({ applicationId: application.id, status: "submitted", submittedAt });
    }),
  );
}
