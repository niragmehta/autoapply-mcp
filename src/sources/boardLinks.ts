import type { AtsKind, Company } from "../domain/campaign.js";
import { htmlToText } from "../text/html.js";

export type BoardLink = { ats: AtsKind; board: string; region: Company["region"]; sourceUrl: string };
const TOKEN = /^[a-z0-9][a-z0-9_.-]*$/i;
const RESERVED = new Set(["j", "o", "jobs", "job", "embed", "api", "www"]);

function identifyBoard(url: URL): { ats: AtsKind; board: string } | null {
  const parts = url.pathname.split("/").filter(Boolean);
  const first = parts[0] ?? "";
  const host = url.hostname.toLowerCase();
  if (/^(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io$/.test(host)) {
    return { ats: "greenhouse", board: first === "embed" ? url.searchParams.get("for") ?? "" : first };
  }
  if (/^jobs(?:\.eu)?\.lever\.co$/.test(host)) return { ats: "lever", board: first };
  if (host === "jobs.ashbyhq.com") return { ats: "ashby", board: first };
  if (host === "jobs.smartrecruiters.com" || host === "careers.smartrecruiters.com") {
    return { ats: "smartrecruiters", board: first };
  }
  if (host === "apply.workable.com") return { ats: "workable", board: first };
  const recruitee = /^([a-z0-9-]+)\.recruitee\.com$/.exec(host);
  if (recruitee?.[1]) return { ats: "recruitee", board: recruitee[1] };
  const workday = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/.exec(host);
  if (workday) {
    const site = /^[a-z]{2}(?:-[a-z]{2})?$/i.test(first) ? parts[1] : first;
    if (site && TOKEN.test(site)) return { ats: "workday", board: `${workday[1]}/${workday[2]}/${site}` };
  }
  return null;
}

/** Recognize only known public ATS URL shapes; never visit outbound links here. */
export function boardFromUrl(raw: string): BoardLink | null {
  if (/[\x00-\x20\\]/.test(raw) || /\/(?:\.|%2e){1,2}(?:\/|[?#]|$)/i.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const board = identifyBoard(url);
  if (!board || RESERVED.has(board.board.toLowerCase())) return null;
  if (board.ats !== "workday" && !TOKEN.test(board.board)) return null;
  return { ...board, region: url.hostname.includes(".eu.") ? "eu" : "global", sourceUrl: url.toString() };
}

export function extractBoardLinks(html: string): BoardLink[] {
  const decoded = html.replace(/\\u002f/gi, "/").replace(/\\\//g, "/");
  const candidates = [...decoded.matchAll(/https:\/\/[^\s"'<>\\]+/gi)]
    .map((match) => boardFromUrl(htmlToText(match[0]).replace(/[),.;]+$/, "")))
    .filter((link): link is BoardLink => link !== null);
  return [...new Map(candidates.map((link) => [`${link.ats}:${link.region}:${link.board.toLowerCase()}`, link])).values()];
}
