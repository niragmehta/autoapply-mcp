import { describe, expect, it } from "vitest";
import { resolveExperience } from "../src/drafting/experience.js";
import { ProfileSchema } from "../src/domain/profile.js";
import { makeProfile } from "./factories.js";

/**
 * Boards ask "do you have N years of experience" at every threshold from three
 * to ten, and GitLab asks two different ones on the same form, so no single
 * stored answer can be right. The profile states the dates, so the answer is
 * arithmetic rather than a judgement.
 */
describe("years-of-experience thresholds", () => {
  const start = new Date();
  start.setFullYear(start.getFullYear() - 6);
  const sixYears = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;

  const profile = ProfileSchema.parse({
    ...makeProfile(),
    experience: [
      { company: "Microsoft", title: "Software Engineer II", start: sixYears, end: "present", summary: "", highlights: [] },
      { company: "Microsoft", title: "Software Engineer Intern", start: "2019-06", end: "2019-08", summary: "", highlights: [] },
    ],
  });

  const answer = (label: string) => resolveExperience(label, profile)?.answer ?? null;

  it("says yes below the threshold it clears", () => {
    expect(answer("Do you have over 5 years of professional software engineering experience?")).toBe("Yes");
    expect(answer("Do you have 3+ years of engineering experience?")).toBe("Yes");
  });

  it("says no above it, rather than claiming years he does not have", () => {
    expect(answer("Do you have over 7 years of professional software engineering experience?")).toBe("No");
    expect(answer("8+ years of industry experience?")).toBe("No");
  });

  it("counts only full-time work, so an internship cannot tip a threshold", () => {
    // Six years full time plus a summer internship. Counting the internship
    // would answer the seven-year question differently.
    expect(answer("Do you have over 6 years of professional experience?")).toBe("No");
    expect(answer("Do you have at least 6 years of professional experience?")).toBe("Yes");
  });

  it("leaves a question about one technology to a person", () => {
    // The profile tracks employment dates, not per-technology tenure.
    expect(answer("Do you have 5+ years of experience with Kubernetes?")).toBeNull();
    expect(answer("How many years of experience in Go do you have?")).toBeNull();
  });

  it("ignores a year that is not a length of experience", () => {
    expect(answer("Were you employed here in the last 2 years?")).toBeNull();
  });
});
