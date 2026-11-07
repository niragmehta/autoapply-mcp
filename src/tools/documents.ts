import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getWorkspace } from "../config/load.js";
import { coverLetterScaffold, saveCoverLetter } from "../documents/coverLetter.js";
import { generateTailoredResume, renderResumeVariant } from "../documents/resumeService.js";
import { documentStatus } from "../documents/status.js";
import { handler, ok } from "./helpers.js";

/** Per-application documents: tailored resumes and cover letter PDFs. */
export function registerDocumentTools(server: McpServer): void {
  server.registerTool(
    "tailor_resume",
    {
      title: "Tailor the resume to a posting",
      description:
        "Renders the application's resume from resume.json with bullet groups, bullets and skills reordered by relevance to the posting, dropping the least relevant bullets only when the page overflows (never one marked keep). It prints the candidate's upgrades (reserve bullets that restate a printed bullet more strongly) where they suit the posting at least as well, swaps in up to documents.maxSwaps other reserve bullets, each only where it clearly suits the posting better than the printed bullet it displaces, and adds reserve skills the posting names. Never writes or rewords content, and returns a log of every change with the posting terms behind it, plus the swaps and added skills. The verified PDF replaces the track variant on the application, which voids any approval.",
      inputSchema: {
        applicationId: z.string().min(1),
        headline: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .optional()
          .describe("A headline written only from the resume source and profile. Rejected with fact_check_failed if it names anything they do not."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    handler(async (args: { applicationId: string; headline?: string }) =>
      ok(await generateTailoredResume(getWorkspace(), args.applicationId, { headline: args.headline })),
    ),
  );

  server.registerTool(
    "cover_letter_scaffold",
    {
      title: "Lay out the evidence for a cover letter",
      description:
        "Returns the company and role, the posting's top requirements as short quotes each paired with the candidate's proof points (fact and bullet ids with their statements), the requirements nothing supports, keywords safe to mirror, a suggested structure and a word budget. Write the letter from this, then call save_cover_letter.",
      inputSchema: { applicationId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(async (args: { applicationId: string }) => ok(coverLetterScaffold(getWorkspace(), args.applicationId))),
  );

  server.registerTool(
    "save_cover_letter",
    {
      title: "Fact-check and save a cover letter",
      description:
        "Checks every figure, technology, employer, job title and date the letter claims against the resume source and profile; the posting may only supply the names of its own employer, products, teams and places. Any unsupported claim fails with fact_check_failed, listing each one. Otherwise stores the letter on the application (voiding any approval) and, when renderPdf is true or campaign.documents.coverLetterPdf is on, renders a one-page PDF in the resume's design.",
      inputSchema: {
        applicationId: z.string().min(1),
        text: z.string().min(1).max(6000).describe("The letter. Separate paragraphs with a blank line."),
        renderPdf: z.boolean().optional().describe("Render a PDF too. Defaults to campaign.documents.coverLetterPdf."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    handler(async (args: { applicationId: string; text: string; renderPdf?: boolean }) =>
      ok(await saveCoverLetter(getWorkspace(), args.applicationId, args.text, { renderPdf: args.renderPdf })),
    ),
  );

  server.registerTool(
    "render_resume_variant",
    {
      title: "Rebuild a fixed resume variant",
      description:
        "Renders a track's fixed resume variant from resume.json into the documents/variants folder and verifies it (one page unless resume.json allows two, every bullet present, no ligatures or broken terms). Point profile.resumes at the file to upload it.",
      inputSchema: { resumeId: z.string().min(1).describe("A variant key in resume.json, normally a profile.resumes id.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(async (args: { resumeId: string }) => ok(await renderResumeVariant(getWorkspace(), args.resumeId))),
  );

  server.registerTool(
    "document_status",
    {
      title: "Show an application's documents",
      description:
        "Shows which resume the application will upload and whether it is tailored, the cover letter and whether its PDF matches the current text, and every document generated for it.",
      inputSchema: { applicationId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(async (args: { applicationId: string }) => ok(documentStatus(getWorkspace(), args.applicationId))),
  );
}
