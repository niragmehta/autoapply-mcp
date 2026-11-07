import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Workspace } from "../src/config/load.js";
import { openDatabase } from "../src/db/database.js";
import { listEvents } from "../src/db/repositories/events.js";
import { updateProfile } from "../src/onboarding/edits.js";
import { appendAt, formatPointer, parsePointer, removeAt, setAt } from "../src/onboarding/jsonPointer.js";
import { applyCampaignPatch, applyProfilePatch } from "../src/onboarding/profilePatch.js";
import { AppError } from "../src/util/errors.js";

/** Fictional data only. */

const PROFILE = {
  version: 1,
  identity: {
    fullName: "Jordan Rivers",
    email: "jordan@rivers.test",
    location: { city: "Vancouver", country: "Canada" },
  },
  workAuthorization: { citizenships: ["Canada"], authorizedIn: ["CA"], statement: "Canadian citizen." },
  compensation: { targetTotal: 250000, minimumTotal: 200000 },
  resumes: [{ id: "general", label: "General", path: "C:/resumes/general.pdf" }],
  skills: [{ name: "Python" }],
  personal: { dateOfBirth: { value: "" } },
};

const CAMPAIGN = {
  version: 1,
  name: "rivers-campaign",
  tracks: [{ id: "platform", label: "Platform", resumeId: "general", titleIncludes: ["platform engineer"] }],
  locations: { allow: ["canada"] },
  compensation: { floors: { CA: 150000 } },
};

const dirs: string[] = [];
function setup(): { profile: string; campaign: string; home: string } {
  const home = mkdtempSync(join(tmpdir(), "autoapply-patch-"));
  dirs.push(home);
  const profile = join(home, "profile.json");
  const campaign = join(home, "campaign.json");
  writeFileSync(profile, JSON.stringify(PROFILE, null, 2));
  writeFileSync(campaign, JSON.stringify(CAMPAIGN, null, 2));
  return { profile, campaign, home };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function read(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? error.code : String(error);
  }
  return "no error";
}

