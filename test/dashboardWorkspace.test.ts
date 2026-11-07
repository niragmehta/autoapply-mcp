import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getWorkspace } from "../src/config/load.js";
import { insertTailoredDocument } from "../src/db/repositories/documents.js";
import { CAREER_PROFILE } from "./dashboardCareerFixture.js";
import { bearer, http, jsonBody, startFixture, type Fixture } from "./dashboardFixture.js";

/**
 * The application workspace before submission: editing the cover letter,
 * answers and notes through setApplicationContent (which voids approval),
 * a fact check of the letter that informs without blocking, and past
 * tailoring with every change it made.
 */

let fixture: Fixture;
let port: number;

const get = async <T = Record<string, unknown>>(path: string) => {
  const response = await http(port, path, { headers: bearer() });
  expect(response.status, `${path}: ${response.text.slice(0, 300)}`).toBe(200);
  return response.json<T>();
};

const send = (method: string, path: string, body: unknown) => http(port, path, { method, ...jsonBody(port, body) });
const errorOf = (response: { json: <T>() => T }) => response.json<{ error: Record<string, unknown> }>().error;

beforeAll(async () => {
  fixture = await startFixture("dashboard-workspace", { profile: CAREER_PROFILE });
  port = fixture.port;
});

afterAll(async () => {
  await fixture.close();
});

type FactCheck = { ok: boolean; issues: Array<{ kind: string; token: string }>; checked: Record<string, number> } | null;

describe("writes need a session and the same origin", () => {
  const writes: Array<[string, unknown]> = [
    ["/api/applications/app_held/content", { notes: "x" }],
    ["/api/applications/app_held/cover-letter/check", { text: "Hello." }],
  ];

  it.each(writes)("POST %s", async (path, body) => {
    const anonymous = await http(port, path, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify(body),
    });
    expect(anonymous.status).toBe(401);
    const crossSite = await http(port, path, { method: "POST", ...jsonBody(port, body, { origin: "https://evil.example" }) });
    expect(crossSite.status).toBe(403);
  });
});

describe("editing the packet", () => {
  it("saves answers, then a letter and notes, and says plainly the approval is void", async () => {
    const answered = await send("POST", "/api/applications/app_held/content", { answers: [{ questionKey: "sponsor", answer: "Yes" }] });
    expect(answered.status).toBe(200);
    expect(answered.json()).toMatchObject({ status: "awaiting_approval", outstandingQuestions: [], approvalVoided: false, factCheck: null });

    const preview = await get<{ preview: { packetHash: string } }>("/api/applications/app_held");
    expect((await send("POST", "/api/applications/app_held/approve", { packetHash: preview.preview.packetHash })).status).toBe(200);

    const letter = "Dear hiring team,\n\nI built an AI guardrail framework adopted by 12 product teams.\n\nAlex Candidate";
    const saved = await send("POST", "/api/applications/app_held/content", { coverLetter: letter, notes: "Referred by a former colleague." });
    const result = saved.json<{ status: string; approvalVoided: boolean; packetHash: string; factCheck: FactCheck }>();
    expect(result).toMatchObject({ status: "awaiting_approval", approvalVoided: true });
    expect(result.packetHash).not.toBe(preview.preview.packetHash);
    expect(result.factCheck?.issues.filter((issue) => issue.kind === "number")).toEqual([]);

    const detail = await get<{ application: { coverLetter: string; notes: string; status: string } }>("/api/applications/app_held");
    expect(detail.application).toMatchObject({ coverLetter: letter, notes: "Referred by a former colleague.", status: "awaiting_approval" });
  });

  it("reports unsupported claims in the letter without refusing to save it", async () => {
    const saved = await send("POST", "/api/applications/app_held/content", { coverLetter: "I cut cloud costs by 73% in a year." });
    expect(saved.status).toBe(200);
    const check = saved.json<{ factCheck: FactCheck }>().factCheck;
    expect(check?.ok).toBe(false);
    expect(check?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "number", token: "73%" })]));
  });

  it("checks a letter without saving anything", async () => {
    const before = await get<{ application: { coverLetter: string } }>("/api/applications/app_held");
    const checked = await send("POST", "/api/applications/app_held/cover-letter/check", { text: "I led 40 engineers." });
    expect(checked.status).toBe(200);
    expect(checked.json<NonNullable<FactCheck>>().issues).toEqual([expect.objectContaining({ kind: "number", token: "40" })]);
    expect((await get<{ application: { coverLetter: string } }>("/api/applications/app_held")).application.coverLetter).toBe(before.application.coverLetter);
    expect((await send("POST", "/api/applications/app_held/cover-letter/check", { text: "" })).status).toBe(400);
  });

  it("refuses empty or unknown input, a submitted application and a skipped one", async () => {
    expect((await send("POST", "/api/applications/app_held/content", {})).status).toBe(400);
    const unknown = await send("POST", "/api/applications/app_held/content", { answers: [{ questionKey: "made_up", answer: "x" }] });
    expect(unknown.status).toBe(400);
    expect(errorOf(unknown).code).toBe("unknown_question_key");
    const sent = await send("POST", "/api/applications/app_sent/content", { notes: "x" });
    expect(sent.status).toBe(409);
    expect(errorOf(sent).code).toBe("already_submitted");

    const preview = await get<{ preview: { packetHash: string } }>("/api/applications/app_held");
    await send("POST", "/api/applications/app_held/approve", { packetHash: preview.preview.packetHash, decision: "rejected" });
    const skipped = await send("POST", "/api/applications/app_held/content", { notes: "revive" });
    expect(skipped.status).toBe(409);
    expect(errorOf(skipped).code).toBe("application_skipped");
    expect((await http(port, "/api/applications/app_missing/content", { method: "POST", ...jsonBody(port, { notes: "x" }) })).status).toBe(404);
  });
});

describe("tailoring history", () => {
  it("lists every tailored resume with its full change log and a link to its PDF", async () => {
    const { db, paths } = getWorkspace();
    const dir = join(paths.documents, "app_held");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "resume-abc12345.pdf");
    writeFileSync(path, "%PDF-1.4\n%%EOF\n");
    insertTailoredDocument(db, {
      applicationId: "app_held",
      kind: "resume",
      path,
      sha256: "abc12345",
      variantId: "ai-security",
      changes: [
        { kind: "bullet-swapped", target: "acme-guardrails", message: "Swapped in a reserve bullet that names policy enforcement." },
        { kind: "skill-term-added", target: "skills", terms: ["Rust"], message: "Added Rust, which the posting names." },
        { kind: "bullet-moved", target: "acme-ci", from: 3, to: 1, terms: ["ci"], message: "Moved up for CI." },
      ],
      checks: { pages: 1, dropped: ["acme-old"], headline: { text: "Security Engineer", source: "variant" }, warnings: [] },
    });

    const history = await get<{
      entries: Array<{ id: string; href: string | null; current: boolean; changes: Array<{ kind: string }>; dropped: string[]; pages: number | null }>;
      policy: { tailorResume: boolean };
    }>("/api/applications/app_held/tailoring");
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({ current: false, dropped: ["acme-old"], pages: 1 });
    expect(history.entries[0]?.changes.map((change) => change.kind)).toEqual(["bullet-swapped", "skill-term-added", "bullet-moved"]);
    expect(history.entries[0]?.href).toMatch(/^\/api\/documents\/files\//);
    expect(typeof history.policy.tailorResume).toBe("boolean");
    expect((await http(port, "/api/applications/app_missing/tailoring", { headers: bearer() })).status).toBe(404);
  });
});
