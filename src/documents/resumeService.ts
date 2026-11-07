import { join } from "node:path";
import type { Workspace } from "../config/load.js";
import { saveApplication } from "../db/repositories/applications.js";
import { insertTailoredDocument } from "../db/repositories/documents.js";
import { appendEvent } from "../db/repositories/events.js";
import type { Application, ApplicationStatus, Job } from "../domain/job.js";
import { buildPacket, loadApplicationContext } from "../services/applications.js";
import { computePacketHash } from "../submission/packet.js";
import { AppError } from "../util/errors.js";
import { fontWarnings, loadFonts, type FontSet } from "./fonts.js";
import { applyVariant, placedBullets, type ResumeDocument } from "./model.js";
import { sha256Bytes, withPdfRenderer, writePdf, type PdfRenderer } from "./render.js";
import { loadResumeSource, stripMetricMarkers, type ResumeSource } from "./resumeSource.js";
import { tailorResume, type TailorChange, type TailoredResume } from "./tailor.js";
import { renderResumeHtml } from "./templates/resume.js";
import { keepWholeTerms } from "./templates/shared.js";
import { countPdfPages, verifyPdf, type PdfExpectations, type PdfVerification } from "./verifyPdf.js";

/**
 * Resume documents for applications: the per-posting tailored resume and the
 * fixed track variants, rendered from resume.json and verified before use.
 */

/** What a rendered resume must contain, as the PDF's text layer shows it. */
export function resumeExpectations(document: ResumeDocument): PdfExpectations {
  const bullets = placedBullets(document).map(({ bullet }) => stripMetricMarkers(bullet.text));
  const skills = document.skills.flatMap((category) => category.terms);
  return {
    maxPages: document.maxPages,
    texts: [document.header.name, ...(document.header.headline ? [document.header.headline] : []), ...bullets, ...skills],
    terms: [...bullets, ...skills].flatMap(keepWholeTerms),
  };
}

function verificationError(what: string, verification: PdfVerification): AppError {
  return new AppError(
    "document_verification_failed",
    `${what} failed verification: ${verification.issues.map((issue) => issue.detail).join("; ")}`,
    { issues: verification.issues },
  );
}

type Fitted = { tailored: TailoredResume; bytes: Buffer; pages: number; attempts: number };

/**
 * Renders the tailored resume, dropping the least relevant bullet one at a
 * time while it overflows the page budget, until it fits or nothing more may go.
 */
async function renderFitted(
  renderer: PdfRenderer,
  render: (dropBullets: number) => TailoredResume,
  fonts: FontSet,
): Promise<Fitted> {
  const attempt = async (drop: number): Promise<Fitted> => {
    const tailored = render(drop);
    const bytes = await renderer.render(renderResumeHtml(tailored.document, fonts), tailored.document.theme.pageSize);
    const pages = countPdfPages(bytes);
    if (pages <= tailored.document.maxPages || drop >= tailored.droppable.length) return { tailored, bytes, pages, attempts: drop + 1 };
    return attempt(drop + 1);
  };
  return attempt(0);
}

/**
 * The application with new content: any approval is void, and the status is
 * recomputed the way set_application_content does it.
 */
export function withChangedContent(application: Application, job: Pick<Job, "companyName" | "title" | "applyUrl">, changes: Partial<Application>): Application {
  const next: Application = { ...application, ...changes, approvedAt: null };
  const kept: ReadonlySet<ApplicationStatus> = new Set(["skipped", "failed"]);
  const missing = next.answers.some((answer) => answer.requiresHuman && answer.required && answer.answer.trim().length === 0);
  const status: ApplicationStatus = kept.has(application.status) ? application.status : missing ? "needs_human" : "awaiting_approval";
  const updated = { ...next, status };
  return { ...updated, packetHash: computePacketHash(buildPacket(updated, job)) };
}

type TailoredResumeResult = {
  applicationId: string;
  documentId: string;
  path: string;
  sha256: string;
  bytes: number;
  pages: number;
  variantId: string;
  headline: TailoredResume["headline"];
  status: ApplicationStatus;
  packetHash: string;
  previousResumePath: string;
  approvalVoided: boolean;
  changes: TailorChange[];
  swaps: TailoredResume["swaps"];
  addedSkills: string[];
  dropped: string[];
  jobTerms: TailoredResume["jobTerms"];
  checks: PdfVerification;
  warnings: string[];
};

/**
 * Renders a resume tailored to the application's posting, verifies it, stores
 * it under documents/<applicationId>/ and makes it the application's resume.
 * The packet hash changes with the file, so an approval is void.
 */
