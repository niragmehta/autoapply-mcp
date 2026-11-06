import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applySchemaModules, ensureColumn, hasColumn } from "../src/db/migrate.js";
import { openDatabase } from "../src/db/database.js";
import { loadSecretsFile, parseSecrets } from "../src/config/secrets.js";
import { supportsBrowserSubmission } from "../src/domain/campaign.js";
import { makeCampaign } from "./factories.js";

describe("schema modules", () => {
  it("adds a missing column once and leaves an existing one alone", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");

    expect(ensureColumn(db, "t", "extra", "TEXT NOT NULL DEFAULT ''")).toBe(true);
    expect(ensureColumn(db, "t", "extra", "TEXT NOT NULL DEFAULT ''")).toBe(false);
    expect(hasColumn(db, "t", "extra")).toBe(true);
  });

  it("refuses identifiers that could smuggle SQL", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (id TEXT)");
    expect(() => ensureColumn(db, "t; DROP TABLE t", "x", "TEXT")).toThrow(/invalid SQL identifier/);
  });

  it("applies each module's tables and then its migration", () => {
    const db = new DatabaseSync(":memory:");
    const order: string[] = [];
    applySchemaModules(db, [
      { name: "a", sql: "CREATE TABLE IF NOT EXISTS a (id TEXT)", migrate: () => order.push("a") },
      { name: "b", sql: "", migrate: () => order.push("b") },
    ]);
    expect(hasColumn(db, "a", "id")).toBe(true);
    expect(order).toEqual(["a", "b"]);
  });

  it("opens the full database, feature schemas included, more than once", () => {
    const path = join(mkdtempSync(join(tmpdir(), "autoapply-db-")), "db.sqlite");
    openDatabase(path).close();
    const again = openDatabase(path);
    expect(hasColumn(again, "applications", "status")).toBe(true);
    again.close();
  });
});

describe("local secrets file", () => {
  it("reads KEY=value lines, skipping comments and stripping quotes", () => {
    expect(
      parseSecrets(["# comment", "", "A=1", "export B = two words ", 'C="quoted value"', "D='x'", "not a line"].join("\n")),
    ).toEqual({ A: "1", B: "two words", C: "quoted value", D: "x" });
  });

  it("never overrides a variable that is already set and reports only names", () => {
    const path = join(mkdtempSync(join(tmpdir(), "autoapply-secrets-")), ".env");
    writeFileSync(path, "KEEP=file\nNEW=value\n");
    const env: NodeJS.ProcessEnv = { KEEP: "shell" };

    expect(loadSecretsFile(path, env)).toEqual(["NEW"]);
    expect(env).toEqual({ KEEP: "shell", NEW: "value" });
  });

  it("does nothing when the file is absent", () => {
    expect(loadSecretsFile(join(tmpdir(), "no-such-autoapply-secrets.env"), {})).toEqual([]);
  });
});

describe("browser submission support", () => {
  it("covers the engines that can fill forms and nothing discovery-only", () => {
    expect(supportsBrowserSubmission("greenhouse")).toBe(true);
    expect(supportsBrowserSubmission("workday")).toBe(true);
    expect(supportsBrowserSubmission("smartrecruiters")).toBe(false);
    expect(supportsBrowserSubmission("icims")).toBe(false);
    expect(supportsBrowserSubmission("external")).toBe(false);
  });

  it("gives older campaign files every new policy section with its defaults", () => {
    const campaign = makeCampaign();
    expect(campaign.hygiene.liveness.beforePrepare).toBe(true);
    expect(campaign.documents.tailorResume).toBe(false);
    expect(campaign.inbox.enabled).toBe(false);
    expect(campaign.followUps.ghostAfterDays).toBe(45);
    expect(campaign.runner.roundCap).toBeNull();
  });
});
