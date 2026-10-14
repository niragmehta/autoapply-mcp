import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COLLECT_FIELDS, runApplicationForm } from "../src/submission/browser.js";
import type { FieldDescriptor } from "../src/submission/formFields.js";
import type { SubmissionPacket } from "../src/submission/packet.js";
import { makeCampaign } from "./factories.js";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("playwright", () => ({ chromium: { launch } }));

const APPLY_URL = "https://jobs.lever.co/example/0000/apply";

/**
 * A held Lever form. `submitAfterPolls` models the person clicking Submit in
 * the open window: that many waits after the form was captured, the page
 * moves to Lever's thank-you route.
 */
function heldForm(submitAfterPolls: number | null, formText = "Submit your application") {
  const fields: FieldDescriptor[] = [
    { selectorIndex: 0, label: "Full name", type: "text", name: "name", required: true },
  ];
  let url = APPLY_URL;
  let body = formText;
  let captured = false;
  let pollsAfterCapture = 0;
  const locator = (selector: string): Record<string, unknown> => {
    const present = selector === "body" || selector === 'input[type="file"]' || selector.startsWith("[data-autoapply-idx=");
    const self: Record<string, unknown> = {
      first: () => self,
      nth: () => self,
      count: async () => (present ? 1 : 0),
      isVisible: async () => present,
      isEnabled: async () => true,
      fill: async () => undefined,
      setInputFiles: async () => undefined,
      click: async () => undefined,
      innerText: async () => (selector === "body" ? body : ""),
      getAttribute: async () => null,
      waitFor: async () => undefined,
    };
    return self;
  };
  const page = {
    goto: vi.fn(async () => undefined),
    url: () => url,
    waitForLoadState: async () => undefined,
    waitForTimeout: vi.fn(async () => {
      if (!captured) return;
      pollsAfterCapture += 1;
      if (submitAfterPolls !== null && pollsAfterCapture === submitAfterPolls) {
        url = "https://jobs.lever.co/example/0000/thanks";
        body = "Application submitted! Thank you for your interest in Example.";
      }
    }),
    locator,
    evaluate: async (script: unknown) => (script === COLLECT_FIELDS ? fields : []),
    screenshot: vi.fn(async (options: { path: string }) => {
      if (options.path.includes("-prepared-")) captured = true;
    }),
    on: vi.fn(),
    off: vi.fn(),
  };
  launch.mockResolvedValue({ newContext: async () => ({ newPage: async () => page }), close: vi.fn(async () => undefined) });
  return { page, polls: () => pollsAfterCapture };
}

let directories: string[] = [];

function packetFixture(): { packet: SubmissionPacket; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "autoapply-assisted-hold-"));
  directories = [...directories, directory];
  const resumePath = join(directory, "resume.pdf");
  writeFileSync(resumePath, "%PDF-1.4\nLocal synthetic assisted-hold fixture\n");
  return {
    directory,
    packet: {
      applicationId: "app_assisted_hold",
      jobId: "job_assisted_hold",
      company: "Example",
      jobTitle: "Senior Software Engineer",
      applyUrl: APPLY_URL,
      resumeId: "test",
      resumePath,
      coverLetter: "",
      answers: [
        { questionKey: "name", label: "Full name", answer: "Test Candidate", source: "profile",
          citation: "test fixture", requiresHuman: false, required: true, category: "contact", guidance: "" },
      ],
    },
  };
}

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories = [];
  launch.mockReset();
});

const policy = { ...makeCampaign().submission, allowedAtsDomains: ["jobs.lever.co"] };

describe("a form held open for a person to submit", () => {
  it("returns as soon as the person's submission is confirmed", async () => {
    const fake = heldForm(4);
    const { packet, directory } = packetFixture();

    const result = await runApplicationForm(packet, { submit: false, artifactsDir: directory, policy, keepOpenMs: 600_000 });

    expect(result.status).toBe("submitted");
    expect(result.finalUrl).toContain("/thanks");
    expect(result.confirmationText).toMatch(/application submitted/i);
    expect(fake.polls()).toBeLessThan(10);
  });

  it("still reports prepared when nobody submits before the hold ends", async () => {
    const fake = heldForm(null);
    const { packet, directory } = packetFixture();

    const result = await runApplicationForm(packet, { submit: false, artifactsDir: directory, policy, keepOpenMs: 9_000 });

    expect(result.status).toBe("prepared");
    expect(fake.polls()).toBeGreaterThan(0);
  });

  it("does not mistake confirmation wording already on the form for a submission", async () => {
    heldForm(null, "Submit your application. Thank you for applying to Example!");
    const { packet, directory } = packetFixture();

    const result = await runApplicationForm(packet, { submit: false, artifactsDir: directory, policy, keepOpenMs: 9_000 });

    expect(result.status).toBe("prepared");
  });
});
