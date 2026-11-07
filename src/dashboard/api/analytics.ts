import { basename } from "node:path";
import { z } from "zod";
import { campaignAnalytics } from "../../analytics/campaign.js";
import { exportTracker } from "../../analytics/export.js";
import { DOWNLOAD_TYPES, listFiles, resolveNamedFile } from "../queries/files.js";
import { FileReply, HttpError, JsonReply, parseBody, parseParams, parseQuery, type Router } from "../router.js";
import { queryText } from "./shared.js";

/**
 * Analytics: the campaign's funnel, rates (each with its sample size),
 * calibration, rejection patterns, skill gaps and gate discards; plus tracker
 * exports written to the exports folder and downloaded from there.
 */

const EXPORT_EXTENSIONS = [".csv", ".md", ".ics"] as const;

const AnalyticsQuery = z.object({ since: queryText(40) });

const ExportBody = z.object({ format: z.enum(["csv", "markdown"]) }).strict();

const ExportName = z.object({ name: z.string().min(1).max(200) });

export function registerRoutes(router: Router): void {
  router.get("/api/analytics", (request) => {
    const query = parseQuery(AnalyticsQuery, request);
    return campaignAnalytics(request.ctx.workspace(), { since: query.since });
  });

  router.get("/api/exports", ({ ctx }) => ({ files: listFiles(ctx.workspace().paths.exports, EXPORT_EXTENSIONS, 30) }));

  router.post("/api/exports", (request) => {
    const body = parseBody(ExportBody, request);
    const written = exportTracker(request.ctx.workspace(), body.format);
    const name = basename(written.path);
    return new JsonReply(201, { name, format: written.format, rows: written.rows, href: `/api/exports/${encodeURIComponent(name)}` });
  });

  router.get("/api/exports/:name", (request) => {
    const { name } = parseParams(ExportName, request);
    const path = resolveNamedFile(request.ctx.workspace().paths.exports, name, EXPORT_EXTENSIONS);
    if (!path) throw new HttpError(404, "export_not_found", "no such export");
    const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
    return new FileReply(path, DOWNLOAD_TYPES[extension] ?? "application/octet-stream", name);
  });
}
