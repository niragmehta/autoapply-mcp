import { describe, expect, it } from "vitest";
import {
  assessExperience,
  candidateYears,
  candidateYearsFromProfile,
  experienceFlags,
  extractRequiredYears,
} from "../src/hygiene/experienceYears.js";
import { makeCampaign, makeJob, makeProfile } from "./factories.js";

describe("extractRequiredYears", () => {
  it("reads the common phrasings", () => {
    expect(extractRequiredYears("Requirements:\n- 5+ years of software engineering experience").minYears).toBe(5);
    expect(extractRequiredYears("You have a minimum of 7 years of professional experience.").minYears).toBe(7);
    expect(extractRequiredYears("At least three years of experience building APIs is required.").minYears).toBe(3);
    expect(extractRequiredYears("Must have 4-6 years of experience in backend systems.")).toMatchObject({ minYears: 4, maxYears: 6 });
    expect(extractRequiredYears("We need 8 or more years of experience leading teams.").minYears).toBe(8);
    expect(extractRequiredYears("Requires five (5) years' experience in security.").minYears).toBe(5);
    expect(extractRequiredYears("Minimum qualifications:\n- Between 3 and 5 years of relevant experience").minYears).toBe(3);
  });

  it("returns the matched sentence and the cue that decided it", () => {
    const result = extractRequiredYears("What you'll bring:\n- 6+ years building distributed systems in production.");
    expect(result).toMatchObject({ minYears: 6, status: "stated", confident: true });
    expect(result.sentence).toContain("6+ years building distributed systems");
    expect(result.mentions[0]?.cue).toMatch(/bring/i);
  });

  it("separates required from preferred by cue and by heading", () => {
    const text = [
      "Requirements",
      "- 5+ years of experience with Python",
      "Nice to have",
      "- 10+ years of experience in fintech",
    ].join("\n");
    const result = extractRequiredYears(text);
    expect(result.minYears).toBe(5);
    expect(result.mentions.map((mention) => mention.kind)).toEqual(["required", "preferred"]);
    expect(extractRequiredYears("8+ years of experience preferred.").status).toBe("preferred-only");
    expect(extractRequiredYears("5+ years required; ideally 8+ years of experience.").minYears).toBe(5);
  });

  it("takes the most lenient required bar", () => {
    const text = "Qualifications:\n- BS with 7+ years of experience, or MS with 5+ years of experience";
    expect(extractRequiredYears(text).minYears).toBe(5);
  });

  it("ignores figures that are not about the candidate", () => {
    for (const sentence of [
      "Founded 20 years ago, we are a leader in payments.",
      "Benefits include a sabbatical after 5 years of service.",
      "Requirements: a 4-year degree in Computer Science.",
      "You will mentor engineers with 10+ years of experience.",
      "Equity vests over 4 years.",
      "Requirements: up to 10 years of experience.",
      "Our team has a combined 15 years of experience in security.",
    ]) {
      expect(extractRequiredYears(sentence).minYears, sentence).toBeNull();
    }
  });

  it("does not let a sub-requirement lower the bar", () => {
    const text = "Requirements: 8+ years of engineering experience, including 2 years leading teams.";
    expect(extractRequiredYears(text).minYears).toBe(8);
  });

  it("marks a bar with an equivalent route as not confident", () => {
    const text = "Requirements: 6+ years of experience or an equivalent combination of education and experience.";
    expect(extractRequiredYears(text)).toMatchObject({ minYears: 6, confident: false });
  });

  it("calls a figure outside any section unclear", () => {
    expect(extractRequiredYears("The ideal person has 5+ years of experience shipping software.")).toMatchObject({
      minYears: 5,
      status: "unclear",
      confident: false,
    });
  });

  it("skips legal and benefits sections", () => {
    const text = "Benefits\n- 401k match after 1 year of employment\nEqual Opportunity\n- We consider applicants with 2 years of experience equally.";
    expect(extractRequiredYears(text).minYears).toBeNull();
  });
});

describe("candidate years", () => {
  const now = new Date("2026-11-01T00:00:00Z");

  it("excludes internships and counts overlapping roles once", () => {
    const profile = makeProfile({
      experience: [
        { company: "A", title: "Software Engineer", start: "2020-01", end: "2023-01", highlights: [] },
        { company: "B", title: "Consultant", start: "2022-01", end: "2024-01", highlights: [] },
        { company: "C", title: "Security Engineer", start: "2024-01", end: "present", highlights: [] },
        { company: "D", title: "Software Engineering Intern", start: "2019-05", end: "2019-08", highlights: [] },
      ],
    });
    const years = candidateYearsFromProfile(profile, now);
    expect(years.years).toBe(6.8);
    expect(years.detail).toMatch(/1 internship\(s\) excluded/);
  });

  it("prefers the campaign's configured figure", () => {
    const campaign = makeCampaign({ hygiene: { experience: { candidateYears: 11 } } });
    expect(candidateYears(makeProfile(), campaign, now)).toMatchObject({ years: 11, source: "campaign" });
  });
});

describe("assessExperience", () => {
  const now = new Date("2026-11-01T00:00:00Z");
  const job = makeJob({ descriptionText: "Requirements:\n- 10+ years of software engineering experience." });

  it("measures the gap against the tolerance and only rejects when enforced", () => {
    const campaign = makeCampaign({ hygiene: { experience: { candidateYears: 6, toleranceYears: 1.5 } } });
    const assessment = assessExperience(job, campaign, makeProfile(), now);
    expect(assessment).toMatchObject({ gap: 4, overTolerance: true, rejects: false });
    expect(experienceFlags(assessment)).toEqual(["years-required:10", "years-over-tolerance"]);

    const strict = makeCampaign({ hygiene: { experience: { candidateYears: 6, enforce: true } } });
    expect(assessExperience(job, strict, makeProfile(), now).rejects).toBe(true);
  });

  it("flags only the stated bar when it is within reach", () => {
    const campaign = makeCampaign({ hygiene: { experience: { candidateYears: 9.5 } } });
    expect(experienceFlags(assessExperience(job, campaign, makeProfile(), now))).toEqual(["years-required:10"]);
    expect(experienceFlags(assessExperience(makeJob({ descriptionText: "No years here." }), campaign, makeProfile(), now))).toEqual([]);
  });
});
