import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getWorkspace } from "../config/load.js";
import { approveApplication, recordManualSubmission, submitApplication } from "../services/applications.js";
import { handler, ok, okText } from "./helpers.js";

/**
 * Approval and submission.
 *
 * These are the only tools that can cause an employer-visible action. The
 * service layer re-checks every guard on each call rather than trusting
 * earlier state.
 */

export function registerSubmissionTools(server: McpServer): void {
  server.registerTool(
    "approve_application",
    {
      title: "Approve an application for submission",
      description:
        "Records the human decision that authorizes submission. The supplied packetHash must match the current content exactly; any later edit invalidates the approval.",
      inputSchema: {
        applicationId: z.string().min(1),
        packetHash: z.string().min(8).describe("Hash shown by preview_application, proving the approved content."),
        decision: z.enum(["approved", "rejected"]).default("approved"),
        note: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    handler(async (args: { applicationId: string; packetHash: string; decision?: "approved" | "rejected"; note?: string }) =>
      ok(approveApplication(getWorkspace(), args)),
    ),
  );

  server.registerTool(
    "submit_application",
    {
      title: "Submit an approved application",
      description:
        "Runs every submission guard, then acts according to mode. 'manual' returns the packet for a person to submit. 'assisted' fills the hosted form in a visible browser and leaves it for a person to submit. 'auto' fills and clicks submit, and is only available when the campaign and company allowlists permit it.",
      inputSchema: {
        applicationId: z.string().min(1),
        mode: z.enum(["manual", "assisted", "auto"]).default("manual"),
        headless: z.boolean().optional().describe("Run the browser headless. Ignored in assisted mode."),
        keepOpenSeconds: z
          .number()
          .int()
          .min(0)
          .max(1800)
          .optional()
          .describe("Assisted mode: how long to leave the filled form open for review."),
        verificationCode: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The one-time code the board emailed after a previous attempt hit its verification gate. Each attempt emails a new code, so use the most recent one.",
          ),
        waitForCodeSeconds: z
          .number()
          .int()
          .min(0)
          .max(1800)
          .optional()
          .describe(
            "Hold the browser at a verification gate for this long while waiting for the code to be written to <artifacts>/<applicationId>.code. A code cannot be carried between runs, so this is the only way an automated submission clears the gate. With a verification inbox configured, it also bounds the wait for the link Workday emails to verify a candidate account.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    handler(async (args: { applicationId: string; mode?: "manual" | "assisted" | "auto"; headless?: boolean; keepOpenSeconds?: number; verificationCode?: string; waitForCodeSeconds?: number }) => {
      const outcome = await submitApplication(getWorkspace(), args);
      if (outcome.kind === "manual") return okText(outcome.packetText);
      return ok({ applicationId: outcome.applicationId, mode: outcome.mode, result: outcome.result, nextStep: outcome.nextStep });
    }),
  );

  server.registerTool(
    "record_submission",
    {
      title: "Record a manual submission",
      description: "Marks an application as submitted after a person sent it, so counts, pacing and duplicate checks stay accurate.",
      inputSchema: {
        applicationId: z.string().min(1),
        confirmationRef: z.string().optional(),
        notes: z.string().optional(),
      },
      annotations: { readOnlyHint: false },
    },
    handler(async (args: { applicationId: string; confirmationRef?: string; notes?: string }) =>
      ok(recordManualSubmission(getWorkspace(), args)),
    ),
  );
}
