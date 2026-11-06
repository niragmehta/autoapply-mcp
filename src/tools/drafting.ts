import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getWorkspace } from "../config/load.js";
import { prepareApplication, previewApplication, setApplicationContent } from "../services/applications.js";
import { handler, ok, okText } from "./helpers.js";

/** Tools that assemble a single application without sending anything. */

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
        resumeId: z
          .string()
          .min(1)
          .optional()
          .describe("Resume variant id from profile.resumes to use instead of the matched track's own variant."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    handler(async (args: { jobId: string; force?: boolean; resumeId?: string }) =>
      ok(await prepareApplication(getWorkspace(), args)),
    ),
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
    handler(async (args: { applicationId: string; coverLetter?: string; answers?: Array<{ questionKey: string; answer: string }>; notes?: string }) =>
      ok(setApplicationContent(getWorkspace(), args)),
    ),
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
    handler(async (args: { applicationId: string }) => okText(previewApplication(getWorkspace(), args.applicationId).text)),
  );
}
