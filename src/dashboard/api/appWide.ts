import { z } from "zod";
import { notificationsFor, runNotice } from "../queries/notifications.js";
import { searchEverything } from "../queries/search.js";
import { parseQuery, type Router } from "../router.js";
import { streamRunNotices } from "../sse.js";
import { queryInt } from "./shared.js";

/**
 * App-wide: search across every kind of record, and the notifications tray
 * with its live stream of finished runs.
 */

const SearchQuery = z.object({
  q: z.string().trim().min(1, "type something to search for").max(120),
  limit: queryInt(1, 20, 6),
});

const NotificationsQuery = z.object({ limit: queryInt(1, 100, 40) });

export function registerRoutes(router: Router): void {
  router.get("/api/search", (request) => {
    const query = parseQuery(SearchQuery, request);
    return searchEverything(request.ctx.workspace(), query.q, query.limit);
  });

  router.get("/api/notifications", (request) => {
    const query = parseQuery(NotificationsQuery, request);
    const items = notificationsFor(request.ctx.workspace()).slice(0, query.limit);
    return { items, asOf: new Date().toISOString() };
  });

  router.get("/api/notifications/stream", (request) =>
    streamRunNotices(request, (run) => ({ id: run.id, type: run.type, status: run.status, href: `/runs?run=${encodeURIComponent(run.id)}`, notice: runNotice(run) })),
  );
}
