import { z } from "zod";
import { RUN_STATUSES } from "../../db/repositories/runs.js";
import { AppError } from "../../util/errors.js";
import { annotateRun } from "../queries/runs.js";
import { JsonReply, parseBody, parseParams, parseQuery, type Router } from "../router.js";
import { streamRunEvents } from "../sse.js";
import { IdParams, csvList, queryInt, queryText } from "./shared.js";

/** Runs: start, list, inspect, cancel, and follow live over server-sent events. */

const RunListQuery = z.object({
  status: csvList(z.enum(RUN_STATUSES)),
  type: queryText(40),
  before: queryText(40),
  limit: queryInt(1, 200, 50),
});

const StartBody = z
  .object({
    type: z.string().trim().min(1).max(40),
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

const LogQuery = z.object({ afterSeq: queryInt(0, Number.MAX_SAFE_INTEGER, 0), limit: queryInt(1, 2000, 500) });

export function registerRoutes(router: Router): void {
  router.get("/api/runs", (request) => {
    const query = parseQuery(RunListQuery, request);
    const queue = request.ctx.queue;
    const runs = queue.list({ statuses: query.status, type: query.type, before: query.before, limit: query.limit });
    return { runs: runs.map((run) => ({ ...annotateRun(run), hostedHere: queue.isLocal(run.id) })) };
  });

  router.get("/api/runs/types", ({ ctx }) => ({ types: ctx.queue.taskTypes(), hostPid: ctx.queue.hostPid }));

  router.post("/api/runs", (request) => {
    const body = parseBody(StartBody, request);
    const queue = request.ctx.queue;
    const runId = queue.enqueue(body.type, body.params);
    return new JsonReply(201, { runId, run: queue.get(runId) });
  });

  router.get("/api/runs/:id", (request) => {
    const { id } = parseParams(IdParams, request);
    const queue = request.ctx.queue;
    const run = queue.get(id);
    if (!run) throw new AppError("run_not_found", `no run ${id}`);
    return { run: { ...annotateRun(run), hostedHere: queue.isLocal(id) }, logs: queue.tail(id, 300) };
  });

  router.post("/api/runs/:id/cancel", (request) => {
    const { id } = parseParams(IdParams, request);
    return request.ctx.queue.cancel(id);
  });

  router.get("/api/runs/:id/logs", (request) => {
    const { id } = parseParams(IdParams, request);
    const query = parseQuery(LogQuery, request);
    const queue = request.ctx.queue;
    if (!queue.get(id)) throw new AppError("run_not_found", `no run ${id}`);
    return { runId: id, logs: queue.logs(id, { afterSeq: query.afterSeq, limit: query.limit }) };
  });

  router.get("/api/runs/:id/events", (request) => {
    const { id } = parseParams(IdParams, request);
    return streamRunEvents(request, id);
  });
}
