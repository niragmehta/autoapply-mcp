import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearer, http, jsonBody, startFixture, type Fixture } from "./dashboardFixture.js";

/**
 * Settings: the answers library in profile.json (validated, written atomically
 * with a timestamped backup, then reloaded), locks on legally material answers,
 * the AI-policy question that always stays "ask me", read-only campaign and
 * profile summaries, and the three documents toggles.
 */

const ANSWERS = [
  { key: "source", label: "How did you hear about us?", patterns: ["how did you hear"], answer: "Company careers page", allowAutoFill: true },
  { key: "visa-sponsorship", label: "Require visa sponsorship", patterns: ["require visa sponsorship"], answer: "", allowAutoFill: false },
  { key: "work-authorization-statement", label: "Work authorization status", patterns: ["authorized to work for any employer"], answer: "", allowAutoFill: false },
  { key: "us-person-status", label: "Are you a U.S. Person", patterns: ["u.s. person"], answer: "", allowAutoFill: false },
  { key: "gender-self-id", label: "Gender self-identification", patterns: ["gender"], answer: "Decline to self-identify", allowAutoFill: true },
  { key: "ai-policy", label: "AI policy for application", patterns: ["ai policy", "did you use ai"], answer: "", allowAutoFill: false },
  { key: "ai-tools-usage", label: "What AI tools are you currently using", patterns: ["what ai tools"], answer: "", allowAutoFill: true },
];

type Row = {
  key: string;
  label: string;
  answer: string;
  allowAutoFill: boolean;
  skip: boolean;
  patterns: string[];
  version: string;
  aiPolicy: boolean;
  lock: { groups: string[]; consequence: string } | null;
};
type Listing = { total: number; count: number; answers: Row[]; groups: Array<{ id: string; label: string; count: number }> };
type Receipt = { backup: string | null; reloaded: boolean; mcpReload: string };

let fixture: Fixture;
let port: number;

beforeAll(async () => {
  fixture = await startFixture("dashboard-settings", { profile: { answers: ANSWERS } });
  port = fixture.port;
});

afterAll(async () => {
  await fixture.close();
});

const get = async <T,>(path: string) => {
  const response = await http(port, path, { headers: bearer() });
  expect(response.status, `${path}: ${response.text.slice(0, 300)}`).toBe(200);
  return response.json<T>();
};
const send = (method: string, path: string, body?: unknown) =>
  body === undefined
    ? http(port, path, { method, headers: bearer({ origin: `http://127.0.0.1:${port}` }) })
    : http(port, path, { method, ...jsonBody(port, body) });
const errorOf = (response: { json: <T>() => T }) => response.json<{ error: Record<string, unknown> }>().error;
const rowOf = async (key: string) => (await get<Listing>("/api/settings/answers")).answers.find((row) => row.key === key);
const fileAnswers = () => (JSON.parse(readFileSync(join(fixture.home, "profile.json"), "utf8")) as { answers: Array<Record<string, unknown>> }).answers;
const backups = (name: string) => readdirSync(fixture.home).filter((file) => file.startsWith(`${name}.bak-`));

describe("settings writes need a session and the same origin", () => {
  const writes: Array<[string, string, unknown]> = [
    ["POST", "/api/settings/answers", { answer: { key: "x", label: "X", patterns: ["x"] } }],
    ["PATCH", "/api/settings/answers/source", { version: "v", answer: { key: "source", label: "S", patterns: ["s"] } }],
    ["DELETE", "/api/settings/answers/source?version=v", undefined],
    ["PATCH", "/api/settings/documents", { tailorResume: true }],
  ];

  it.each(writes)("%s %s", async (method, path, body) => {
    const payload = body === undefined ? {} : { body: JSON.stringify(body) };
    const anonymous = await http(port, path, {
      method,
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      ...payload,
    });
    expect(anonymous.status).toBe(401);
    const crossSite = await http(port, path, {
      method,
      headers: bearer({ "content-type": "application/json", origin: "https://evil.example" }),
      ...payload,
    });
    expect(crossSite.status).toBe(403);
    expect(backups("profile.json")).toHaveLength(0);
  });
});

