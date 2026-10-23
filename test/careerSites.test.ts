import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DraftAnswerSchema, type DraftAnswer } from "../src/domain/job.js";
import {
  AMAZON_CONFIRMATION,
  careerBrowserChannel,
  careerProfileDir,
  careerSiteFor,
  googleConfirmed,
  googleStage,
  metaConfirmed,
  preferredLocationIndex,
  resumeUploadName,
} from "../src/submission/careerSites.js";

const GOOGLE_APPLY = "https://www.google.com/about/careers/applications/apply/abc123";
const GOOGLE_AFTER_APPLY = "https://www.google.com/about/careers/applications/";
const META_FORM = "https://www.metacareers.com/profile/create_application/1234567890123456/";
const META_POSTING = "https://www.metacareers.com/jobs/1234567890123456/";

function answer(label: string, value: string): DraftAnswer {
  return DraftAnswerSchema.parse({ questionKey: label, label, answer: value, source: "profile" });
}

describe("careerSiteFor", () => {
  it.each([
    ["https://www.google.com/about/careers/applications/jobs/results/123456789", "google"],
    ["https://google.com/about/careers/applications/apply/abc123/form", "google"],
    ["https://www.metacareers.com/jobs/1234567890123456/", "meta"],
    ["https://metacareers.com/profile/create_application/1234567890123456/", "meta"],
    ["https://WWW.MetaCareers.com/jobs/1/", "meta"],
    ["https://www.amazon.jobs/en/jobs/2800001/security-engineer", "amazon"],
    ["https://amazon.jobs/applicant/jobs/2800001/apply", "amazon"],
    ["https://account.amazon.jobs/en-US/applicant", "amazon"],
    ["https://jobs.apple.com/en-us/details/200612345-0836/software-engineer", "apple"],
  ])("recognizes %s as %s", (url, site) => {
    expect(careerSiteFor(url)).toBe(site);
  });

  it.each([
    // Google itself, but not its careers site.
    "https://www.google.com/search?q=security+engineer+jobs",
    // A lookalike host that merely starts with a career-site name.
    "https://www.metacareers.com.example.net/jobs/1/",
    "https://www.apple.com/careers/us/",
    "https://boards.greenhouse.io/acme/jobs/1",
    "not a url",
    "",
  ])("returns null for %j", (url) => {
    expect(careerSiteFor(url)).toBeNull();
  });
});

describe("browser profile settings", () => {
  const KEYS = ["AUTOAPPLY_BROWSER_PROFILE", "AUTOAPPLY_BROWSER_CHANNEL"] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe("careerProfileDir", () => {
    const home = join("synthetic-home", ".autoapply");

    it("defaults to a careers profile under the autoapply home", () => {
      expect(careerProfileDir(home)).toBe(join(home, "browser-profiles", "careers"));
    });

    it("uses AUTOAPPLY_BROWSER_PROFILE, trimmed, when it is set", () => {
      process.env.AUTOAPPLY_BROWSER_PROFILE = "  /profiles/jane-doe-careers  ";

      expect(careerProfileDir(home)).toBe("/profiles/jane-doe-careers");
    });

    it("ignores a blank AUTOAPPLY_BROWSER_PROFILE", () => {
      process.env.AUTOAPPLY_BROWSER_PROFILE = "   ";

      expect(careerProfileDir(home)).toBe(join(home, "browser-profiles", "careers"));
    });
  });

  describe("careerBrowserChannel", () => {
    it("defaults to the installed Chrome", () => {
      // A profile signed in by hand in Chrome is only readable by the same browser build.
      expect(careerBrowserChannel()).toBe("chrome");
    });

    it.each([
      ["msedge", "msedge"],
      [" Chrome-Beta ", "chrome-beta"],
      ["   ", "chrome"],
    ])("maps AUTOAPPLY_BROWSER_CHANNEL=%j to %j", (configured, channel) => {
      process.env.AUTOAPPLY_BROWSER_CHANNEL = configured;

      expect(careerBrowserChannel()).toBe(channel);
    });

    it.each(["chromium", " CHROMIUM "])("selects Playwright's bundled browser for %j", (configured) => {
      process.env.AUTOAPPLY_BROWSER_CHANNEL = configured;

      expect(careerBrowserChannel()).toBeUndefined();
    });
  });
});

