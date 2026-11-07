import { basename } from "node:path";
import { z } from "zod";
import { listTailoredDocuments } from "../../db/repositories/documents.js";
import { loadApplicationContext, setApplicationContent } from "../../services/applications.js";
import { AppError } from "../../util/errors.js";
import { scrubHome, storedFileInside } from "../queries/files.js";
import { checkLetter } from "../queries/letterCheck.js";
import { parseBody, parseParams, type Router } from "../router.js";
import { IdParams } from "./shared.js";

/**
 * The application workspace before submission: the cover letter, answers and
 * notes saved through setApplicationContent, a fact check of the letter, and
 * the history of tailored resumes with every change each one made. Approval
 * is bound to the packet hash, so any saved change voids it.
 */

const ContentBody = z
  .object({
    coverLetter: z.string().max(50_000).optional(),
    answers: z
      .array(z.object({ questionKey: z.string().min(1).max(300), answer: z.string().max(20_000) }).strict())
      .max(200)
      .optional(),
    notes: z.string().max(20_000).optional(),
  })
  .strict()
  .refine((body) => body.coverLetter !== undefined || body.answers !== undefined || body.notes !== undefined, {
    message: "send coverLetter, answers or notes",
  });

const CheckBody = z.object({ text: z.string().trim().min(1).max(50_000) }).strict();

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function registerRoutes(router: Router): void {
  router.post("/api/applications/:id/content", (request) => {
    const { id } = parseParams(IdParams, request);
    const body = parseBody(ContentBody, request);
    const workspace = request.ctx.workspace();
    const { application, job } = loadApplicationContext(workspace, id);
    if (application.status === "skipped") {
      // Saving would quietly put a skipped application back in line for approval.
      throw new AppError("application_skipped", "this application is skipped; prepare the job again to work on it");
    }
    const saved = setApplicationContent(workspace, { applicationId: id, coverLetter: body.coverLetter, answers: body.answers, notes: body.notes });
    const letter = body.coverLetter?.trim() ?? "";
    return {
      ...saved,
      approvalVoided: application.status === "approved",
      factCheck: letter ? checkLetter(workspace, job, letter) : null,
    };
  });

  /** The same fact check, without saving anything. */
  router.post("/api/applications/:id/cover-letter/check", (request) => {
    const { id } = parseParams(IdParams, request);
    const body = parseBody(CheckBody, request);
    const workspace = request.ctx.workspace();
    const { job } = loadApplicationContext(workspace, id);
    return checkLetter(workspace, job, body.text);
  });

  /** Every tailored resume for the application, newest first, with the full change log stored with it. */
  router.get("/api/applications/:id/tailoring", (request) => {
    const { id } = parseParams(IdParams, request);
    const workspace = request.ctx.workspace();
    const { application } = loadApplicationContext(workspace, id);
    const entries = listTailoredDocuments(workspace.db, application.id, "resume").map((document) => {
      const headline = document.checks.headline as { text?: unknown } | undefined;
      return {
        id: document.id,
        createdAt: document.createdAt,
        variantId: document.variantId,
        fileName: basename(document.path),
        href: storedFileInside(workspace.paths.documents, document.path, [".pdf"]) ? `/api/documents/files/${encodeURIComponent(document.id)}` : null,
        current: document.path === application.resumePath,
        pages: typeof document.checks.pages === "number" ? document.checks.pages : null,
        headline: typeof headline?.text === "string" ? headline.text : null,
        dropped: asStrings(document.checks.dropped),
        warnings: asStrings(document.checks.warnings).map((warning) => scrubHome(warning)),
        changes: document.changes,
      };
    });
    return {
      applicationId: application.id,
      resumeId: application.resumeId,
      resumeFile: basename(application.resumePath),
      tailored: entries.some((entry) => entry.current),
      policy: workspace.campaign.documents,
      entries,
    };
  });
}