export async function generateTailoredResume(
  workspace: Workspace,
  applicationId: string,
  options: { headline?: string } = {},
): Promise<TailoredResumeResult> {
  const { application, job } = loadApplicationContext(workspace, applicationId);
  if (application.status === "submitted") throw new AppError("already_submitted", "cannot change the resume of a submitted application");
  const source: ResumeSource = loadResumeSource(workspace.paths);
  const fonts = loadFonts(workspace.paths.fonts);
  const { minBulletsPerRole, maxSwaps, maxAddedSkills } = workspace.campaign.documents;
  const tailorOptions = { minBulletsPerRole, maxSwaps, maxAddedSkills, headline: options.headline };
  // Tailor once up front so a headline that fails the fact check stops before Chromium starts.
  tailorResume(source, application.resumeId, job, workspace.profile, tailorOptions);

  const fitted = await withPdfRenderer((renderer) =>
    renderFitted(
      renderer,
      (dropBullets) => tailorResume(source, application.resumeId, job, workspace.profile, { ...tailorOptions, dropBullets }),
      fonts,
    ),
  );
  const checks = await verifyPdf(fitted.bytes, resumeExpectations(fitted.tailored.document));
  if (!checks.ok) throw verificationError("the tailored resume", checks);

  const sha256 = sha256Bytes(fitted.bytes);
  const written = writePdf(join(workspace.paths.documents, application.id, `resume-${sha256.slice(0, 8)}.pdf`), fitted.bytes);
  const warnings = [...fontWarnings(fonts), ...checks.warnings];
  const stored = insertTailoredDocument(workspace.db, {
    applicationId: application.id,
    kind: "resume",
    path: written.path,
    sha256,
    variantId: application.resumeId,
    changes: fitted.tailored.changes,
    checks: { ...checks, warnings, dropped: fitted.tailored.dropped, renders: fitted.attempts, headline: fitted.tailored.headline },
  });
  const updated = withChangedContent(application, job, { resumePath: written.path });
  saveApplication(workspace.db, updated);
  appendEvent(workspace.db, "document.resume_tailored", application.id, {
    documentId: stored.id,
    sha256,
    variantId: application.resumeId,
    pages: checks.pages,
    changes: fitted.tailored.changes.length,
    dropped: fitted.tailored.dropped.length,
  });

  return {
    applicationId: application.id,
    documentId: stored.id,
    path: written.path,
    sha256,
    bytes: written.bytes,
    pages: checks.pages,
    variantId: application.resumeId,
    headline: fitted.tailored.headline,
    status: updated.status,
    packetHash: updated.packetHash,
    previousResumePath: application.resumePath,
    approvalVoided: application.status === "approved",
    changes: fitted.tailored.changes,
    swaps: fitted.tailored.swaps,
    addedSkills: fitted.tailored.addedSkills,
    dropped: fitted.tailored.dropped,
    jobTerms: fitted.tailored.jobTerms,
    checks,
    warnings,
  };
}

type VariantRenderResult = {
  resumeId: string;
  path: string;
  sha256: string;
  bytes: number;
  pages: number;
  variantFound: boolean;
  profilePath: string | null;
  usedByProfile: boolean;
  checks: PdfVerification;
  warnings: string[];
  nextStep: string;
};

const SAFE_FILE_NAME = /[^A-Za-z0-9._-]/g;

function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/").toLowerCase();
  return normalize(a) === normalize(b);
}

/**
 * Rebuilds a fixed track variant from resume.json into documents/variants/.
 * A variant is the candidate's curated selection, so nothing is dropped to
 * fit: one that overflows fails verification and nothing is written.
 */
export async function renderResumeVariant(workspace: Workspace, resumeId: string): Promise<VariantRenderResult> {
  const source = loadResumeSource(workspace.paths);
  const profileEntry = workspace.profile.resumes.find((resume) => resume.id === resumeId) ?? null;
  const { document, variantFound } = applyVariant(source, resumeId);
  if (!variantFound && !profileEntry) {
    throw new AppError(
      "unknown_resume",
      `no variant "${resumeId}" in resume.json and no profile.resumes entry with that id (variants: ${Object.keys(source.variants).join(", ") || "none"})`,
    );
  }
  const fonts = loadFonts(workspace.paths.fonts);
  const bytes = await withPdfRenderer((renderer) => renderer.render(renderResumeHtml(document, fonts), document.theme.pageSize));
  const checks = await verifyPdf(bytes, resumeExpectations(document));
  if (!checks.ok) throw verificationError(`variant "${resumeId}"`, checks);

  const written = writePdf(join(workspace.paths.documents, "variants", `${resumeId.replace(SAFE_FILE_NAME, "_")}.pdf`), bytes);
  const usedByProfile = profileEntry ? samePath(profileEntry.path, written.path) : false;
  const warnings = [
    ...fontWarnings(fonts),
    ...checks.warnings,
    ...(variantFound ? [] : [`resume.json has no variant "${resumeId}"; rendered the source order`]),
  ];
  appendEvent(workspace.db, "document.variant_rendered", resumeId, { sha256: written.sha256, pages: checks.pages });
  return {
    resumeId,
    path: written.path,
    sha256: written.sha256,
    bytes: written.bytes,
    pages: checks.pages,
    variantFound,
    profilePath: profileEntry?.path ?? null,
    usedByProfile,
    checks,
    warnings,
    nextStep: usedByProfile
      ? "profile.resumes already points at this file; new applications upload it."
      : `To upload this file for the "${resumeId}" track, set its profile.resumes path to ${written.path}.`,
  };
}
