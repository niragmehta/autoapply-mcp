import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "../src/config/load.js";
import { csvCell, exportTracker, markdownCell, neutralizeFormula, toCsv, trackerRows } from "../src/analytics/export.js";
import { makeWorkspace, scratchDir, seedApplication, seedOutcome } from "./afterApplyFixtures.js";

const scratch = scratchDir("tracker");
afterAll(() => scratch.cleanup());

let workspace: Workspace;

beforeEach(() => {
  workspace = makeWorkspace({ home: scratch.path });
  seedApplication(workspace.db, { id: "app_old", company: "Acme", title: "Staff Engineer", submittedAt: "2026-08-01T00:00:00.000Z", score: 91.26, tier: "A" });
  seedApplication(workspace.db, { id: "app_new", company: "Globex, Inc.", title: 'Senior "Platform" Engineer', submittedAt: "2026-09-01T00:00:00.000Z", trackId: "software" });
  seedApplication(workspace.db, { id: "app_draft", company: "=HYPERLINK(\"http://evil.example\")", title: "@SUM(A1)", status: "drafted", submittedAt: null });
  seedOutcome(workspace.db, "app_old", "acknowledged", "2026-08-01T01:00:00.000Z");
  seedOutcome(workspace.db, "app_old", "rejected", "2026-08-20T00:00:00.000Z");
});

describe("spreadsheet-safe cells", () => {
  it.each([
    ["=SUM(1,2)", "\"'=SUM(1,2)\""],
    ["+15550100", "'+15550100"],
    ["-2+3", "'-2+3"],
    ["@cmd", "'@cmd"],
    ["\tTAB", "'\tTAB"],
    [" =1+1", "' =1+1"],
    ["plain", "plain"],
  ])("neutralises %j", (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  it("quotes separators, quotes and line breaks per RFC 4180", () => {
    expect(csvCell("Globex, Inc.")).toBe('"Globex, Inc."');
    expect(csvCell('Senior "Platform"')).toBe('"Senior ""Platform"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell(91.3)).toBe("91.3");
    expect(csvCell(null)).toBe("");
    expect(neutralizeFormula("Acme")).toBe("Acme");
  });

  it("escapes Markdown table cells", () => {
    expect(markdownCell("a | b\nc \\ d")).toBe("a \\| b c \\\\ d");
  });
});

describe("tracker export", () => {
  it("lists every application with its latest outcome, submitted newest first", () => {
    const rows = trackerRows(workspace.db);
    expect(rows.map((row) => row.company)).toEqual(["Globex, Inc.", "Acme", '=HYPERLINK("http://evil.example")']);
    expect(rows[1]).toMatchObject({
      title: "Staff Engineer",
      ats: "greenhouse",
      track: "ai-security",
      tier: "A",
      score: 91.3,
      status: "submitted",
      submitted_at: "2026-08-01T00:00:00.000Z",
      latest_outcome: "rejected",
      latest_outcome_at: "2026-08-20T00:00:00.000Z",
    });
  });

  it("writes a timestamped CSV that a spreadsheet cannot execute", () => {
    const now = new Date("2026-11-06T23:54:57.000Z");
    const first = exportTracker(workspace, "csv", now);
    const second = exportTracker(workspace, "csv", now);
    expect(basename(first.path)).toBe("tracker-20261106-235457.csv");
    expect(basename(second.path)).toBe("tracker-20261106-235457-2.csv");
    expect(first.rows).toBe(3);
    const text = readFileSync(first.path, "utf8");
    expect(text.startsWith("\uFEFFcompany,title,ats,track,tier,score,status,submitted_at,latest_outcome,latest_outcome_at,url\r\n")).toBe(true);
    expect(text).toContain('"Globex, Inc.","Senior ""Platform"" Engineer"');
    expect(text).toContain(`"'=HYPERLINK(""http://evil.example"")",'@SUM(A1)`);
    expect(text).not.toMatch(/(^|,)=HYPERLINK/m);
    expect(text).toBe(toCsv(trackerRows(workspace.db)));
  });

  it("writes Markdown with escaped cells", () => {
    const result = exportTracker(workspace, "markdown", new Date("2026-11-06T23:54:58.000Z"));
    expect(basename(result.path)).toBe("tracker-20261106-235458.md");
    const text = readFileSync(result.path, "utf8");
    expect(text).toContain("| company | title | ats |");
    expect(text).toContain("| Acme | Staff Engineer | greenhouse | ai-security | A | 91.3 | submitted |");
  });

  it("rejects an unknown format", () => {
    expect(() => exportTracker(workspace, "xlsx" as never)).toThrow(/csv or markdown/);
  });
});
