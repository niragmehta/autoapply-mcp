import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PROMPT_GROUND_RULES, userPrompt } from "./helpers.js";

/** Guided tailoring of the resume and the cover letter for one application. */

function tailorDocumentsText(applicationId: string): string {
  const id = JSON.stringify(applicationId);
  return [
    `Tailor the documents for application ${id}.`,
    "",
    `1. Call tailor_resume with applicationId ${id}. Read its changes log: check that the moves suit this posting and that nothing important was dropped. If the result looks wrong, say so instead of forcing it.`,
    "2. Optionally propose a sharper headline, using only titles and wording from the resume source and profile, and call tailor_resume again with it. If it fails with fact_check_failed, drop the flagged words; do not retry variations of the same claim.",
    `3. Call cover_letter_scaffold with applicationId ${id} and write the letter from it:`,
    "   - follow its structure and word budget; the letter fits on one page;",
    "   - build the middle from its requirements and their proof points, keeping every figure and name exactly as the proof states it;",
    "   - mirror a posting keyword only when keywordsToMirror lists it, and never claim anything in gaps or keywordsNotSupported;",
    "   - no cliches, no flattery, no filler openers: plain, specific sentences;",
    "   - separate paragraphs with a blank line.",
    "4. Call save_cover_letter with the text (renderPdf true when the form takes a cover letter file). If it fails with fact_check_failed, correct or remove exactly the flagged claims and save again.",
    `5. Call preview_application for ${id} and show the candidate the packet, the resume changes and the letter. Approval is theirs: do not call approve_application unless they ask.`,
    "",
    PROMPT_GROUND_RULES,
  ].join("\n");
}

export function registerDocumentPrompts(server: McpServer): void {
  server.registerPrompt(
    "tailor_application_documents",
    {
      title: "Tailor the resume and write the cover letter",
      description: "Tailors the resume to one application's posting, writes a fact-checked cover letter and previews the packet.",
      argsSchema: { applicationId: z.string().min(1).describe("Application id from prepare_application.") },
    },
    ({ applicationId }) => userPrompt(tailorDocumentsText(applicationId)),
  );
}
