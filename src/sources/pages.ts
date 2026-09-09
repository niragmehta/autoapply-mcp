import { z } from "zod";
import { AppError } from "../util/errors.js";
import { extractBoardLinks } from "./boardLinks.js";
import { fetchText } from "./http.js";
import { listSourceCatalog } from "./catalog.js";

export const PageSourceIdSchema = z.enum(["a16z", "sequoia", "yc", "builtinsf"]);
export type PageSourceId = z.infer<typeof PageSourceIdSchema>;
const ScanOptionsSchema = z.object({
  url: z.url().optional(),
  limit: z.number().int().min(1).max(100).default(30),
});

export async function scanSourcePage(source: PageSourceId, options: z.input<typeof ScanOptionsSchema>) {
  const sourceId = PageSourceIdSchema.parse(source);
  const input = ScanOptionsSchema.parse(options);
  const entry = listSourceCatalog().find((item) => item.id === sourceId);
  if (!entry) throw new AppError("unsupported_source_page", "source page is not in the permanent catalog");
  const defaultUrl = new URL(entry.url);
  const url = new URL(input.url ?? defaultUrl.toString());
  if (url.origin !== defaultUrl.origin || url.username || url.password) {
    throw new AppError("source_url_not_allowed", "page URL must belong to the selected source's HTTPS origin");
  }
  const html = await fetchText(url.toString(), {
    allowedHosts: [defaultUrl.hostname],
    maxBytes: 8 * 1024 * 1024,
  });
  const boards = extractBoardLinks(html);
  return {
    sourceId,
    sourceUrl: url.toString(),
    boards: boards.slice(0, input.limit),
    truncated: boards.length > input.limit,
    scannedPages: 1,
    requiresEmployerVerification: true,
    warning: boards.length === 0
      ? "No ATS links found in this page response. It may require a rendered browser or employer career-page follow-up; this is not a complete empty source inventory."
      : "One public page only, not a complete source inventory. Board tokens are unverified leads, not company names, qualified jobs or submission permission.",
  };
}
