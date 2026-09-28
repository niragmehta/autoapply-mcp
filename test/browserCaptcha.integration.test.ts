import { mkdtempSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COLLECT_FIELDS, runApplicationForm } from "../src/submission/browser.js";
import type { FieldDescriptor } from "../src/submission/formFields.js";
import type { SubmissionPacket } from "../src/submission/packet.js";
import { makeCampaign } from "./factories.js";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("playwright", () => ({ chromium: { launch } }));

type Trigger = "upload" | "fill" | "screenshot" | "submit-inspection" | "never";
type LocatorDouble = {
  first(): LocatorDouble;
  nth(index: number): LocatorDouble;
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  fill(value: string): Promise<void>;
  setInputFiles(path: string): Promise<void>;
  click(): Promise<void>;
  innerText(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  waitFor(): Promise<void>;
};

function browserDouble(trigger: Trigger) {
  let challengeVisible = false;
  let events: string[] = [];
  const fields: FieldDescriptor[] = [
    { selectorIndex: 0, label: "Full name", type: "text", name: "name", required: true },
    { selectorIndex: 1, label: "Email", type: "email", name: "email", required: true },
  ];
  const locator = (selector: string, index?: number): LocatorDouble => {
    const challenge = selector === 'iframe[title*="challenge" i]' ||
      (selector.includes("hcaptcha") && selector.includes("frame=challenge"));
    const total = challenge ? 2 : selector === 'input[type="file"]' ||
      selector === "body" || selector.startsWith("[data-autoapply-idx=") ||
      selector === 'button[type="submit"]' ? 1 : 0;
    return {
      first: () => locator(selector, 0),
      nth: (position) => locator(selector, position),
      count: async () => index === undefined ? total : Number(index < total),
      isVisible: async () => challenge ? index === 1 && challengeVisible : total > 0,
      isEnabled: async () => true,
      fill: async () => {
        events = [...events, "fill"];
        if (trigger === "fill") challengeVisible = true;
      },
      setInputFiles: async () => {
        events = [...events, "upload"];
        if (trigger === "upload") challengeVisible = true;
      },
      click: async () => { events = [...events, "submit"]; },
      innerText: async () => events.includes("submit") ? "Your application has been submitted." : "Submit your application",
      getAttribute: async (name) => {
        if (trigger === "submit-inspection" && name === "aria-disabled") challengeVisible = true;
        return null;
      },
      waitFor: async () => undefined,
    };
  };
  const page = {
    goto: vi.fn(async () => undefined),
    url: () => "https://jobs.lever.co/captcha-regression/example/apply",
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
    locator,
    evaluate: async (script: unknown) => script === COLLECT_FIELDS ? fields : [],
    screenshot: vi.fn(async (options: { path: string }) => {
      if (trigger === "screenshot" && options.path.includes("-prepared-")) challengeVisible = true;
    }),
    on: vi.fn(),
    off: vi.fn(),
  };
  const close = vi.fn(async () => undefined);
  launch.mockResolvedValue({ newContext: async () => ({ newPage: async () => page }), close });
  return { page, close, get events() { return [...events]; } };
}

let fixtures: Array<{ directory: string; resumePath: string }> = [];

function packetFixture(): { packet: SubmissionPacket; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "autoapply-captcha-regression-"));
  const resumePath = join(directory, "resume.pdf");
  writeFileSync(resumePath, "%PDF-1.4\nLocal synthetic CAPTCHA regression fixture\n");
  fixtures = [...fixtures, { directory, resumePath }];
  return {
    directory,
    packet: {
      applicationId: "app_captcha_regression", jobId: "job_captcha_regression",
      company: "Example", jobTitle: "Software Engineer",
      applyUrl: "https://jobs.lever.co/captcha-regression/example/apply",
      resumeId: "test", resumePath, coverLetter: "",
      answers: [
        { questionKey: "name", label: "Full name", answer: "Test Candidate", source: "profile",
          citation: "test fixture", requiresHuman: false, required: true, category: "contact", guidance: "" },
        { questionKey: "email", label: "Email", answer: "candidate@example.test", source: "profile",
          citation: "test fixture", requiresHuman: false, required: true, category: "contact", guidance: "" },
      ],
    },
  };
}

afterEach(() => {
  for (const fixture of fixtures) {
    rmSync(fixture.resumePath);
    rmdirSync(fixture.directory);
  }
  fixtures = [];
  launch.mockReset();
});

describe("late interactive CAPTCHA guards", () => {
  it.each(["upload", "fill", "screenshot"] as const)(
    "does not report prepared when a later challenge iframe becomes visible after %s",
    async (trigger) => {
      const fake = browserDouble(trigger);
      const { packet, directory } = packetFixture();

      const result = await runApplicationForm(packet, {
        submit: false, artifactsDir: directory,
        policy: { ...makeCampaign().submission, allowedAtsDomains: ["jobs.lever.co"] },
      });

      expect(result.status).toBe("aborted");
      expect(result.captchaDetected).toBe(true);
      expect(result.reason).toMatch(/human|captcha/i);
      expect(result.screenshotPath).toContain("-captcha-");
      expect(fake.events).not.toContain("submit");
      expect(fake.close).toHaveBeenCalledOnce();
    },
  );

  it("stops before clicking submit when the challenge appears during submit-control inspection", async () => {
    const fake = browserDouble("submit-inspection");
    const { packet, directory } = packetFixture();

    const result = await runApplicationForm(packet, {
      submit: true, artifactsDir: directory,
      policy: { ...makeCampaign().submission, allowedAtsDomains: ["jobs.lever.co"] },
    });

    expect(result.status).toBe("aborted");
    expect(result.captchaDetected).toBe(true);
    expect(fake.events).not.toContain("submit");
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("still prepares an ordinary form with only hidden challenge frames", async () => {
    const fake = browserDouble("never");
    const { packet, directory } = packetFixture();

    const result = await runApplicationForm(packet, {
      submit: false, artifactsDir: directory,
      policy: { ...makeCampaign().submission, allowedAtsDomains: ["jobs.lever.co"] },
    });

    expect(result.status).toBe("prepared");
    expect(result.captchaDetected).toBe(false);
    expect(result.unmatchedRequired).toEqual([]);
    expect(fake.events).toEqual(["upload", "fill", "fill"]);
  });
});
