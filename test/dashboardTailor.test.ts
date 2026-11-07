import { homedir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { http, jsonBody, startFixture, type Fixture } from "./dashboardFixture.js";

/**
 * Rendering needs Chromium, so the document service is stubbed here: these
 * tests are about what the dashboard passes on. A font warning or a next step
 * names a file under the home folder; the browser sees `~` instead.
 */

vi.mock("../src/documents/resumeService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/documents/resumeService.js")>();
  const { homedir: home } = await import("node:os");
  const { join } = await import("node:path");
  const root = join(home(), ".autoapply");
  const warning = `fonts not found in ${join(root, "resumes", "fonts")}: lmroman10-regular.ttf; a fallback serif is used instead`;
  const checks = { ok: true, pages: 1, warnings: [warning] };
  return {
    ...actual,
    generateTailoredResume: vi.fn(async (_workspace: unknown, applicationId: string) => ({
      applicationId,
      documentId: "tdoc_stub",
      path: join(root, "documents", applicationId, "resume-stub.pdf"),
      sha256: "stub",
      bytes: 10,
      pages: 1,
      variantId: "ai-security",
      headline: { text: "Security Engineer", source: "variant" },
      status: "awaiting_approval",
      packetHash: "hash",
      previousResumePath: join(root, "resumes", "ai-security.pdf"),
      approvalVoided: false,
      changes: [],
      swaps: [],
      addedSkills: [],
      dropped: [],
      jobTerms: [],
      checks,
      warnings: [warning],
    })),
    renderResumeVariant: vi.fn(async (_workspace: unknown, resumeId: string) => ({
      resumeId,
      path: join(root, "documents", "variants", `${resumeId}.pdf`),
      sha256: "stub",
      bytes: 10,
      pages: 1,
      variantFound: true,
      profilePath: null,
      usedByProfile: false,
      checks,
      warnings: [warning],
      nextStep: `To upload this file for the "${resumeId}" track, set its profile.resumes path to ${join(root, "documents", "variants", `${resumeId}.pdf`)}.`,
    })),
  };
});

let fixture: Fixture;
let port: number;

beforeAll(async () => {
  fixture = await startFixture("dashboard-tailor");
  port = fixture.port;
});

afterAll(async () => {
  await fixture.close();
});

const home = homedir().toLowerCase();
const texts = (body: { path: string; warnings: string[]; checks: { warnings: string[] }; nextStep?: string; previousResumePath?: string }) =>
  [body.path, body.nextStep ?? "", body.previousResumePath ?? "", ...body.warnings, ...body.checks.warnings];

describe("rendering results name no home folder", () => {
  it("tailoring an application", async () => {
    const response = await http(port, "/api/documents/app_held/tailor", { method: "POST", ...jsonBody(port, {}) });
    expect(response.status).toBe(200);
    const body = response.json<Parameters<typeof texts>[0]>();
    for (const text of texts(body)) expect(text.toLowerCase()).not.toContain(home);
    expect(body.warnings[0]).toMatch(/^fonts not found in ~/);
  });

  it("rendering a track variant", async () => {
    const response = await http(port, "/api/documents/variants/ai-security/render", { method: "POST", ...jsonBody(port, {}) });
    expect(response.status).toBe(200);
    const body = response.json<Parameters<typeof texts>[0]>();
    for (const text of texts(body)) expect(text.toLowerCase()).not.toContain(home);
    expect(body.nextStep).toContain("~");
  });
});
