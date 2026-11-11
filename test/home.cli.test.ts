import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHomeBundle } from "../src/cli/homeBundle.js";
import { resolvePaths, type WorkspacePaths } from "../src/config/paths.js";
import { openDatabase } from "../src/db/database.js";

/** The home-bundle CLI: passphrase from the environment only, never overwriting without --force. */

const PASSPHRASE = "correct horse battery staple 2026";
const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(label: string): WorkspacePaths {
  const dir = mkdtempSync(join(tmpdir(), `autoapply-cli-${label}-`));
  created.push(dir);
  const saved = process.env.AUTOAPPLY_HOME;
  process.env.AUTOAPPLY_HOME = dir;
  try {
    return resolvePaths();
  } finally {
    if (saved === undefined) delete process.env.AUTOAPPLY_HOME;
    else process.env.AUTOAPPLY_HOME = saved;
  }
}

function run(paths: WorkspacePaths, argv: string[], passphrase: string | null = PASSPHRASE) {
  const out: string[] = [];
  const err: string[] = [];
  const status = runHomeBundle({
    argv,
    paths,
    env: passphrase === null ? {} : { AUTOAPPLY_BUNDLE_PASSPHRASE: passphrase },
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  });
  return { status, out: out.join("\n"), err: err.join("\n") };
}

function seeded(): WorkspacePaths {
  const paths = home("source");
  writeFileSync(paths.profile, JSON.stringify({ version: 1, identity: { fullName: "Alex Candidate" }, resumes: [] }));
  writeFileSync(paths.campaign, JSON.stringify({ version: 1, name: "test" }));
  openDatabase(paths.database).close();
  return paths;
}

describe("autoapply home bundle CLI", () => {
  it("exports to a file and imports it into an empty home", () => {
    const source = seeded();
    const file = join(source.home, "..", `${source.home.split(/[\\/]/).pop()}.aahb`);
    created.push(file);

    const exported = run(source, ["export", "--out", file]);
    expect(exported.status, exported.err).toBe(0);
    expect(exported.out).toMatch(/exported 3 files/);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).subarray(0, 4).toString()).toBe("AAHB");

    const target = home("target");
    const imported = run(target, ["import", "--in", file]);
    expect(imported.status, imported.err).toBe(0);
    expect(imported.out).toMatch(/imported 3 files/);
    expect(JSON.parse(readFileSync(target.campaign, "utf8")).name).toBe("test");
  });

  it("takes the passphrase only from AUTOAPPLY_BUNDLE_PASSPHRASE", () => {
    const source = seeded();
    const result = run(source, ["export", "--out", join(source.home, "x.aahb")], null);
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/AUTOAPPLY_BUNDLE_PASSPHRASE/);
    expect(existsSync(join(source.home, "x.aahb"))).toBe(false);
  });

  it("will not overwrite an existing bundle file without --force", () => {
    const source = seeded();
    const file = join(source.home, "existing.aahb");
    writeFileSync(file, "keep me");
    expect(run(source, ["export", "--out", file]).status).toBe(1);
    expect(readFileSync(file, "utf8")).toBe("keep me");
    expect(run(source, ["export", "--out", file, "--force"]).status).toBe(0);
  });

  it("explains a refused import and prints usage for anything else", () => {
    const source = seeded();
    const file = join(source.home, "bundle.aahb");
    run(source, ["export", "--out", file]);
    const occupied = seeded();
    mkdirSync(occupied.home, { recursive: true });
    const refused = run(occupied, ["import", "--in", file]);
    expect(refused.status).toBe(1);
    expect(refused.err).toMatch(/home_not_empty/);
    expect(run(source, ["frobnicate"]).status).toBe(2);
    expect(run(source, ["import"]).err).toMatch(/usage/);
  });
});
