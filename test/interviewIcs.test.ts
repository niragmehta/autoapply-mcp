import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { escapeText, foldLine, interviewIcs, writeInterviewIcs } from "../src/followup/ics.js";
import { makeWorkspace, scratchDir } from "./afterApplyFixtures.js";

const scratch = scratchDir("ics");
afterAll(() => scratch.cleanup());

const NOW = new Date("2026-11-01T09:30:00.000Z");

function unfold(text: string): string[] {
  return text.replace(/\r\n[ \t]/g, "").split("\r\n").filter((line) => line.length > 0);
}

describe("interview calendar files", () => {
  const ics = interviewIcs(
    {
      title: "Interview: Staff Engineer, Platform; round 2",
      start: "2026-11-10T10:00:00-08:00",
      durationMinutes: 45,
      location: "Video call",
      url: "https://meet.example.com/abc-defg-hij",
      description: "Panel: Jordan and Sam.\nBring questions about the team's roadmap, priorities, and on-call.",
      uid: "test-uid@autoapply-mcp",
    },
    NOW,
  );

  it("is a CRLF-terminated VCALENDAR with one event", () => {
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VEVENT\r\nEND:VCALENDAR\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  it("writes every time in UTC", () => {
    const lines = unfold(ics);
    expect(lines).toContain("DTSTART:20261110T180000Z");
    expect(lines).toContain("DTEND:20261110T184500Z");
    expect(lines).toContain("DTSTAMP:20261101T093000Z");
    expect(lines).toContain("UID:test-uid@autoapply-mcp");
    expect(lines).toContain("TRIGGER:-PT30M");
  });

  it("escapes TEXT values", () => {
    const lines = unfold(ics);
    expect(lines).toContain("SUMMARY:Interview: Staff Engineer\\, Platform\\; round 2");
    expect(lines.find((line) => line.startsWith("DESCRIPTION:Panel"))).toBe(
      "DESCRIPTION:Panel: Jordan and Sam.\\nBring questions about the team's roadmap\\, priorities\\, and on-call.",
    );
    expect(escapeText("a\\b")).toBe("a\\\\b");
  });

  it("folds long lines at 75 octets without splitting a character", () => {
    const folded = foldLine(`DESCRIPTION:${"é".repeat(60)}${"🙂".repeat(10)}`);
    for (const line of folded.split("\r\n")) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(`DESCRIPTION:${"é".repeat(60)}${"🙂".repeat(10)}`);
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
  });

  it("refuses a start time without a zone, a bad duration and a non-web link", () => {
    expect(() => interviewIcs({ title: "x", start: "2026-11-10T10:00:00", durationMinutes: 30 })).toThrow(/with a zone/);
    expect(() => interviewIcs({ title: "x", start: "2026-11-10T10:00:00Z", durationMinutes: 0 })).toThrow(/durationMinutes/);
    expect(() => interviewIcs({ title: "x", start: "2026-11-10T10:00:00Z", durationMinutes: 30, url: "javascript:alert(1)" })).toThrow(/http/);
    expect(() => interviewIcs({ title: "x", start: "2026-11-10T10:00:00Z", durationMinutes: 30, uid: "bad uid\r\nX:1" })).toThrow(/uid/);
  });

  it("writes the file to the exports folder without overwriting", () => {
    const workspace = makeWorkspace({ home: scratch.path });
    const event = { title: "Interview: Staff Engineer", start: "2026-11-10T18:00:00Z", durationMinutes: 30 };
    const first = writeInterviewIcs(workspace, event, NOW);
    const second = writeInterviewIcs(workspace, event, NOW);
    expect(basename(first.path)).toBe("interview-interview-staff-engineer-20261110T180000Z.ics");
    expect(basename(second.path)).toBe("interview-interview-staff-engineer-20261110T180000Z-2.ics");
    expect(readFileSync(first.path, "utf8")).toContain(`UID:${first.uid}`);
  });
});
