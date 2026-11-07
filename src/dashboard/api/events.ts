import { z } from "zod";
import { listEventRows } from "../queries/applications.js";
import { parseQuery, type Router } from "../router.js";
import { queryInt, queryText } from "./shared.js";

/** The audit log: every gate decision, approval, submission attempt and configuration change. */

const EventQuery = z.object({
  type: queryText(100),
  subject: queryText(200),
  before: z.preprocess((value) => (value === "" ? undefined : value), z.coerce.number().int().positive().optional()),
  limit: queryInt(1, 500, 100),
});

export function registerRoutes(router: Router): void {
  router.get("/api/events", (request) => {
    const query = parseQuery(EventQuery, request);
    const events = listEventRows(request.ctx.workspace().db, {
      type: query.type,
      subjects: query.subject ? [query.subject] : undefined,
      before: query.before,
      limit: query.limit,
    });
    return { events, nextBefore: events.length === query.limit ? events.at(-1)?.id ?? null : null };
  });
}
