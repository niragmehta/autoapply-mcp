import { z } from "zod";

/** Per-application documents: tailored resume and cover letter PDFs. */

export const DocumentsPolicySchema = z
  .object({
    /**
     * Render a resume tailored to each posting from resume.json and attach it
     * instead of the track's fixed variant. Tailoring only reorders and selects
     * content that is already in the source; it never writes new claims.
     */
    tailorResume: z.boolean().default(false),
    /** Render the cover letter as a PDF for forms that take a file upload. */
    coverLetterPdf: z.boolean().default(false),
  })
  .prefault({});
export type DocumentsPolicy = z.infer<typeof DocumentsPolicySchema>;