describe("the answers library", () => {
  it("lists every answer with its lock and the AI-policy question marked", async () => {
    const listing = await get<Listing>("/api/settings/answers");
    expect(listing.total).toBe(ANSWERS.length);
    const byKey = new Map(listing.answers.map((row) => [row.key, row]));
    expect(byKey.get("source")?.lock).toBeNull();
    expect(byKey.get("visa-sponsorship")?.lock?.groups).toEqual(["sponsorship"]);
    expect(byKey.get("work-authorization-statement")?.lock?.groups).toEqual(["work-authorization"]);
    expect(byKey.get("us-person-status")?.lock?.groups).toEqual(["us-person"]);
    expect(byKey.get("gender-self-id")?.lock?.groups).toEqual(["demographics"]);
    expect(byKey.get("gender-self-id")?.lock?.consequence).toMatch(/self-identification/i);
    expect(byKey.get("ai-policy")).toMatchObject({ aiPolicy: true, lock: null });
    expect(byKey.get("ai-tools-usage")?.aiPolicy).toBe(false);
    expect(byKey.get("source")?.version).toMatch(/^[0-9a-f]{16}$/);
    expect(listing.groups.find((group) => group.id === "demographics")?.count).toBe(1);
  });

  it("reads one answer by key, for links straight to it", async () => {
    const one = await get<{ answer: Row }>("/api/settings/answers/visa-sponsorship");
    expect(one.answer).toMatchObject({ key: "visa-sponsorship", lock: { groups: ["sponsorship"] } });
    expect((await http(port, "/api/settings/answers/nothing-here", { headers: bearer() })).status).toBe(404);
  });

  it("searches and filters by lock group", async () => {
    expect((await get<Listing>("/api/settings/answers?q=visa")).answers.map((row) => row.key)).toEqual(["visa-sponsorship"]);
    expect((await get<Listing>("/api/settings/answers?group=demographics")).answers.map((row) => row.key)).toEqual(["gender-self-id"]);
    expect((await get<Listing>("/api/settings/answers?group=locked")).count).toBe(4);
    expect((await http(port, "/api/settings/answers?group=nonsense", { headers: bearer() })).status).toBe(400);
  });

  it("adds an answer, keeps a dated backup and reloads the dashboard's profile", async () => {
    const created = await send("POST", "/api/settings/answers", {
      answer: { key: "start-date", label: "Earliest start date", patterns: ["start date"], answer: "Two weeks after an offer", allowAutoFill: true },
    });
    expect(created.status, created.text).toBe(201);
    const body = created.json<{ answer: Row; saved: Receipt }>();
    expect(body.answer).toMatchObject({ key: "start-date", answer: "Two weeks after an offer", allowAutoFill: true, lock: null });
    expect(body.saved.backup).toMatch(/profile\.json\.bak-\d{8}T\d{6}/);
    expect(body.saved.reloaded).toBe(true);
    expect(body.saved.mcpReload).toMatch(/reload_config/);
    expect(backups("profile.json").length).toBeGreaterThanOrEqual(1);
    expect(fileAnswers().map((entry) => entry.key)).toContain("start-date");
    const summary = await get<{ counts: { answers: number } }>("/api/settings/profile");
    expect(summary.counts.answers).toBe(ANSWERS.length + 1);
  });

  it("refuses an invalid answer and a duplicate key, writing nothing", async () => {
    const before = backups("profile.json").length;
    const invalid = await send("POST", "/api/settings/answers", { answer: { key: "empty", label: "Empty", patterns: [] } });
    expect(invalid.status).toBe(400);
    expect((errorOf(invalid).issues as Array<{ path: string }>).map((issue) => issue.path)).toContain("answer.patterns");
    const duplicate = await send("POST", "/api/settings/answers", { answer: { key: "source", label: "Again", patterns: ["again"] } });
    expect(duplicate.status).toBe(409);
    expect(errorOf(duplicate).code).toBe("answer_exists");
    expect(backups("profile.json").length).toBe(before);
  });

  it("edits an answer only from the version it was read at", async () => {
    const row = await rowOf("source");
    const stale = await send("PATCH", "/api/settings/answers/source", { version: "0000000000000000", answer: { ...ANSWERS[0], answer: "Referral" } });
    expect(stale.status).toBe(409);
    expect(errorOf(stale).code).toBe("answer_changed");
    const saved = await send("PATCH", "/api/settings/answers/source", { version: row?.version, answer: { ...ANSWERS[0], answer: "Referral" } });
    expect(saved.status, saved.text).toBe(200);
    const after = saved.json<{ answer: Row }>().answer;
    expect(after.answer).toBe("Referral");
    expect(after.version).not.toBe(row?.version);
    expect(fileAnswers().find((entry) => entry.key === "source")?.answer).toBe("Referral");
    const missing = await send("PATCH", "/api/settings/answers/nothing-here", { version: "0000000000000000", answer: { key: "nothing-here", label: "N", patterns: ["n"] } });
    expect(missing.status).toBe(404);
  });

  it("deletes an answer with its version", async () => {
    const row = await rowOf("start-date");
    const deleted = await send("DELETE", `/api/settings/answers/start-date?version=${row?.version}`);
    expect(deleted.status, deleted.text).toBe(200);
    expect(fileAnswers().map((entry) => entry.key)).not.toContain("start-date");
  });
});

