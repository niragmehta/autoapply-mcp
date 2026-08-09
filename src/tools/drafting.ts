import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getWorkspace } from "../config/load.js";
import { getApplication, saveApplication } from "../db/repositories/applications.js";
import { appendEvent } from "../db/repositories/events.js";
import { applicationCountsByCompany, getEvaluation, getJob } from "../db/repositories/jobs.js";
import type { Application, DraftAnswer } from "../domain/job.js";
import { unresolvedRequired, type FormQuestion } from "../drafting/answers.js";
import { prepareApplicationFor } from "../drafting/prepare.js";
import { computePacketHash, renderPacketPreview, type SubmissionPacket } from "../submission/packet.js";
import { AppError } from "../util/errors.js";
import { handler, ok, okText } from "./helpers.js";

/** Tools that assemble a single application without sending anything. */

function buildPacket(application: Application, job: { companyName: string; title: string; applyUrl: string }): SubmissionPacket {
  return {
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
}

export function registerDraftingTools(server: McpServer): void {
  server.registerTool(
    "prepare_application",
    {
      title: "Prepare an application packet",
      description:
        "Builds the match report, loads the employer's application questions, drafts only the answers that verified profile data supports, and selects the resume variant for the matched track. Creates a local draft; nothing is sent.",
      inputSchema: {
        jobId: z.string().min(1),
        force: z.boolean().optional().describe("Prepare even if the job did not pass the campaign gates."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    handler(async (args: { jobId: string; force?: boolean }) => {
      const workspace = getWorkspace();
      const job = getJob(workspace.db, args.jobId);
      if (!job) throw new AppError("job_not_found", `no job stored with id ${args.jobId}`);

      const evaluation = getEvaluation(workspace.db, args.jobId);
      if (!evaluation) throw new AppError("not_evaluated", "run discover_jobs before preparing an application");
      if (evaluation.decision !== "accept" && args.force !== true) {
        throw new AppError(
          "job_not_accepted",
          `job was ${evaluation.decision} (${evaluation.gate.rule ?? "score below threshold"}: ${evaluation.gate.reason}). Pass force=true to override deliberately.`,
        );
      }

      // A ceiling only meant per batch would be bypassed by preparing one job
      // at a time, which is the normal way this tool is used.
      const cap = workspace.campaign.submission.maxPerCompany;
      const held = applicationCountsByCompany(workspace.db).get(job.companyName.toLowerCase()) ?? 0;
      if (held >= cap && args.force !== true) {
        throw new AppError(
          "company_cap_reached",
          `${job.companyName} already has ${held} application${held === 1 ? "" : "s"}, at the campaign ceiling of ${cap} per company. Withdraw one, raise submission.maxPerCompany, or pass force=true to override deliberately.`,
        );
      }

      const prepared = await prepareApplicationFor(
        workspace.db,
        job,
        evaluation,
        workspace.profile,
        workspace.campaign,
      );
      const { application, report, resumeCheck } = prepared;
      appendEvent(workspace.db, "application.prepared", application.id, { jobId: job.id, status: application.status });

      return ok({
        applicationId: application.id,
        status: application.status,
        packetHash: application.packetHash,
        questionSource: prepared.questionSource,
        resume: {
          ...report.resume,
          fileExists: resumeCheck.exists,
          format: resumeCheck.format,
          sizeBytes: resumeCheck.sizeBytes,
          valid: resumeCheck.ok,
          warnings: resumeCheck.warnings,
        },
        resumeBlocker: resumeCheck.ok ? undefined : resumeCheck.reason,
        matchReport: report,
        questionsNeedingHuman: prepared.outstanding,
        autoFilledAnswers: prepared.autoFilled,
        nextStep: !resumeCheck.ok
          ? `Resume unusable: ${resumeCheck.reason}. Fix the file or profile.resumes path, then run prepare_application again.`
          : prepared.outstanding.length > 0
            ? "Answer the flagged questions with set_application_content, then approve_application."
            : "Review with preview_application, then approve_application.",
      });
    }),
  );

  server.registerTool(
    "set_application_content",
    {
      title: "Set cover letter and outstanding answers",
      description:
        "Records a cover letter and answers to questions the policy engine would not fill on its own. Changing content invalidates any prior approval, because approval is bound to the packet hash.",
      inputSchema: {
        applicationId: z.string().min(1),
        coverLetter: z.string().optional(),
        answers: z
          .array(z.object({ questionKey: z.string().min(1), answer: z.string() }))
          .optional()
          .describe("Answers keyed by questionKey from prepare_application."),
        notes: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    handler(async (args: { applicationId: string; coverLetter?: string; answers?: Array<{ questionKey: string; answer: string }>; notes?: string }) => {
      const workspace = getWorkspace();
      const application = getApplication(workspace.db, args.applicationId);
      if (!application) throw new AppError("application_not_found", `no application ${args.applicationId}`);
      if (application.status === "submitted") throw new AppError("already_submitted", "cannot edit a submitted application");

      const job = getJob(workspace.db, application.jobId);
      if (!job) throw new AppError("job_not_found", `job ${application.jobId} is missing`);

      const updates = new Map((args.answers ?? []).map((entry) => [entry.questionKey, entry.answer]));
      const unknownKeys = [...updates.keys()].filter(
        (key) => !application.answers.some((answer) => answer.questionKey === key),
      );
      if (unknownKeys.length > 0) {
        throw new AppError("unknown_question_key", `unknown questionKey(s): ${unknownKeys.join(", ")}`);
      }

      const answers: DraftAnswer[] = application.answers.map((answer) =>
        updates.has(answer.questionKey)
          ? { ...answer, answer: updates.get(answer.questionKey)!, source: "human", citation: "provided via set_application_content" }
          : answer,
      );

      const updated: Application = {
        ...application,
        answers,
        coverLetter: args.coverLetter ?? application.coverLetter,
        notes: args.notes ?? application.notes,
        approvedAt: null,
        status: "awaiting_approval",
      };
      updated.packetHash = computePacketHash(buildPacket(updated, job));

      // A blank optional question asserts nothing and cannot stop the form
      // submitting, so it is reported but never holds the application. prepare
      // already worked this way; this path did not, which left applications
      // pinned at needs_human over fields like "(Optional) Personal
      // Preferences" that nobody ever intends to fill.
      const stillMissing = answers.filter(
        (answer) => answer.requiresHuman && answer.required && answer.answer.trim().length === 0,
      );
      const optionalUnanswered = answers.filter(
        (answer) => answer.requiresHuman && !answer.required && answer.answer.trim().length === 0,
      );
      if (stillMissing.length > 0) updated.status = "needs_human";

      saveApplication(workspace.db, updated);
      appendEvent(workspace.db, "application.updated", updated.id, {
        changedAnswers: [...updates.keys()],
        status: updated.status,
      });

      return ok({
        applicationId: updated.id,
        status: updated.status,
        packetHash: updated.packetHash,
        outstandingQuestions: stillMissing.map((answer) => answer.label),
        optionalUnanswered: optionalUnanswered.map((answer) => answer.label),
        note: "Approval is bound to packetHash; approve the value shown here.",
      });
    }),
  );

  server.registerTool(
    "preview_application",
    {
      title: "Preview exactly what will be submitted",
      description:
        "Renders the full submission packet - every field, its value and where the value came from - plus the packet hash to approve.",
      inputSchema: { applicationId: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: { applicationId: string }) => {
      const workspace = getWorkspace();
      const application = getApplication(workspace.db, args.applicationId);
      if (!application) throw new AppError("application_not_found", `no application ${args.applicationId}`);
      const job = getJob(workspace.db, application.jobId);
      if (!job) throw new AppError("job_not_found", `job ${application.jobId} is missing`);

      const packet = buildPacket(application, job);
      const currentHash = computePacketHash(packet);
      const questions: FormQuestion[] = application.answers.map((answer) => ({
        key: answer.questionKey,
        label: answer.label,
        required: answer.requiresHuman,
        type: "input_text",
      }));

      return okText(
        [
          renderPacketPreview(packet),
          "",
          `Status:      ${application.status}`,
          `Packet hash: ${currentHash}`,
          currentHash === application.packetHash ? "" : "WARNING: stored hash is stale; content changed since it was recorded.",
          "",
          `Unresolved required answers: ${unresolvedRequired(questions, application.answers).join("; ") || "none"}`,
          "",
          "To authorize submission, call approve_application with this exact packet hash.",
        ]
          .filter((line) => line !== "")
          .join("\n"),
      );
    }),
  );
}
