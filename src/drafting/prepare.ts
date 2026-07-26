import type { Campaign } from "../domain/campaign.js";
import type { Application, Evaluation, Job } from "../domain/job.js";
import type { Profile } from "../domain/profile.js";
import type { Db } from "../db/database.js";
import { getApplicationByJob, saveApplication } from "../db/repositories/applications.js";
import { fetchGreenhouseJobDetail } from "../sources/greenhouse.js";
import { computePacketHash } from "../submission/packet.js";
import { validateResumeFile, type ResumeCheck } from "../submission/resume.js";
import { AppError, toErrorMessage } from "../util/errors.js";
import { newId, nowIso } from "../util/hash.js";
import { logger } from "../util/logger.js";
import { draftAnswers, type FormQuestion } from "./answers.js";
import { buildMatchReport, selectResume, type MatchReport } from "./matchReport.js";
import { defaultQuestionSet, greenhouseQuestionsToForm } from "./questions.js";

/**
 * Shared application preparation.
 *
 * Both the single-job tool and the batch tool run through here, so a batch can
 * never take a shortcut that the reviewed single path does not also take.
 */

export type PreparedApplication = {
  application: Application;
  report: MatchReport;
  resumeCheck: ResumeCheck;
  questionSource: string;
  outstanding: Array<{ key: string; label: string; category: string; suggested: string }>;
  autoFilled: Array<{ key: string; label: string; answer: string; citation: string }>;
};

async function loadQuestions(
  ats: string,
  board: string,
  externalId: string,
): Promise<{ questions: FormQuestion[]; source: string }> {
  if (ats !== "greenhouse") {
    return { questions: defaultQuestionSet(), source: "baseline (board does not publish a question schema)" };
  }
  try {
    const detail = await fetchGreenhouseJobDetail(board, externalId);
    const questions = greenhouseQuestionsToForm([...detail.questions, ...detail.compliance]);
    return questions.length > 0
      ? { questions, source: "greenhouse job board API" }
      : { questions: defaultQuestionSet(), source: "baseline (empty question set returned)" };
  } catch (error) {
    logger.warn("greenhouse question fetch failed", { error: toErrorMessage(error) });
    return { questions: defaultQuestionSet(), source: `baseline (question fetch failed: ${toErrorMessage(error)})` };
  }
}

export async function prepareApplicationFor(
  db: Db,
  job: Job,
  evaluation: Evaluation,
  profile: Profile,
  campaign: Campaign,
): Promise<PreparedApplication> {
  const existing = getApplicationByJob(db, job.id);
  if (existing && existing.status === "submitted") {
    throw new AppError("already_submitted", `this job was already submitted at ${existing.submittedAt}`);
  }

  const report = buildMatchReport(job, evaluation, profile, campaign);
  const resume = selectResume(profile, evaluation.trackId);
  const resumeCheck = validateResumeFile(resume.path);

  const { questions, source } = await loadQuestions(job.ats, job.board, job.externalId);

  // Narrative templates are filled from this specific posting, using only the
  // topics the profile genuinely supports.
  const narrativeContext = {
    company: job.companyName,
    role: job.title,
    location: job.locationsRaw[0] ?? job.locationClass,
    topics: report.matchedKeywords
      .map((entry) => entry.term)
      .filter((term) => !report.claimsToAvoid.includes(term)),
  };
  const drafted = draftAnswers(questions, profile, campaign, narrativeContext);

  const application: Application = {
    id: existing?.id ?? newId("app"),
    jobId: job.id,
    status: drafted.blockedQuestions.length > 0 || !resumeCheck.ok ? "needs_human" : "awaiting_approval",
    resumeId: resume.id,
    resumePath: resume.path,
    packetHash: "",
    coverLetter: existing?.coverLetter ?? "",
    answers: drafted.answers,
    blockedQuestions: drafted.blockedQuestions,
    createdAt: existing?.createdAt ?? nowIso(),
    approvedAt: null,
    submittedAt: null,
    submissionMode: null,
    confirmationRef: null,
    artifactPath: null,
    notes: existing?.notes ?? "",
  };

  application.packetHash = computePacketHash({
    jobId: application.jobId,
    company: job.companyName,
    jobTitle: job.title,
    applyUrl: job.applyUrl,
    resumeId: application.resumeId,
    resumePath: application.resumePath,
    coverLetter: application.coverLetter,
    answers: application.answers,
  });

  saveApplication(db, application);

  return {
    application,
    report,
    resumeCheck,
    questionSource: source,
    outstanding: drafted.answers
      .filter((answer) => answer.requiresHuman)
      .map((answer) => ({
        key: answer.questionKey,
        label: answer.label,
        category: answer.category,
        suggested: answer.answer,
      })),
    autoFilled: drafted.answers
      .filter((answer) => !answer.requiresHuman)
      .map((answer) => ({
        key: answer.questionKey,
        label: answer.label,
        answer: answer.answer,
        citation: answer.citation,
      })),
  };
}