describe("preferredLocationIndex", () => {
  it("picks the offered location in the same area as a relocation target", () => {
    // "Sunnyvale, CA" satisfies a "San Francisco Bay Area" target.
    expect(preferredLocationIndex(["", "Seattle, WA, USA", "Sunnyvale, CA, USA"], ["San Francisco Bay Area"])).toBe(2);
  });

  it("matches by area, so a city name shared across borders does not mislead it", () => {
    // Vancouver, WA is in the US; the target is Vancouver, BC.
    expect(preferredLocationIndex(["Vancouver, WA, USA", "Toronto, ON, Canada"], ["Vancouver, BC"])).toBe(1);
  });

  it("falls back to the employer's first real option, skipping blank placeholder rows", () => {
    const options = ["  ", "New York, NY, USA", "Austin, TX, USA"];

    expect(preferredLocationIndex(options, ["Toronto, ON"])).toBe(1);
    expect(preferredLocationIndex(options, [])).toBe(1);
  });

  it("returns -1 when nothing usable is offered", () => {
    expect(preferredLocationIndex([], ["San Francisco Bay Area"])).toBe(-1);
    expect(preferredLocationIndex(["", "   "], ["San Francisco Bay Area"])).toBe(-1);
  });
});

describe("googleStage", () => {
  it.each([
    [`${GOOGLE_APPLY}/form`, "profile"],
    [`${GOOGLE_APPLY}/role`, "role"],
    [`${GOOGLE_APPLY}/vsi`, "vsi"],
    [`${GOOGLE_APPLY}/review?hl=en`, "review"],
    [`${GOOGLE_APPLY}/`, "other"],
    ["https://www.google.com/about/careers/applications/jobs/results/123456789", "other"],
  ])("places %s at the %s step", (url, stage) => {
    expect(googleStage(url)).toBe(stage);
  });
});

describe("googleConfirmed", () => {
  it("accepts Google's thank-you copy after the final Apply", () => {
    expect(googleConfirmed("Thanks for applying! We'll be in touch about next steps.", GOOGLE_AFTER_APPLY)).toBe(true);
  });

  it("accepts the applications dashboard even without confirmation copy", () => {
    const url = "https://www.google.com/about/careers/applications/dashboard";

    expect(googleConfirmed("My applications\nSenior Security Engineer, Cloud", url)).toBe(true);
  });

  it("never reads the review step as confirmed, whatever it says", () => {
    // Apply has not been pressed yet on the review step.
    expect(googleConfirmed("Review your application. Thanks for applying!", `${GOOGLE_APPLY}/review`)).toBe(false);
  });

  it("falls back to the shared confirmation detector", () => {
    expect(googleConfirmed("Your application has been received.", GOOGLE_AFTER_APPLY)).toBe(true);
  });

  it("does not confirm a step that still asks for input", () => {
    expect(googleConfirmed("Please answer all required questions before continuing.", `${GOOGLE_APPLY}/role`)).toBe(false);
  });

  it("does not confirm a page that refuses the submission", () => {
    expect(googleConfirmed("We couldn't submit your application. Please try again.", GOOGLE_AFTER_APPLY)).toBe(false);
  });

  it("does not read an incomplete application as one that went in", () => {
    // "your application is in" is the start of "incomplete" too.
    expect(googleConfirmed("Your application is incomplete. Please complete all required sections.", `${GOOGLE_APPLY}/form`)).toBe(false);
  });

  it("lets a stated refusal win over thank-you copy", () => {
    expect(googleConfirmed("Thanks for applying! Your application was not submitted. Please try again.", GOOGLE_AFTER_APPLY)).toBe(false);
  });
});

