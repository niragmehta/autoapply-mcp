import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeWorkspace, getWorkspace, reloadWorkspace } from "../src/config/load.js";
import { makeCampaign, makeProfile } from "./factories.js";

function seedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "autoapply-reload-"));
  writeFileSync(join(home, "profile.json"), JSON.stringify(makeProfile()));
  writeFileSync(join(home, "campaign.json"), JSON.stringify(makeCampaign()));
  writeFileSync(join(home, "companies.json"), JSON.stringify({ version: 1, companies: [] }));
  return home;
}

describe("reloading the workspace", () => {
  const previous = process.env.AUTOAPPLY_HOME;

  afterEach(() => {
    closeWorkspace();
    if (previous === undefined) delete process.env.AUTOAPPLY_HOME;
    else process.env.AUTOAPPLY_HOME = previous;
  });

  it("keeps the database handle an in-flight operation is still using", () => {
    const home = seedHome();
    process.env.AUTOAPPLY_HOME = home;
    const before = getWorkspace();

    const after = reloadWorkspace();

    expect(after.db).toBe(before.db);
    // The handle held by the earlier workspace object still works.
    expect(() => before.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).not.toThrow();
  });

  it("applies configuration edits made on disk", () => {
    const home = seedHome();
    process.env.AUTOAPPLY_HOME = home;
    getWorkspace();
    writeFileSync(join(home, "campaign.json"), JSON.stringify({ ...makeCampaign(), name: "edited-campaign" }));

    expect(reloadWorkspace().campaign.name).toBe("edited-campaign");
  });

  it("keeps the current workspace when an edit is invalid", () => {
    const home = seedHome();
    process.env.AUTOAPPLY_HOME = home;
    const before = getWorkspace();
    writeFileSync(join(home, "campaign.json"), "{ not json");

    expect(() => reloadWorkspace()).toThrow();
    expect(getWorkspace()).toBe(before);
  });
});
