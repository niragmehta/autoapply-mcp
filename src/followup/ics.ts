import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "../config/load.js";
import { AppError } from "../util/errors.js";
import { newId } from "../util/hash.js";

/**
 * A calendar file for an interview, written to RFC 5545: CRLF line endings,
 * TEXT values escaped, lines folded at 75 octets without splitting a UTF-8
 * character, and every time in UTC so no calendar has to guess a zone.
 */

export type InterviewEvent = {
  title: string;
  /** An instant: a Date, or an ISO 8601 string carrying Z or an offset. */
  start: Date | string;
  durationMinutes: number;
  location?: string;
  url?: string;
  description?: string;
  uid?: string;
  /** Minutes before the start to remind. Defaults to 30; 0 for none. */
  reminderMinutes?: number;
};

const MAX_DURATION_MINUTES = 24 * 60;
const ZONED_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

export function parseInstant(start: Date | string): Date {
  if (start instanceof Date) {
    if (!Number.isFinite(start.getTime())) throw new AppError("invalid_start", "start is not a valid date");
    return start;
  }
  const trimmed = start.trim();
  if (!ZONED_ISO.test(trimmed)) {
    throw new AppError(
      "invalid_start",
      `start must be an ISO 8601 time with a zone, such as 2026-11-10T10:00:00-08:00 or 2026-11-10T18:00:00Z (got "${trimmed.slice(0, 40)}")`,
    );
  }
  const parsed = new Date(trimmed);
  if (!Number.isFinite(parsed.getTime())) throw new AppError("invalid_start", `start "${trimmed}" is not a real date`);
  return parsed;
}

/** 20261110T180000Z */
export function formatUtc(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

/** RFC 5545 TEXT: backslash, semicolon and comma escaped, newlines as \n. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** Folds a content line into 75-octet pieces, never inside a multi-byte character. */
export function foldLine(line: string): string {
  const pieces: string[] = [];
  let current = "";
  let octets = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char, "utf8");
    // Continuation lines start with a space, which counts toward their 75.
    const limit = pieces.length === 0 ? 75 : 74;
    if (octets + size > limit) {
      pieces.push(current);
      current = "";
      octets = 0;
    }
    current += char;
    octets += size;
  }
  pieces.push(current);
  return pieces.join("\r\n ");
}

function safeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new AppError("invalid_url", `"${url.slice(0, 80)}" is not a URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new AppError("invalid_url", "only http and https links are allowed");
  return parsed.href;
}

function safeUid(uid: string | undefined): string {
  const value = uid?.trim() || `${newId("interview")}@autoapply-mcp`;
  if (!/^[A-Za-z0-9@._+-]{1,200}$/.test(value)) throw new AppError("invalid_uid", "uid may only contain letters, digits and @._+-");
  return value;
}

export function interviewIcs(event: InterviewEvent, now: Date = new Date()): string {
  const title = event.title.trim();
  if (title.length === 0) throw new AppError("invalid_title", "an interview needs a title");
  if (!Number.isInteger(event.durationMinutes) || event.durationMinutes <= 0 || event.durationMinutes > MAX_DURATION_MINUTES) {
    throw new AppError("invalid_duration", `durationMinutes must be a whole number from 1 to ${MAX_DURATION_MINUTES}`);
  }
  const start = parseInstant(event.start);
  const end = new Date(start.getTime() + event.durationMinutes * 60_000);
  const reminder = event.reminderMinutes ?? 30;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//autoapply-mcp//interview calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${safeUid(event.uid)}`,
    `DTSTAMP:${formatUtc(now)}`,
    `DTSTART:${formatUtc(start)}`,
    `DTEND:${formatUtc(end)}`,
    `SUMMARY:${escapeText(title)}`,
    ...(event.location?.trim() ? [`LOCATION:${escapeText(event.location.trim())}`] : []),
    ...(event.url?.trim() ? [`URL:${safeUrl(event.url)}`] : []),
    ...(event.description?.trim() ? [`DESCRIPTION:${escapeText(event.description.trim())}`] : []),
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    ...(reminder > 0
      ? ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeText(title)}`, `TRIGGER:-PT${Math.round(reminder)}M`, "END:VALARM"]
      : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "interview"
  );
}

/** Writes the event to `paths.exports` as interview-<title>-<start>.ics and returns where. */
export function writeInterviewIcs(workspace: Workspace, event: InterviewEvent, now: Date = new Date()): { path: string; uid: string } {
  const uid = safeUid(event.uid);
  const text = interviewIcs({ ...event, uid }, now);
  mkdirSync(workspace.paths.exports, { recursive: true });
  const base = `interview-${slug(event.title)}-${formatUtc(parseInstant(event.start))}`;
  let path = join(workspace.paths.exports, `${base}.ics`);
  for (let attempt = 2; existsSync(path); attempt += 1) path = join(workspace.paths.exports, `${base}-${attempt}.ics`);
  writeFileSync(path, text, "utf8");
  return { path, uid };
}
