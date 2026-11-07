import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { latestApproval, recordApproval } from "../src/db/repositories/applications.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("the latest approval", () => {
  it("is the one recorded last, even when two share a timestamp", () => {
    // A rejection recorded in the same millisecond as an earlier approval must still win, or the guard would read the stale approval.
    vi.useFakeTimers({ now: new Date("2026-11-07T03:13:40.000Z"), toFake: ["Date"] });
    const db = openDatabase(":memory:");
    recordApproval(db, { id: "apr_b", applicationId: "app_1", packetHash: "hash", decision: "approved", note: "" });
    recordApproval(db, { id: "apr_a", applicationId: "app_1", packetHash: "hash", decision: "rejected", note: "job dismissed" });

    expect(latestApproval(db, "app_1")).toMatchObject({ id: "apr_a", decision: "rejected" });
    db.close();
  });

  it("follows the clock when the timestamps differ", () => {
    const db = openDatabase(":memory:");
    vi.useFakeTimers({ now: new Date("2026-11-07T03:13:40.000Z"), toFake: ["Date"] });
    recordApproval(db, { id: "apr_1", applicationId: "app_1", packetHash: "hash", decision: "rejected", note: "" });
    vi.setSystemTime(new Date("2026-11-07T03:13:41.000Z"));
    recordApproval(db, { id: "apr_2", applicationId: "app_1", packetHash: "hash", decision: "approved", note: "" });

    expect(latestApproval(db, "app_1")).toMatchObject({ id: "apr_2", decision: "approved" });
    db.close();
  });
});
