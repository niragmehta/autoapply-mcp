import { TERMINAL_RUN_STATUSES, type RunRecord } from "../db/repositories/runs.js";
import { AppError } from "../util/errors.js";
import { STREAMED, type ApiRequest } from "./router.js";

/**
 * Server-sent events for one run: a replay of its log after the client's last
 * seen sequence number, then live lines, progress and status until the run
 * finishes. Runs hosted in this process push events as they happen; a run
 * hosted by another process (the MCP server) is followed by polling its rows.
 */

const KEEPALIVE_MS = 15_000;
const POLL_MS = 1_000;

/** One SSE frame. JSON never contains a raw newline, so the payload is a single data line. */
export function sseFrame(event: string, data: unknown, id?: number): string {
  const lines = id === undefined ? [] : [`id: ${id}`];
  lines.push(`event: ${event}`, `data: ${JSON.stringify(data)}`);
  return `${lines.join("\n")}\n\n`;
}

function isFinished(run: RunRecord | null): boolean {
  return run === null || TERMINAL_RUN_STATUSES.includes(run.status);
}

function startingSeq(request: ApiRequest): number {
  const header = request.headers["last-event-id"];
  const raw = typeof header === "string" ? header : (request.query.get("afterSeq") ?? "0");
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function streamRunEvents(request: ApiRequest, runId: string): typeof STREAMED {
  const { res, ctx } = request;
  const queue = ctx.queue;
  const initial = queue.get(runId);
  if (!initial) throw new AppError("run_not_found", `no run ${runId}`);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  res.write("retry: 3000\n\n");

  let lastSeq = startingSeq(request);
  let lastRunJson = "";
  let closed = false;
  const timers: NodeJS.Timeout[] = [];
  let unsubscribe = () => {};

  const send = (event: string, data: unknown, id?: number) => {
    if (!closed) res.write(sseFrame(event, data, id));
  };
  const sendRun = (run: RunRecord | null) => {
    const json = JSON.stringify(run);
    if (json === lastRunJson) return;
    lastRunJson = json;
    send("run", run);
  };
  const flushLogs = () => {
    for (const log of queue.logs(runId, { afterSeq: lastSeq, limit: 1000 })) {
      send("log", log, log.seq);
      lastSeq = log.seq;
    }
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    for (const timer of timers) clearInterval(timer);
  };
  const finish = (run: RunRecord | null) => {
    send("end", { status: run?.status ?? "unknown" });
    cleanup();
    res.end();
  };

  flushLogs();
  sendRun(initial);
  if (isFinished(initial)) {
    finish(initial);
    return STREAMED;
  }

  unsubscribe = queue.subscribe(runId, (event) => {
    if (event.kind === "log") {
      if (event.log.seq <= lastSeq) return;
      send("log", event.log, event.log.seq);
      lastSeq = event.log.seq;
    } else if (event.kind === "progress") {
      send("progress", { done: event.done, total: event.total });
    } else {
      sendRun(event.run);
      if (isFinished(event.run)) finish(event.run);
    }
  });

  if (!queue.isLocal(runId)) {
    timers.push(
      setInterval(() => {
        flushLogs();
        const current = queue.get(runId);
        sendRun(current);
        if (isFinished(current)) finish(current);
      }, POLL_MS),
    );
  }
  timers.push(
    setInterval(() => {
      if (!closed) res.write(": keepalive\n\n");
    }, KEEPALIVE_MS),
  );
  request.raw.on("close", cleanup);
  return STREAMED;
}
