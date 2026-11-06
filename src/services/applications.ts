import { join } from "node:path";
import type { Workspace } from "../config/load.js";
import {
  countSubmittedSince,
  getApplication,
  lastSubmissionAt,
  latestApproval,
  recordApproval,
  saveApplication,
} from "../db/repositories/applications.js";
import { appendEvent } from "../db/repositories/events.js";
import { applicationCountsByCompany, getEvaluation, getJob } from "../db/repositories/jobs.js";
import type { Application, DraftAnswer, Job } from "../domain/job.js";
import { unresolvedRequired, type FormQuestion } from "../drafting/answers.js";
import { prepareApplicationFor } from "../drafting/prepare.js";
import { runApplicationForm, type BrowserRunResult } from "../submission/browser.js";
import { mergeDiscoveredQuestions } from "../submission/discoveredQuestions.js";
import { experienceResolverFor } from "../submission/experienceResolver.js";
import { checkSubmissionAllowed, startOfDayIso } from "../submission/guards.js";
import { narrativeResolverFor } from "../submission/narrativeResolver.js";
import { computePacketHash, renderPacketPreview, type SubmissionPacket } from "../submission/packet.js";
import { personalResolverFor } from "../submission/personalResolver.js";
import { isWorkdayUrl } from "../submission/workdayFlow.js";
import { AppError } from "../util/errors.js";
import { newId, nowIso } from "../util/hash.js";

/**
 * The single-application lifecycle: prepare, edit, preview, approve, submit.
 *
 * MCP tools, the batch tools, the run queue and the dashboard all drive
 * applications through these functions, so every caller gets the same guards
 * and records the same events. Nothing here formats for a particular caller.
 */

export type SubmissionMode = "manual" | "assisted" | "auto";

export function buildPacket(application: Application, job: Pick<Job, "companyName" | "title" | "applyUrl">): SubmissionPacket {
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

export type ApplicationContext = {
  application: Application;
  job: Job;
  packet: SubmissionPacket;
  currentHash: string;
};

/** Loads an application with its job and current packet hash, failing clearly when either is missing. */
export function loadApplicationContext(workspace: Workspace, applicationId: string): ApplicationContext {
  const application = getApplication(workspace.db, applicationId);
  if (!application) throw new AppError("application_not_found", `no application ${applicationId}`);
  const job = getJob(workspace.db, application.jobId);
  if (!job) throw new AppError("job_not_found", `job ${application.jobId} is missing`);
  const packet = buildPacket(application, job);
  return { application, job, packet, currentHash: computePacketHash(packet) };
}

export type PrepareInput = { jobId: string; force?: boolean; resumeId?: string };

export async function prepareApplication(workspace: Workspace, input: PrepareInput) {
  const job = getJob(workspace.db, input.jobId);
  if (!job) throw new AppError("job_not_found", `no job stored with id ${input.jobId}`);

  const evaluation = getEvaluation(workspace.db, input.jobId);
  if (!evaluation) throw new AppError("not_evaluated", "run discover_jobs before preparing an application");
  if (evaluation.decision !== "accept" && input.force !== true) {
    throw new AppError(
      "job_not_accepted",
      `job was ${evaluation.decision} (${evaluation.gate.rule ?? "score below threshold"}: ${evaluation.gate.reason}). Pass force=true to override deliberately.`,
    );
  }

  // A ceiling only meant per batch would be bypassed by preparing one job at a
  // time, which is the normal way this is used.
  const cap = workspace.campaign.submission.maxPerCompany;
  const held = applicationCountsByCompany(workspace.db).get(job.companyName.toLowerCase()) ?? 0;
  if (held >= cap && input.force !== true) {
    throw new AppError(
      "company_cap_reached",
      `${job.companyName} already has ${held} application${held === 1 ? "" : "s"}, at the campaign ceiling of ${cap} per company. Withdraw one, raise submission.maxPerCompany, or pass force=true to override deliberately.`,
    );
  }

  const prepared = await prepareApplicationFor(workspace.db, job, evaluation, workspace.profile, workspace.campaign, {
    resumeId: input.resumeId,
  });
  const { application, report, resumeCheck } = prepared;
  appendEvent(workspace.db, "application.prepared", application.id, { jobId: job.id, status: application.status });

  return {
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
  };
}

export type ContentInput = {
  applicationId: string;
  coverLetter?: string;
  answers?: Array<{ questionKey: string; answer: string }>;
  notes?: string;
};

/** Records a cover letter and human answers. Any change voids a prior approval. */
export function setApplicationContent(workspace: Workspace, input: ContentInput) {
  const application = getApplication(workspace.db, input.applicationId);
  if (!application) throw new AppError("application_not_found", `no application ${input.applicationId}`);
  if (application.status === "submitted") throw new AppError("already_submitted", "cannot edit a submitted application");

  const job = getJob(workspace.db, application.jobId);
  if (!job) throw new AppError("job_not_found", `job ${application.jobId} is missing`);

  const updates = new Map((input.answers ?? []).map((entry) => [entry.questionKey, entry.answer]));
  const unknownKeys = [...updates.keys()].filter((key) => !application.answers.some((answer) => answer.questionKey === key));
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
    coverLetter: input.coverLetter ?? application.coverLetter,
    notes: input.notes ?? application.notes,
    approvedAt: null,
    status: "awaiting_approval",
  };
  updated.packetHash = computePacketHash(buildPacket(updated, job));

  // A blank optional question asserts nothing and cannot stop the form
  // submitting, so it is reported but never holds the application. Without
  // this, applications stayed pinned at needs_human over fields like
  // "(Optional) Personal Preferences" that nobody ever intends to fill.
  const stillMissing = answers.filter((answer) => answer.requiresHuman && answer.required && answer.answer.trim().length === 0);
  const optionalUnanswered = answers.filter(
    (answer) => answer.requiresHuman && !answer.required && answer.answer.trim().length === 0,
  );
  if (stillMissing.length > 0) updated.status = "needs_human";

  saveApplication(workspace.db, updated);
  appendEvent(workspace.db, "application.updated", updated.id, { changedAnswers: [...updates.keys()], status: updated.status });

  return {
    applicationId: updated.id,
    status: updated.status,
    packetHash: updated.packetHash,
    outstandingQuestions: stillMissing.map((answer) => answer.label),
    optionalUnanswered: optionalUnanswered.map((answer) => answer.label),
    note: "Approval is bound to packetHash; approve the value shown here.",
  };
}

