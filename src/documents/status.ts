import { existsSync } from "node:fs";
import type { Workspace } from "../config/load.js";
import { listTailoredDocuments, type TailoredDocument } from "../db/repositories/documents.js";
import { loadApplicationContext } from "../services/applications.js";
import { sha256 } from "../util/hash.js";

/** Where an application's documents stand: which resume it will upload, and its letter. */

function summary(document: TailoredDocument) {
  return {
    id: document.id,
    kind: document.kind,
    path: document.path,
    sha256: document.sha256,
    variantId: document.variantId,
    createdAt: document.createdAt,
    exists: existsSync(document.path),
    changes: document.changes.length,
    pages: typeof document.checks.pages === "number" ? document.checks.pages : null,
  };
}

export function documentStatus(workspace: Workspace, applicationId: string) {
  const { application } = loadApplicationContext(workspace, applicationId);
  const history = listTailoredDocuments(workspace.db, application.id);
  const latestResume = history.find((document) => document.kind === "resume") ?? null;
  const latestLetter = history.find((document) => document.kind === "cover-letter") ?? null;
  const letter = application.coverLetter.trim();
  const tailored = latestResume !== null && latestResume.path === application.resumePath;
  const sourcePresent = existsSync(workspace.paths.resumeSource);
  const letterPdfCurrent = latestLetter !== null && letter.length > 0 && latestLetter.checks.textSha256 === sha256(letter);
  const policy = workspace.campaign.documents;

  const nextStep = !sourcePresent
    ? `No resume source at ${workspace.paths.resumeSource}; copy examples/resume.example.json there to tailor resumes.`
    : !tailored
      ? "Run tailor_resume to render a resume for this posting."
      : letter.length === 0
        ? "Write a cover letter from cover_letter_scaffold and save it with save_cover_letter."
        : "Review with preview_application, then approve_application.";

  return {
    applicationId: application.id,
    status: application.status,
    policy,
    resumeSource: { path: workspace.paths.resumeSource, present: sourcePresent },
    resume: {
      resumeId: application.resumeId,
      path: application.resumePath,
      exists: application.resumePath.length > 0 && existsSync(application.resumePath),
      tailored,
      latest: latestResume ? summary(latestResume) : null,
    },
    coverLetter: {
      present: letter.length > 0,
      words: letter.length > 0 ? letter.split(/\s+/).length : 0,
      pdf: latestLetter ? { ...summary(latestLetter), matchesText: letterPdfCurrent } : null,
    },
    history: history.map(summary),
    nextStep,
  };
}