describe("metaConfirmed", () => {
  it("accepts Meta's confirmation copy, even on the application form URL", () => {
    expect(metaConfirmed("Thanks for applying! Your application was sent to the hiring team.", META_FORM)).toBe(true);
  });

  it("counts only Meta's own wording while still on the application form", () => {
    // Draft-state copy like this would otherwise satisfy the shared detector.
    expect(metaConfirmed("Your application is in progress. Continue editing below.", META_FORM)).toBe(false);
  });

  it.each(["https://www.metacareers.com/profile/applications", "https://www.metacareers.com/profile/job_applications/"])(
    "accepts Meta's applications list as confirmation: %s",
    (url) => {
      expect(metaConfirmed("Applications", url)).toBe(true);
    },
  );

  it("falls back to the shared detector away from the application form", () => {
    expect(metaConfirmed("Your application has been received.", META_POSTING)).toBe(true);
  });

  it("does not confirm a page with no confirmation signal", () => {
    expect(metaConfirmed("Security Engineer, Product Security. Apply now", META_POSTING)).toBe(false);
    expect(metaConfirmed("Tell us about your experience", META_FORM)).toBe(false);
  });

  it("does not read an incomplete application or a refusal as confirmed", () => {
    expect(metaConfirmed("Your application is incomplete.", META_POSTING)).toBe(false);
    expect(metaConfirmed("Thanks for applying! Your application was not submitted. Please try again.", META_FORM)).toBe(false);
  });
});

describe("resumeUploadName", () => {
  const resumePath = "/resumes/jane-doe-ai-security.pdf";

  it("names the upload after the candidate rather than the tailored variant", () => {
    // Recruiters see the file name, and a variant's name advertises the tailoring.
    const answers = [answer("First name", "Jane"), answer("Last name", "Doe")];

    expect(resumeUploadName({ resumePath, answers })).toBe("Jane_Doe_Resume.pdf");
  });

  it("matches decorated labels and strips characters that do not belong in a file name", () => {
    const answers = [answer("First Name*", " Zoë Ann "), answer("Last name (required)", "O'Doe-Smith")];

    expect(resumeUploadName({ resumePath, answers })).toBe("ZoëAnn_ODoe-Smith_Resume.pdf");
  });

  it("keeps the resume's own extension, lower-cased, and assumes PDF without one", () => {
    const answers = [answer("First name", "Jane"), answer("Last name", "Doe")];

    expect(resumeUploadName({ resumePath: "/resumes/jane-doe.DOCX", answers })).toBe("Jane_Doe_Resume.docx");
    expect(resumeUploadName({ resumePath: "/resumes/jane-doe", answers })).toBe("Jane_Doe_Resume.pdf");
  });

  it("keeps the file's own name when either name is missing or unusable", () => {
    expect(resumeUploadName({ resumePath, answers: [answer("First name", "Jane")] })).toBe("jane-doe-ai-security.pdf");
    expect(resumeUploadName({ resumePath, answers: [answer("First name", "Jane"), answer("Last name", "!!!")] })).toBe(
      "jane-doe-ai-security.pdf",
    );
  });
});

describe("AMAZON_CONFIRMATION", () => {
  it.each([
    "Your application has been submitted.",
    "Application submitted",
    "Thank you for applying!",
    "Thank you for your application to Amazon.",
    "You've successfully applied to Security Engineer, AWS Identity.",
    "You have applied for this job.",
    "We've received your application.",
  ])("recognizes %j", (text) => {
    expect(AMAZON_CONFIRMATION.test(text)).toBe(true);
  });

  it.each([
    "Submit application",
    "Review your application before you submit it.",
    "Your application was not submitted.",
    "Your application is incomplete.",
  ])("does not read %j as a confirmation", (text) => {
    expect(AMAZON_CONFIRMATION.test(text)).toBe(false);
  });
});