export type ApplicationPreview = {
  applicationId: string;
  status: Application["status"];
  packetHash: string;
  storedHashStale: boolean;
  unresolvedRequired: string[];
  /** The full human-readable packet, exactly as preview_application shows it. */
  text: string;
};

export function previewApplication(workspace: Workspace, applicationId: string): ApplicationPreview {
  const { application, packet, currentHash } = loadApplicationContext(workspace, applicationId);
  const questions: FormQuestion[] = application.answers.map((answer) => ({
    key: answer.questionKey,
    label: answer.label,
    required: answer.requiresHuman && answer.required,
    type: "input_text",
  }));
  const unresolved = unresolvedRequired(questions, application.answers);
  const stale = currentHash !== application.packetHash;
  const text = [
    renderPacketPreview(packet),
    "",
    `Status:      ${application.status}`,
    `Packet hash: ${currentHash}`,
    stale ? "WARNING: stored hash is stale; content changed since it was recorded." : "",
    "",
    `Unresolved required answers: ${unresolved.join("; ") || "none"}`,
    "",
    "To authorize submission, call approve_application with this exact packet hash.",
  ]
    .filter((line) => line !== "")
    .join("\n");
  return {
    applicationId: application.id,
    status: application.status,
    packetHash: currentHash,
    storedHashStale: stale,
    unresolvedRequired: unresolved,
    text,
  };
}

export type ApprovalInput = {
  applicationId: string;
  packetHash: string;
  decision?: "approved" | "rejected";
  note?: string;
};

/** Records the human decision bound to the exact packet hash that was reviewed. */
export function approveApplication(workspace: Workspace, input: ApprovalInput) {
  const { application, currentHash } = loadApplicationContext(workspace, input.applicationId);
  const decision = input.decision ?? "approved";

  if (input.packetHash !== currentHash) {
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
    note: input.note ?? "",
  });

  const updated = {
    ...application,
    packetHash: currentHash,
    status: decision === "approved" ? ("approved" as const) : ("skipped" as const),
    approvedAt: decision === "approved" ? nowIso() : null,
  };
  saveApplication(workspace.db, updated);
  appendEvent(workspace.db, "application.approval", application.id, { decision, packetHash: currentHash });

  return {
    applicationId: application.id,
    decision,
    status: updated.status,
    packetHash: currentHash,
    nextStep: decision === "approved" ? "Call submit_application." : "No further action; application skipped.",
  };
}

export type SubmitInput = {
  applicationId: string;
  mode?: SubmissionMode;
  headless?: boolean;
  keepOpenSeconds?: number;
  verificationCode?: string;
  waitForCodeSeconds?: number;
};

export type SubmitOutcome =
  | { kind: "manual"; applicationId: string; mode: "manual"; packetText: string }
  | {
      kind: "browser";
      applicationId: string;
      mode: SubmissionMode;
      result: BrowserRunResult;
      nextStep: string;
    };