describe("locked answers", () => {
  it("refuses to change a work-authorization or sponsorship answer until it is unlocked", async () => {
    const row = await rowOf("visa-sponsorship");
    const change = { ...ANSWERS[1], answer: "No" };
    const locked = await send("PATCH", "/api/settings/answers/visa-sponsorship", { version: row?.version, answer: change });
    expect(locked.status).toBe(409);
    expect(errorOf(locked)).toMatchObject({ code: "answer_locked", lock: { groups: ["sponsorship"] } });
    const unlocked = await send("PATCH", "/api/settings/answers/visa-sponsorship", { version: row?.version, answer: change, unlock: true });
    expect(unlocked.status, unlocked.text).toBe(200);
    expect(unlocked.json<{ answer: Row }>().answer).toMatchObject({ answer: "No", lock: { groups: ["sponsorship"] } });
  });

  it("asks for the unlock to add or delete one too", async () => {
    const h1b = { key: "h1b", label: "Will you need H-1B sponsorship?", patterns: ["h-1b"], answer: "" };
    expect(errorOf(await send("POST", "/api/settings/answers", { answer: h1b })).code).toBe("answer_locked");
    expect((await send("POST", "/api/settings/answers", { answer: h1b, unlock: true })).status).toBe(201);
    const row = await rowOf("us-person-status");
    const refused = await send("DELETE", `/api/settings/answers/us-person-status?version=${row?.version}`);
    expect(errorOf(refused).code).toBe("answer_locked");
    expect((await send("DELETE", `/api/settings/answers/us-person-status?version=${row?.version}&unlock=true`)).status).toBe(200);
  });
});