describe("json pointer edits", () => {
  it("round-trips escaped segments and never mutates the input", () => {
    expect(parsePointer("/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
    expect(formatPointer(["a/b", "c~d"])).toBe("/a~1b/c~0d");
    const original = { list: [1, 2, 3], nested: { keep: true } };
    const next = removeAt(setAt(appendAt(original, "/list", 4), "/nested/added", "x"), "/list/0");
    expect(next).toEqual({ list: [2, 3, 4], nested: { keep: true, added: "x" } });
    expect(original).toEqual({ list: [1, 2, 3], nested: { keep: true } });
  });

  it("creates missing objects but rejects bad indexes and prototype keys", () => {
    expect(setAt({}, "/identity/links/github", "https://github.com/jordan")).toEqual({
      identity: { links: { github: "https://github.com/jordan" } },
    });
    expect(codeOf(() => setAt({ list: [1] }, "/list/5", 2))).toBe("pointer_not_found");
    expect(codeOf(() => setAt({ list: [1] }, "/list/x", 2))).toBe("invalid_pointer");
    expect(codeOf(() => setAt({}, "/identity/__proto__/polluted", true))).toBe("invalid_pointer");
    expect(codeOf(() => appendAt({ name: "x" }, "/name", "y"))).toBe("not_an_array");
    expect(codeOf(() => removeAt({}, "/missing"))).toBe("pointer_not_found");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("applyProfilePatch", () => {
  it("writes allowed edits atomically with a backup and reports paths, not values", () => {
    const paths = setup();
    const result = applyProfilePatch(paths, [
      { op: "set", path: "/identity/phone", value: "+1 604 555 2368" },
      { op: "append", path: "/skills", value: { name: "Go", level: "strong" } },
      { op: "remove", path: "/skills/0" },
    ], { now: new Date("2026-11-06T12:00:00Z") });

    expect(result.unchanged).toBe(false);
    expect(result.changed).toEqual([
      { op: "set", path: "/identity/phone" },
      { op: "append", path: "/skills" },
      { op: "remove", path: "/skills/0" },
    ]);
    expect(JSON.stringify(result)).not.toContain("555 2368");
    expect(result.backupPath).toMatch(/profile\.json\.bak-20261106T120000$/);
    expect(existsSync(result.backupPath!)).toBe(true);

    const written = read(paths.profile);
    expect(written.identity.phone).toBe("+1 604 555 2368");
    expect(written.skills).toEqual([{ name: "Go", level: "strong" }]);
    // Patched as written: schema defaults are not spelled out in the file.
    expect(written.skills[0].aliases).toBeUndefined();
    expect(written.preferences).toBeUndefined();
    expect(readdirSync(paths.home).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("refuses paths outside the allowlist, including personal data", () => {
    const paths = setup();
    for (const path of ["/personal/dateOfBirth/value", "/version", "/identityX", "/"]) {
      expect(codeOf(() => applyProfilePatch(paths, [{ op: "set", path, value: "x" }])), path).toMatch(/patch_path_not_allowed|invalid_pointer|patch_invalid_ops/);
    }
    expect(read(paths.profile)).toEqual(PROFILE);
  });

  it("validates the whole result and writes nothing when it fails", () => {
    const paths = setup();
    let message = "";
    try {
      applyProfilePatch(paths, [{ op: "set", path: "/identity/email", value: "jordan-at-nowhere" }]);
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("patch_invalid");
      message = (error as AppError).message;
    }
    expect(message).toContain("/identity/email");
    expect(message).not.toContain("jordan-at-nowhere");
    expect(read(paths.profile)).toEqual(PROFILE);
    expect(codeOf(() => applyProfilePatch(paths, [{ op: "remove", path: "/resumes/0" }]))).toBe("patch_invalid");
  });

  it("rejects malformed ops and missing values", () => {
    const paths = setup();
    expect(codeOf(() => applyProfilePatch(paths, []))).toBe("patch_invalid_ops");
    expect(codeOf(() => applyProfilePatch(paths, [{ op: "replace", path: "/identity/phone", value: "1" }]))).toBe("patch_invalid_ops");
    expect(codeOf(() => applyProfilePatch(paths, [{ op: "set", path: "/identity/phone" }]))).toBe("patch_value_missing");
  });

  it("does not rewrite the file for an edit that changes nothing", () => {
    const paths = setup();
    const result = applyProfilePatch(paths, [{ op: "set", path: "/identity/fullName", value: "Jordan Rivers" }]);
    expect(result).toMatchObject({ unchanged: true, backupPath: null });
    expect(readdirSync(paths.home).filter((name) => name.includes(".bak-"))).toEqual([]);
  });

  it("warns when a resume path does not point at a usable file", () => {
    const paths = setup();
    const result = applyProfilePatch(paths, [{ op: "set", path: "/resumes/0/path", value: join(paths.home, "missing.pdf") }]);
    expect(result.warnings).toEqual(['resume "general" does not point at a usable file yet; profile_status reports why']);
  });

  it("fails clearly when profile.json does not exist", () => {
    expect(codeOf(() => applyProfilePatch({ profile: join(tmpdir(), "no-such-dir-autoapply", "profile.json") }, [{ op: "set", path: "/identity/phone", value: "1" }]))).toBe(
      "config_missing",
    );
  });
});

describe("applyCampaignPatch", () => {
  it("allows the tuning sections and only the listed submission settings", () => {
    const paths = setup();
    const result = applyCampaignPatch(paths, [
      { op: "set", path: "/scoring/thresholds", value: { tierA: 80, tierB: 70, tierC: 60 } },
      { op: "append", path: "/tracks/0/keywords", value: { term: "kubernetes", weight: 3 } },
      { op: "set", path: "/submission/dailyLimit", value: 10 },
      { op: "append", path: "/hygiene/blacklist", value: { value: "Vandelay Industries", reason: "candidate request" } },
    ]);
    expect(result.unchanged).toBe(false);
    const written = read(paths.campaign);
    expect(written.scoring).toEqual({ thresholds: { tierA: 80, tierB: 70, tierC: 60 } });
    expect(written.tracks[0].keywords).toEqual([{ term: "kubernetes", weight: 3 }]);
    expect(written.submission).toEqual({ dailyLimit: 10 });

    for (const path of ["/submission/allowedAtsDomains", "/submission/blockedQuestionCategories", "/scoring/weights", "/name", "/submission"]) {
      expect(codeOf(() => applyCampaignPatch(paths, [{ op: "set", path, value: [] }])), path).toBe("patch_path_not_allowed");
    }
    expect(codeOf(() => applyCampaignPatch(paths, [{ op: "set", path: "/submission/mode", value: "reckless" }]))).toBe("patch_invalid");
  });
});

describe("updateProfile", () => {
  it("reloads the workspace and records the changed paths in the audit log", () => {
    const paths = setup();
    const db = openDatabase(":memory:");
    const outcome = updateProfile([{ op: "set", path: "/identity/headline", value: "Staff Engineer" }], {
      paths: { ...paths } as never,
      reload: () => ({ db }) as unknown as Workspace,
    });
    expect(outcome.reloaded).toBe(true);
    const events = listEvents(db, "profile.updated");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload)).toEqual({ paths: ["set /identity/headline"] });
    db.close();
  });

  it("keeps the write when the reload fails and says why", () => {
    const paths = setup();
    const outcome = updateProfile([{ op: "set", path: "/identity/headline", value: "Staff Engineer" }], {
      paths: { ...paths } as never,
      reload: () => {
        throw new AppError("config_invalid", "campaign.json failed validation");
      },
    });
    expect(outcome).toMatchObject({ reloaded: false, reloadError: "[config_invalid] campaign.json failed validation" });
    expect(read(paths.profile).identity.headline).toBe("Staff Engineer");
  });
});
