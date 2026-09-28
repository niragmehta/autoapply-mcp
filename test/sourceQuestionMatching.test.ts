import { describe, expect, it } from "vitest";
import { buildFillPlan, matchFields, optionSearchCandidates, type FieldDescriptor } from "../src/submission/formFields.js";
import type { DraftAnswer } from "../src/domain/job.js";

const sourceLabel = "How did you hear about this job opportunity?";
const website: DraftAnswer = {
  questionKey: "website", label: "Website", answer: "https://www.linkedin.com/in/example/",
  source: "profile", citation: "profile.answers.website", requiresHuman: false,
  required: false, category: "contact",
};

function sourceField(type: FieldDescriptor["type"] = "select"): FieldDescriptor {
  return { selectorIndex: 0, label: sourceLabel, name: "website", type, required: true };
}

describe("source-question answer boundaries", () => {
  it.each(["select", "radio", "checkbox"] as const)(
    "does not use a personal website answer for a source %s named website", (type) => {
      const field = { ...sourceField(type), ...(type === "select" ? {} : { optionLabel: "LinkedIn" }) };
      expect(matchFields([field], [website])[0]?.answer).toBeNull();
    },
  );

  it("leaves the complete source checkbox group unresolved instead of choosing LinkedIn from a URL", () => {
    const fields: FieldDescriptor[] = [
      { ...sourceField("checkbox"), groupKey: "heard", optionLabel: "Fluidstack Website" },
      { ...sourceField("checkbox"), selectorIndex: 1, name: "linkedin", groupKey: "heard", optionLabel: "LinkedIn" },
    ];
    const plan = buildFillPlan(fields, [website]);
    expect(plan.toFill).toEqual([]);
    expect(plan.unmatchedRequired.map((field) => field.label)).toContain(sourceLabel);
  });

  it.each(["Source", "Application source", "Recruiting source"])(
    "protects the short source label %s from personal links", (label) => {
      expect(matchFields([{ ...sourceField(), label }], [website])[0]?.answer).toBeNull();
    },
  );

  it("does not reintroduce a rejected source-URL answer during option-group fallback", () => {
    const fields: FieldDescriptor[] = [
      { ...sourceField("checkbox"), label: "Source", groupKey: "heard", optionLabel: "LinkedIn" },
      { ...sourceField("checkbox"), label: "Source", selectorIndex: 1, groupKey: "heard", optionLabel: "Other" },
    ];
    const plan = buildFillPlan(fields, [{ ...website, label: "Source URL" }]);
    expect(plan.toFill).toEqual([]);
    expect(plan.unmatchedRequired.map((field) => field.label)).toContain("Source");
  });

  it.each(["How did you hear about us?", "Source", "Referral source", "Application source"])(
    "preserves the explicit source answer labeled %s", (label) => {
      const source: DraftAnswer = { ...website, questionKey: "source", label, answer: "Company website", category: "employer-specific" };
      const field = { ...sourceField(), name: "source" };
      expect(matchFields([field], [website, source])[0]?.answer).toBe(source);
    },
  );

  it("continues to fill a real personal website field", () => {
    const field: FieldDescriptor = { selectorIndex: 0, label: "Website", name: "website", type: "text", required: false };
    expect(matchFields([field], [website])[0]?.answer).toBe(website);
  });
});

describe("source fallback never asserts an unclaimed referral", () => {
  const careersPage: DraftAnswer = {
    questionKey: "discovered_source", label: "How did you hear about us?", answer: "Careers page",
    source: "human", citation: "provided via set_application_content", requiresHuman: true,
    required: true, category: "employer-specific",
  };

  it("offers no friend or referral option for an impersonal approved answer", () => {
    const candidates = optionSearchCandidates(sourceField(), careersPage);
    expect(candidates).toContain("Careers page");
    expect(candidates.some((candidate) => /friend|referr/i.test(candidate))).toBe(false);
  });

  it("cannot substring-match an Employee Referral option from Careers page", () => {
    const candidates = optionSearchCandidates(sourceField(), careersPage);
    expect(candidates.some((candidate) => "employee referral".includes(candidate.toLowerCase()))).toBe(false);
  });

  it("still offers referral wording when the approved answer itself states one", () => {
    const referred = { ...careersPage, answer: "Employee referral" };
    expect(optionSearchCandidates(sourceField(), referred)).toContain("Referral");
  });

  it("does not substitute a named channel for a different approved channel", () => {
    expect(optionSearchCandidates(sourceField(), careersPage)).not.toContain("LinkedIn");
  });

  it("still uses LinkedIn when that is the approved answer", () => {
    expect(optionSearchCandidates(sourceField(), { ...careersPage, answer: "LinkedIn" })).toContain("LinkedIn");
  });
});