describe("the AI-policy question", () => {
  it("can never be given an automatic answer", async () => {
    const row = await rowOf("ai-policy");
    const base = ANSWERS[5];
    if (!base) throw new Error("fixture is missing the ai-policy answer");
    for (const change of [{ answer: "No" }, { allowAutoFill: true }, { skip: true }, { alternatives: ["No"] }]) {
      const refused = await send("PATCH", "/api/settings/answers/ai-policy", { version: row?.version, answer: { ...base, ...change } });
      expect(refused.status, JSON.stringify(change)).toBe(422);
      expect(errorOf(refused).code).toBe("ai_policy_ask_me");
    }
    const patterns = await send("PATCH", "/api/settings/answers/ai-policy", { version: row?.version, answer: { ...base, patterns: [...base.patterns, "ai usage attestation"] } });
    expect(patterns.status, patterns.text).toBe(200);
    expect(fileAnswers().find((entry) => entry.key === "ai-policy")).toMatchObject({ answer: "", allowAutoFill: false });
  });

  it("refuses a new answer that would answer it, and keeps it in the library", async () => {
    const sneaky = { key: "ai-attest", label: "Did you use AI in this application?", patterns: ["did you use ai"], answer: "No", allowAutoFill: true };
    expect(errorOf(await send("POST", "/api/settings/answers", { answer: sneaky })).code).toBe("ai_policy_ask_me");
    const row = await rowOf("ai-policy");
    const removed = await send("DELETE", `/api/settings/answers/ai-policy?version=${row?.version}&unlock=true`);
    expect(removed.status).toBe(409);
    expect(errorOf(removed).code).toBe("ai_policy_required");
  });
});

describe("campaign and profile", () => {
  it("summarizes the campaign read-only: tracks, tiers, limits and the documents policy", async () => {
    const campaign = await get<{
      name: string;
      tracks: Array<{ id: string }>;
      tiers: { A: number; B: number; C: number };
      submission: { dailyLimit: number | null; mode: string };
      runner: { roundCap: { max: number } | null };
      documents: { tailorResume: boolean; maxSwaps: number; maxAddedSkills: number };
      editable: string[];
    }>("/api/settings/campaign");
    expect(campaign.name).toBe("dashboard-test-campaign");
    expect(campaign.tracks.map((track) => track.id)).toEqual(["ai-security"]);
    expect(campaign.tiers).toEqual({ A: 85, B: 75, C: 68 });
    expect(campaign.submission).toMatchObject({ dailyLimit: 20, mode: "auto" });
    expect(campaign.runner.roundCap?.max).toBe(2);
    expect(campaign.documents).toMatchObject({ tailorResume: false, maxSwaps: 2, maxAddedSkills: 4 });
    expect(campaign.editable).toEqual(["documents.tailorResume", "documents.maxSwaps", "documents.maxAddedSkills"]);
  });

  it("summarizes the profile", async () => {
    const summary = await get<{ identity: { fullName: string }; counts: Record<string, number>; resumes: Array<{ id: string }> }>("/api/settings/profile");
    expect(summary.identity.fullName).toBe("Alex Candidate");
    expect(summary.counts).toMatchObject({ facts: 1, skills: 1, resumes: 1 });
    expect(summary.resumes.map((resume) => resume.id)).toEqual(["ai-security"]);
  });

  it("toggles tailoring and its limits, and nothing else in campaign.json", async () => {
    const saved = await send("PATCH", "/api/settings/documents", { tailorResume: true, maxSwaps: 3 });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.json<{ documents: { tailorResume: boolean; maxSwaps: number }; saved: Receipt }>()).toMatchObject({
      documents: { tailorResume: true, maxSwaps: 3, maxAddedSkills: 4 },
      saved: { reloaded: true },
    });
    const onDisk = JSON.parse(readFileSync(join(fixture.home, "campaign.json"), "utf8")) as { documents: Record<string, unknown> };
    expect(onDisk.documents).toMatchObject({ tailorResume: true, maxSwaps: 3 });
    expect(backups("campaign.json").length).toBeGreaterThanOrEqual(1);
    const meta = await get<{ documents: { tailorResume: boolean } }>("/api/meta");
    expect(meta.documents.tailorResume).toBe(true);

    expect((await send("PATCH", "/api/settings/documents", { maxSwaps: 11 })).status).toBe(400);
    expect((await send("PATCH", "/api/settings/documents", { coverLetterPdf: true })).status).toBe(400);
    expect((await send("PATCH", "/api/settings/documents", {})).status).toBe(400);
    expect(existsSync(join(fixture.home, "campaign.json.tmp"))).toBe(false);
  });
});
