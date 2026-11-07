import { existsSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import { generateTailoredResume, renderResumeVariant } from "../../documents/resumeService.js";
import { documentStatus } from "../../documents/status.js";
import { ApplicationStatusSchema } from "../../domain/job.js";
import { displayPath, scrubHome, storedFileInside } from "../queries/files.js";
import { documentRows, tailoredDocumentFile } from "../queries/documents.js";
import { FileReply, HttpError, parseBody, parseParams, parseQuery, type Router } from "../router.js";
import { IdParams, csvList, queryInt } from "./shared.js";

/**
 * Documents: the resume each application will upload and its cover letter,
 * tailored-document history with the PDFs themselves, and rendering a track
 * variant or a tailored resume on an explicit click.
 */

const DocumentsQuery = z.object({ status: csvList(ApplicationStatusSchema), limit: queryInt(1, 500, 100) });

const TailorBody = z.object({ headline: z.string().trim().min(1).max(200).optional() }).strict();

const ResumeParams = z.object({ resumeId: z.string().trim().min(1).max(100) });

/** A document's PDF is served only from the documents folder. */
function fileHref(documentsDir: string, id: string, path: string): string | null {
  return storedFileInside(documentsDir, path, [".pdf"]) ? `/api/documents/files/${encodeURIComponent(id)}` : null;
}

type StatusReport = ReturnType<typeof documentStatus>;
type HistoryEntry = StatusReport["history"][number];

function presentEntry(documentsDir: string, entry: HistoryEntry) {
  return { ...entry, path: displayPath(entry.path), fileName: basename(entry.path), href: fileHref(documentsDir, entry.id, entry.path) };
}

function presentStatus(documentsDir: string, report: StatusReport) {
  return {
    ...report,
    nextStep: scrubHome(report.nextStep),
    resumeSource: { ...report.resumeSource, path: displayPath(report.resumeSource.path) },
    resume: {
      ...report.resume,
      path: displayPath(report.resume.path),
      fileName: report.resume.path ? basename(report.resume.path) : "",
      latest: report.resume.latest ? presentEntry(documentsDir, report.resume.latest) : null,
    },
    coverLetter: {
      ...report.coverLetter,
      pdf: report.coverLetter.pdf ? { ...presentEntry(documentsDir, report.coverLetter.pdf), matchesText: report.coverLetter.pdf.matchesText } : null,
    },
    history: report.history.map((entry) => presentEntry(documentsDir, entry)),
  };
}

export function registerRoutes(router: Router): void {
  router.get("/api/documents", (request) => {
    const query = parseQuery(DocumentsQuery, request);
    const workspace = request.ctx.workspace();
    const rows = documentRows(workspace.db, { statuses: query.status, limit: query.limit });
    return {
      policy: workspace.campaign.documents,
      resumeSource: { path: displayPath(workspace.paths.resumeSource), present: existsSync(workspace.paths.resumeSource) },
      variants: workspace.profile.resumes.map((resume) => ({
        id: resume.id,
        label: resume.label,
        fileName: basename(resume.path),
        exists: existsSync(resume.path),
      })),
      count: rows.length,
      rows,
    };
  });

  router.get("/api/documents/files/:id", (request) => {
    const { id } = parseParams(IdParams, request);
    const workspace = request.ctx.workspace();
    const stored = tailoredDocumentFile(workspace.db, id);
    const path = stored ? storedFileInside(workspace.paths.documents, stored.path, [".pdf"]) : null;
    if (!stored || !path) throw new HttpError(404, "document_not_found", "no such document file");
    return new FileReply(path, "application/pdf");
  });

  router.post("/api/documents/variants/:resumeId/render", async (request) => {
    const { resumeId } = parseParams(ResumeParams, request);
    parseBody(z.object({}).strict(), request);
    const result = await renderResumeVariant(request.ctx.workspace(), resumeId);
    return { ...result, path: displayPath(result.path), profilePath: result.profilePath ? displayPath(result.profilePath) : null };
  });

  router.get("/api/documents/:id", (request) => {
    const { id } = parseParams(IdParams, request);
    const workspace = request.ctx.workspace();
    return presentStatus(workspace.paths.documents, documentStatus(workspace, id));
  });

  /** Renders a resume tailored to the posting and makes it the application's resume; any approval is void. */
  router.post("/api/documents/:id/tailor", async (request) => {
    const { id } = parseParams(IdParams, request);
    const body = parseBody(TailorBody, request);
    const result = await generateTailoredResume(request.ctx.workspace(), id, { headline: body.headline });
    return { ...result, path: displayPath(result.path), previousResumePath: displayPath(result.previousResumePath) };
  });
}
