import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getWorkspace } from "../config/load.js";
import { approveBatch, listBatchSummaries, prepareBatch, previewBatch, submitBatch, type BatchFilter } from "../services/batches.js";
import { handler, ok } from "./helpers.js";

const FilterShape = {
  tiers: z.array(z.enum(["A", "B", "C"])).optional().describe("Quality tiers to include. Defaults to A and B."),
  trackIds: z.array(z.string()).optional().describe("Campaign track ids to include."),
  locationClasses: z
    .array(z.enum(["bay-area", "us-other", "canada", "remote-us", "remote-canada", "remote-global", "other", "unknown"]))
    .optional(),
  companies: z.array(z.string()).optional(),
  minScore: z.number().optional(),
  minCompensation: z.number().optional().describe("Minimum annualized top-of-range pay in the campaign currency."),
  allowUnknownCompensation: z.boolean().optional().describe("Include postings that publish no pay. Default false."),
  limit: z.number().int().positive().max(300).optional(),
};

/** Batch tools: thin wrappers over src/services/batches.ts, which keeps every per-application guard. */
export function registerBatchTools(server: McpServer): void {
  server.registerTool(
    "prepare_batch",
    {
      title: "Prepare many applications at once",
      description:
        "Selects queued jobs matching a filter and prepares an application packet for each, using the same drafting, liveness check and validation as the single-job path. Creates local drafts and a batch manifest; nothing is sent. Applications whose questions still need a human decision are marked needs_human and excluded from batch approval. The campaign's submission.maxBatchSize is a hard ceiling, so a larger limit is silently reduced to it.",
      inputSchema: FilterShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    handler(async (args: BatchFilter) => ok(await prepareBatch(getWorkspace(), args))),
  );

  server.registerTool(
    "preview_batch",
    {
      title: "Review a prepared batch",
      description:
        "Lists every application in a batch with its company, role, resume variant and readiness, plus the grouped questions blocking the rest. Returns the manifest hash required to approve.",
      inputSchema: {
        batchId: z.string().optional().describe("Defaults to the most recent batch."),
        includeReady: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: { batchId?: string; includeReady?: boolean }) => ok(previewBatch(getWorkspace(), args))),
  );

  server.registerTool(
    "approve_batch",
    {
      title: "Approve every ready application in a batch",
      description:
        "Records a human approval for each ready application in the batch. Requires the current manifest hash and the exact count being approved, so approval cannot silently cover more applications than were reviewed.",
      inputSchema: {
        batchId: z.string().min(1),
        manifestHash: z.string().min(8).describe("From preview_batch. Binds approval to this exact set of packets."),
        expectedCount: z.number().int().positive().describe("Number of applications you intend to approve."),
        note: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    handler(async (args: { batchId: string; manifestHash: string; expectedCount: number; note?: string }) =>
      ok(approveBatch(getWorkspace(), args)),
    ),
  );

  server.registerTool(
    "submit_batch",
    {
      title: "Submit an approved batch",
      description:
        "Submits approved applications in the batch, re-running all per-application guards and honouring pacing and any configured daily limit. A null submission.dailyLimit disables only the daily ceiling. The campaign's submission.maxBatchSize still caps how many are submitted per run.",
      inputSchema: {
        batchId: z.string().min(1),
        mode: z.enum(["manual", "assisted", "auto"]).default("manual"),
        maxSubmissions: z.number().int().positive().max(200).optional(),
        headless: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    handler(async (args: { batchId: string; mode?: "manual" | "assisted" | "auto"; maxSubmissions?: number; headless?: boolean }) =>
      ok(await submitBatch(getWorkspace(), args)),
    ),
  );

  server.registerTool(
    "list_batches",
    {
      title: "List prepared batches",
      description: "Recent batches with their status and per-state counts.",
      inputSchema: { limit: z.number().int().positive().max(100).optional() },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: { limit?: number }) => ok({ batches: listBatchSummaries(getWorkspace(), args.limit ?? 10) })),
  );
}
