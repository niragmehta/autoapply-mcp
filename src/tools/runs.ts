import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RUN_STATUSES, type RunStatus } from "../db/repositories/runs.js";
import { getRunQueue } from "../runner/index.js";
import { AppError } from "../util/errors.js";
import { handler, ok } from "./helpers.js";

/** Long-running operations started in the background and inspected later. */

const HOST_NOTE =
  "Runs started here execute inside this MCP server process and stop when the client session ends. For long submission runs, start them from the dashboard (npm run dashboard), which keeps running.";

export function registerRunTools(server: McpServer): void {
  server.registerTool(
    "start_run",
    {
      title: "Start a background run",
      description: [
        "Queues a long-running operation and returns its run id immediately. Types and params:",
        "discovery {companies?: string[], chunkSize?: number};",
        "prepare {jobIds?: string[] | filter?: {tiers, tracks, locationClasses, companies, minCompensation, allowUnknownCompensation, minScore, limit}, force?: boolean};",
        "submit {applicationIds: string[], mode?: 'auto'|'assisted', headed?, paceSeconds?, codeWaitSeconds?, packetHashes?: {applicationId: hash}}.",
        "A submit run is the person's approval of exactly the listed applications: each is approved at its current packet hash (pass packetHashes from preview_application to bind approval to what was reviewed; a changed packet is then skipped), applications with unresolved required answers are skipped, and every submission guard still applies.",
        HOST_NOTE,
      ].join(" "),
      inputSchema: {
        type: z.string().min(1).describe('Run type: "discovery", "prepare" or "submit".'),
        params: z.record(z.string(), z.unknown()).optional().describe("Parameters for that run type."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    handler(async (args: { type: string; params?: Record<string, unknown> }) => {
      const queue = getRunQueue();
      const runId = queue.enqueue(args.type, args.params ?? {});
      return ok({
        runId,
        type: args.type,
        status: queue.get(runId)?.status ?? "queued",
        nextStep: "Check progress with run_status, or follow the log with run_logs using afterSeq.",
        note: HOST_NOTE,
      });
    }),
  );

  server.registerTool(
    "run_status",
    {
      title: "Check a run",
      description: "Returns a run's status, progress, summary or error, and its most recent log lines.",
      inputSchema: {
        runId: z.string().min(1),
        logLines: z.number().int().min(0).max(200).optional().describe("Recent log lines to include. Default 20."),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: { runId: string; logLines?: number }) => {
      const queue = getRunQueue();
      const run = queue.get(args.runId);
      if (!run) throw new AppError("run_not_found", `no run ${args.runId}`);
      const wanted = args.logLines ?? 20;
      return ok({ run, hostedHere: queue.isLocal(run.id), recentLogs: wanted === 0 ? [] : queue.tail(run.id, wanted) });
    }),
  );

  server.registerTool(
    "list_runs",
    {
      title: "List runs",
      description: "Lists recent runs from every host (this server and the dashboard), newest first.",
      inputSchema: {
        status: z.enum(RUN_STATUSES).optional(),
        type: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: { status?: RunStatus; type?: string; limit?: number }) => {
      const queue = getRunQueue();
      const runs = queue.list({ statuses: args.status ? [args.status] : undefined, type: args.type, limit: args.limit ?? 20 });
      return ok({
        count: runs.length,
        runs: runs.map((run) => ({
          runId: run.id,
          type: run.type,
          status: run.status,
          progress: `${run.progressDone}/${run.progressTotal}`,
          createdAt: run.createdAt,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          error: run.error,
          hostedHere: queue.isLocal(run.id),
        })),
      });
    }),
  );

  server.registerTool(
    "cancel_run",
    {
      title: "Cancel a run",
      description:
        "Cancels a queued run at once, or asks a running one to stop after its current item. An application already being submitted is finished and recorded first.",
      inputSchema: { runId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    handler(async (args: { runId: string }) => ok(getRunQueue().cancel(args.runId))),
  );

  server.registerTool(
    "run_logs",
    {
      title: "Read a run's log",
      description: "Returns log lines after a sequence number, for following a run incrementally.",
      inputSchema: {
        runId: z.string().min(1),
        afterSeq: z.number().int().min(0).optional().describe("Return lines with a higher sequence number. Default 0."),
        limit: z.number().int().positive().max(1000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: { runId: string; afterSeq?: number; limit?: number }) => {
      const queue = getRunQueue();
      const run = queue.get(args.runId);
      if (!run) throw new AppError("run_not_found", `no run ${args.runId}`);
      const logs = queue.logs(run.id, { afterSeq: args.afterSeq ?? 0, limit: args.limit ?? 200 });
      return ok({
        runId: run.id,
        status: run.status,
        progress: { done: run.progressDone, total: run.progressTotal },
        logs,
        nextAfterSeq: logs.at(-1)?.seq ?? args.afterSeq ?? 0,
      });
    }),
  );
}
