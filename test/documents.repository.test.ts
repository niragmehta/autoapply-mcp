import { afterAll, describe, expect, it } from "vitest";
import { insertTailoredDocument, latestTailoredDocument, listTailoredDocuments } from "../src/db/repositories/documents.js";
import { hasColumn } from "../src/db/migrate.js";
import { docWorkspace, removeAllScratch, seedApplication } from "./documents.fixtures.js";

afterAll(removeAllScratch);

describe("tailored_documents", () => {
  it("is created with the core schema", () => {
    const workspace = docWorkspace();
    for (const column of ["application_id", "kind", "path", "sha256", "variant_id", "changes_json", "checks_json", "created_at"]) {
      expect(hasColumn(workspace.db, "tailored_documents", column)).toBe(true);
    }
  });

  it("stores rows with their change log and checks, newest first", () => {
    const workspace = docWorkspace();
    const application = seedApplication(workspace);
    const first = insertTailoredDocument(workspace.db, {
      applicationId: application.id,
      kind: "resume",
      path: "/documents/a/resume-1.pdf",
      sha256: "1".repeat(64),
      variantId: "platform",
      changes: [{ kind: "group-moved", target: "platform" }],
      checks: { ok: true, pages: 1 },
      createdAt: "2026-11-01T00:00:00.000Z",
    });
    const second = insertTailoredDocument(workspace.db, {
      applicationId: application.id,
      kind: "resume",
      path: "/documents/a/resume-2.pdf",
      sha256: "2".repeat(64),
      variantId: "platform",
      changes: [],
      checks: {},
      createdAt: "2026-11-02T00:00:00.000Z",
    });
    const letter = insertTailoredDocument(workspace.db, {
      applicationId: application.id,
      kind: "cover-letter",
      path: "/documents/a/cover-letter-1.pdf",
      sha256: "3".repeat(64),
      variantId: "",
      changes: [],
      checks: { textSha256: "abc" },
    });

    expect(first.id).toMatch(/^doc_/);
    expect(listTailoredDocuments(workspace.db, application.id).map((document) => document.id)).toEqual([letter.id, second.id, first.id]);
    expect(listTailoredDocuments(workspace.db, application.id, "resume")).toEqual([second, first]);
    expect(latestTailoredDocument(workspace.db, application.id, "cover-letter")).toEqual(letter);
    expect(latestTailoredDocument(workspace.db, "app_none", "resume")).toBeNull();
    expect(first.changes).toEqual([{ kind: "group-moved", target: "platform" }]);
  });

  it("refuses rows for unknown applications or kinds", () => {
    const workspace = docWorkspace();
    const application = seedApplication(workspace);
    const row = { kind: "resume" as const, path: "x.pdf", sha256: "0", variantId: "", changes: [], checks: {} };
    expect(() => insertTailoredDocument(workspace.db, { ...row, applicationId: "app_missing" })).toThrow(/FOREIGN KEY/);
    expect(() => insertTailoredDocument(workspace.db, { ...row, applicationId: application.id, kind: "portfolio" as never })).toThrow(/CHECK/);
  });
});
