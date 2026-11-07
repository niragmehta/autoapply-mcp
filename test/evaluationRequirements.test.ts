import { describe, expect, it } from "vitest";
import { buildEvidenceContext, evidenceFor } from "../src/evaluation/evidence.js";
import { keywordCoverage } from "../src/evaluation/keywords.js";
import { extractRequirements } from "../src/evaluation/requirements.js";
import { analyzeSkillGap } from "../src/evaluation/skillGap.js";
import { makeCampaign, makeProfile } from "./factories.js";
import { SAMPLE_JD } from "./hygieneFixtures.js";

describe("extractRequirements", () => {
  it("reads items, importance bands and their sources", () => {
    const parsed = extractRequirements(SAMPLE_JD);
    expect(parsed.sections.map((section) => section.kind)).toEqual(["about", "responsibilities", "requirements", "preferred", "benefits"]);
    expect(parsed.responsibilities).toHaveLength(2);
    const byText = new Map(parsed.items.map((item) => [item.text, item]));
    expect(byText.get("5+ years of software engineering experience")).toMatchObject({ importance: "required", weightSource: "structure", signal: "Requirements" });
    expect(byText.get("You must be authorized to work in the United States")).toMatchObject({ importance: "required", weightSource: "jd-wording", signal: "must" });
    expect(byText.get("Experience with Terraform")).toMatchObject({ importance: "bonus", weightSource: "structure" });
    expect(byText.get("Familiarity with Rust is a plus")).toMatchObject({ importance: "bonus", weightSource: "jd-wording" });
    expect(parsed.items.map((item) => item.id)).toEqual(parsed.items.map((_item, index) => `r${index + 1}`));
  });

  it("never estimates a requirement as required", () => {
    const parsed = extractRequirements("Join us! You have experience with Kafka. You bring a track record of shipping. We value curiosity.");
    expect(parsed.items.length).toBe(2);
    expect(parsed.items.every((item) => item.weightSource === "estimate" && item.importance === "preferred")).toBe(true);
  });

  it("keeps every required item before the budget trims others", () => {
    const text = ["Requirements", ...Array.from({ length: 6 }, (_v, i) => `- Required skill number ${i} with depth`), "Preferred", "- Preferred skill one here", "- Preferred skill two here"].join("\n");
    const parsed = extractRequirements(text, { maxItems: 6 });
    expect(parsed.items).toHaveLength(6);
    expect(parsed.items.every((item) => item.importance === "required")).toBe(true);
    expect(parsed.truncated).toBe(2);
  });
});

describe("evidence, skill gap and keywords", () => {
  const profile = makeProfile();
  const parsed = extractRequirements(SAMPLE_JD);
  const context = buildEvidenceContext(profile, { country: "US" }, { candidateYears: 5.7, toleranceYears: 1.5 });
  const tierOf = (text: string) => evidenceFor({ text }, context);

  it("cites skills, years and siblings, and admits gaps", () => {
    expect(tierOf("5+ years of software engineering experience")).toMatchObject({ tier: "direct", citations: [expect.objectContaining({ kind: "years" })] });
    expect(tierOf("8+ years of software engineering experience")).toMatchObject({ tier: "none" });
    expect(tierOf("7 years of experience").tier).toBe("adjacent");
    expect(tierOf("Expert in Python").citations[0]).toMatchObject({ kind: "skill", ref: "Python", strength: "direct" });
    expect(tierOf("Strong experience with Python and Kubernetes").tier).toBe("adjacent");
    expect(tierOf("Experience with AWS or GCP")).toMatchObject({ tier: "adjacent", citations: [expect.objectContaining({ ref: "Azure" })] });
    expect(tierOf("Experience with Terraform").tier).toBe("none");
  });

  it("matches facts by tags and shared technology", () => {
    const result = tierOf("Experience building AI security guardrails with policy engines");
    expect(result.tier).toBe("direct");
    expect(result.citations.some((citation) => citation.kind === "fact" && citation.ref === "guardrails")).toBe(true);
  });

  it("handles degrees and work authorization honestly", () => {
    expect(tierOf("BS in Computer Science or equivalent experience")).toMatchObject({ tier: "adjacent" });
    expect(tierOf("BS in Computer Science required")).toMatchObject({ tier: "none", note: expect.stringContaining("no degree") });
    const graduate = buildEvidenceContext(
      makeProfile({ education: [{ institution: "Example University", credential: "BSc", field: "Computer Science" }] }),
      { country: "US" },
      { candidateYears: 5.7, toleranceYears: 1.5 },
    );
    expect(evidenceFor({ text: "BS in Computer Science" }, graduate)).toMatchObject({ tier: "direct", citations: [expect.objectContaining({ kind: "education" })] });
    expect(tierOf("You must be authorized to work in the United States")).toMatchObject({ tier: "none", note: expect.stringContaining("US") });
    const canadian = buildEvidenceContext(profile, { country: "CA" }, { candidateYears: 5.7, toleranceYears: 1.5 });
    expect(evidenceFor({ text: "Must be authorized to work in Canada" }, canadian).tier).toBe("direct");
  });

  it("buckets the posting's skills as existing, supported or gap, with importance", () => {
    const gap = analyzeSkillGap(SAMPLE_JD, parsed.items, profile, "Acme");
    expect(gap.existing.map((entry) => entry.term)).toEqual(expect.arrayContaining(["Python", "threat modeling"]));
    const gapTerms = new Map(gap.gap.map((entry) => [entry.term, entry]));
    expect(gapTerms.get("Kubernetes")?.importance).toBe("required");
    expect(gapTerms.get("Terraform")?.importance).toBe("bonus");
    expect(gapTerms.get("Go")?.importance).toBeNull();
    expect(gap.gap[0]?.importance).toBe("required");
  });

  it("reports a supported skill that is not listed", () => {
    const withFact = makeProfile({
      facts: [{ id: "k8s", statement: "Migrated 40 services to Kubernetes on GKE.", tags: ["platform"] }],
    });
    const gap = analyzeSkillGap(SAMPLE_JD, parsed.items, withFact, "Acme");
    expect(gap.supportedByProfile.find((entry) => entry.term === "Kubernetes")?.citations[0]?.ref).toBe("k8s");
  });

  it("weights keyword coverage and separates safe from unsupported gaps", () => {
    const coverage = keywordCoverage({
      title: "Senior Security Engineer",
      jdText: SAMPLE_JD,
      requirements: parsed.items,
      responsibilities: parsed.responsibilities,
      profile,
      campaign: makeCampaign(),
      companyName: "Acme",
    });
    expect(coverage.document).toBe("profile");
    expect(coverage.present).toContain("Python");
    expect(coverage.missingUnsupported).toContain("Kubernetes");
    expect(coverage.coveragePercent).toBeGreaterThan(0);
    expect(coverage.coveragePercent).toBeLessThan(100);

    const resume = keywordCoverage({
      title: "Senior Security Engineer",
      jdText: SAMPLE_JD,
      requirements: parsed.items,
      responsibilities: parsed.responsibilities,
      profile,
      campaign: makeCampaign(),
      resumeText: "Alex Candidate. Security engineer.",
    });
    expect(resume.document).toBe("resume-text");
    expect(resume.missingSupported).toContain("Python");
  });
});