/**
 * Re-checks every submission guard, then acts according to mode. Throws an
 * AppError carrying the guard's code when submission is not allowed; the
 * `pacing` code's message names how long to wait.
 */
export async function submitApplication(workspace: Workspace, input: SubmitInput): Promise<SubmitOutcome> {
  const { application, job, packet, currentHash } = loadApplicationContext(workspace, input.applicationId);
  const mode = input.mode ?? "manual";
  const approval = latestApproval(workspace.db, application.id);

  const guard = checkSubmissionAllowed({
    application: { ...application, packetHash: currentHash },
    job,
    campaign: workspace.campaign,
    approval,
    submittedToday: countSubmittedSince(workspace.db, startOfDayIso()),
    companyApplicationCount: applicationCountsByCompany(workspace.db).get(job.companyName.toLowerCase()) ?? 0,
    lastSubmissionAt: lastSubmissionAt(workspace.db),
    requestedMode: mode,
  });

  if (!guard.allowed) {
    appendEvent(workspace.db, "submission.blocked", application.id, { code: guard.code, mode });
    throw new AppError(guard.code, guard.reason, { applicationId: application.id, mode, waitSeconds: guard.waitSeconds });
  }

  if (mode === "manual") {
    appendEvent(workspace.db, "submission.manual_packet", application.id, { applyUrl: job.applyUrl });
    return {
      kind: "manual",
      applicationId: application.id,
      mode,
      packetText: [
        "Submission guards passed. This packet is ready for you to submit by hand.",
        "",
        `Apply URL: ${job.applyUrl}`,
        "",
        renderPacketPreview(packet),
        "",
        "After submitting, call record_submission with the confirmation reference.",
      ].join("\n"),
    };
  }

  const result = await runApplicationForm(packet, {
    submit: mode === "auto",
    headless: mode === "assisted" ? false : input.headless ?? true,
    artifactsDir: workspace.paths.artifacts,
    policy: workspace.campaign.submission,
    candidateCountry: workspace.profile.identity.location.country,
    answerBank: workspace.profile.answers,
    personalResolver: personalResolverFor(workspace.profile),
    experienceResolver: experienceResolverFor(workspace.profile),
    narrativeResolver: narrativeResolverFor(job, getEvaluation(workspace.db, job.id), workspace.profile, workspace.campaign),
    accountEmail: workspace.profile.identity.email,
    relocationTargets: workspace.profile.preferences.relocationTargets,
    // Registering on an employer's tenant is a bigger step than filling a
    // public form, so it is only done when a person is watching the window.
    // Workday is the exception: it has no anonymous apply path at all, so
    // refusing to register there is refusing to apply.
    allowAccountCreation: mode === "assisted" || isWorkdayUrl(job.applyUrl),
    keepOpenMs: mode === "assisted" ? (input.keepOpenSeconds ?? 240) * 1000 : 0,
    verificationCode: input.verificationCode,
    codeWaitMs: (input.waitForCodeSeconds ?? 0) * 1000,
    codeFilePath: join(workspace.paths.artifacts, `${application.id}.code`),
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
      answers: mergeDiscoveredQuestions(application.answers, result.unmatchedRequired, workspace.profile.answers),
      notes: `${application.notes}\n[${nowIso()}] aborted: ${result.reason}`.trim(),
      artifactPath: result.screenshotPath,
    });
    appendEvent(workspace.db, "submission.aborted", application.id, { mode, reason: result.reason });
  } else {
    appendEvent(workspace.db, "submission.prepared", application.id, { mode, finalUrl: result.finalUrl });
  }

  return {
    kind: "browser",
    applicationId: application.id,
    mode,
    result,
    nextStep:
      result.status === "submitted"
        ? "Submitted. Track the outcome with record_outcome."
        : result.status === "prepared"
          ? "Form filled. Review the open window or the screenshot, submit, then call record_submission."
          : "Blocked. Resolve the reason above; this application needs a human.",
  };
}

export type RecordSubmissionInput = { applicationId: string; confirmationRef?: string; notes?: string };

/** Marks an application submitted after a person sent it, so counts, pacing and duplicate checks stay accurate. */
export function recordManualSubmission(workspace: Workspace, input: RecordSubmissionInput) {
  const { application, currentHash } = loadApplicationContext(workspace, input.applicationId);
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
    confirmationRef: input.confirmationRef ?? null,
    notes: input.notes ?? application.notes,
  });
  appendEvent(workspace.db, "submission.recorded", application.id, { submittedAt });
  return { applicationId: application.id, status: "submitted" as const, submittedAt };
}
