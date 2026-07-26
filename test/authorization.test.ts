import { describe, expect, it } from "vitest";
import { draftAnswers, type FormQuestion } from "../src/drafting/answers.js";
import { joinTopics, renderTemplate, resolveNarrative } from "../src/drafting/narrative.js";
import { evaluateWorkAuthorizationGate, evaluateGates } from "../src/ranking/gates.js";
import { scoreJob } from "../src/ranking/score.js";
import { ProfileSchema } from "../src/domain/profile.js";
import { makeCampaign, makeJob, makeProfile } from "./factories.js";

const campaign = makeCampaign();

/** A Canadian who can use TN in the US: no sponsorship, not yet authorized. */
function tnProfile() {
  const base = makeProfile();
  return ProfileSchema.parse({
    ...base,
    workAuthorization: {
      citizenships: ["Canada"],
      authorizedIn: ["CA"],
      noSponsorshipRequiredIn: ["US"],
      requiresSponsorshipIn: [],
      statement: "Canadian citizen; TN eligible for US roles.",
      alwaysReviewManually: false,
    },
    answers: [
      {
        key: "visa-sponsorship",
        label: "Require visa sponsorship",
        patterns: ["require visa sponsorship", "require sponsorship"],
        answer: "No",
        allowAutoFill: true,
      },
      {
        key: "us-auth-now",
        label: "Currently authorized in the US",
        patterns: ["currently authorized to work in the u"],
        answer: "",
        allowAutoFill: false,
      },
    ],
    narratives: [
      {
        key: "why-company",
        label: "Why this company?",
        patterns: ["why {company}", "why do you want to work"],
        template: "I build security systems. {company}'s work on {topics} matches that, and {role} is the fit.",
        allowAutoFill: true,
        minTopics: 1,
      },
    ],
  });
}

function question(label: string, overrides: Partial<FormQuestion> = {}): FormQuestion {
  return { key: label.toLowerCase().replace(/\W+/g, "_"), label, required: false, type: "input_text", ...overrides };
}

describe("no-sponsorship-required work authorization", () => {
  const profile = tnProfile();

  it("no longer gates out US roles that decline to sponsor", () => {
    const job = makeJob({
      country: "US",
      descriptionText: "We are unable to sponsor or take over sponsorship of an employment visa at this time.",
    });
    expect(evaluateWorkAuthorizationGate(job, profile).passed).toBe(true);
  });

  it("still gates out roles requiring US citizenship", () => {
    const job = makeJob({
      country: "US",
      descriptionText: "Applicants must be a U.S. citizen due to federal contract requirements.",
    });
    const result = evaluateWorkAuthorizationGate(job, profile);
    expect(result.passed).toBe(false);
    expect(result.rule).toBe("citizenship-required");
  });

  it("still gates out roles requiring a security clearance", () => {
    const job = makeJob({ descriptionText: "Must hold an active TS/SCI security clearance." });
    expect(evaluateGates(job, { campaign, profile }).rule).toBe("clearance-required");
  });

  it("scores US roles near parity rather than penalising them", () => {
    const result = scoreJob(makeJob({ country: "US" }), campaign, profile);
    const component = result.components.find((entry) => entry.dimension === "workAuthorization");
    expect(component!.earned).toBeCloseTo(campaign.scoring.weights.workAuthorization * 0.9);
    expect(result.flags).toContain("work-authorization-via-treaty");
    expect(result.flags).not.toContain("requires-work-authorization");
  });

  it("auto-fills the sponsorship question from the approved answer", () => {
    const { answers } = draftAnswers([question("Do you require visa sponsorship?")], profile, campaign);
    expect(answers[0]?.answer).toBe("No");
    expect(answers[0]?.requiresHuman).toBe(false);
    expect(answers[0]?.citation).toBe("profile.answers.visa-sponsorship");
  });

  it("prefers the most specific pattern over a generic one", () => {
    const p = ProfileSchema.parse({
      ...profile,
      answers: [
        { key: "generic", label: "Generic sponsorship", patterns: ["require sponsorship"], answer: "No", allowAutoFill: true },
        {
          key: "named-tn",
          label: "Sponsorship naming TN",
          patterns: ["require sponsorship (e.g., h-1b, e-3, tn"],
          answer: "Yes",
          allowAutoFill: true,
        },
      ],
    });
    const generic = draftAnswers([question("Will you require sponsorship now or in the future?")], p, campaign);
    expect(generic.answers[0]?.answer).toBe("No");

    const specific = draftAnswers(
      [question("Will you require sponsorship (e.g., H-1B, E-3, TN, O-1) to maintain eligibility?")],
      p,
      campaign,
    );
    expect(specific.answers[0]?.answer).toBe("Yes");
    expect(specific.answers[0]?.citation).toBe("profile.answers.named-tn");
  });

  it("never auto-fills an approved answer that is blank", () => {
    const { answers } = draftAnswers([question("Are you currently authorized to work in the U.S.?")], profile, campaign);
    expect(answers[0]?.answer).toBe("");
    expect(answers[0]?.requiresHuman).toBe(true);
  });

  it("keeps sponsorship questions manual when the profile says to review them", () => {
    const strict = ProfileSchema.parse({
      ...profile,
      workAuthorization: { ...profile.workAuthorization, alwaysReviewManually: true },
    });
    const { answers } = draftAnswers([question("Do you require visa sponsorship?")], strict, campaign);
    expect(answers[0]?.requiresHuman).toBe(true);
  });
});

describe("narrative templates", () => {
  const profile = tnProfile();
  const context = { company: "Anthropic", role: "Staff Security Engineer", location: "SF", topics: ["ai security", "guardrail", "policy"] };

  it("renders company, role and topics into the template", () => {
    const result = resolveNarrative("Why Anthropic?", profile, context);
    expect(result?.answer).toContain("Anthropic's work on");
    expect(result?.answer).toContain("ai security, guardrail and policy");
    expect(result?.answer).toContain("Staff Security Engineer");
    expect(result?.authorized).toBe(true);
  });

  it("matches a generic phrasing as well as the company-specific one", () => {
    expect(resolveNarrative("Why do you want to work here?", profile, context)).not.toBeNull();
  });

  it("declines to render when the posting yields no matched topics", () => {
    expect(resolveNarrative("Why Anthropic?", profile, { ...context, topics: [] })).toBeNull();
  });

  it("returns null for unrelated questions", () => {
    expect(resolveNarrative("What is your notice period?", profile, context)).toBeNull();
  });

  it("answers the essay question through draftAnswers when context is supplied", () => {
    const q = question("Why Anthropic?", { type: "textarea" });
    const withContext = draftAnswers([q], profile, campaign, context);
    expect(withContext.answers[0]?.requiresHuman).toBe(false);
    expect(withContext.answers[0]?.category).toBe("narrative");

    // Without job context the same question stays with a human.
    const withoutContext = draftAnswers([q], profile, campaign);
    expect(withoutContext.answers[0]?.requiresHuman).toBe(true);
    expect(withoutContext.answers[0]?.category).toBe("essay");
  });
});

describe("joinTopics and renderTemplate", () => {
  it("formats topic lists as prose", () => {
    expect(joinTopics([])).toBe("");
    expect(joinTopics(["a"])).toBe("a");
    expect(joinTopics(["a", "b"])).toBe("a and b");
    expect(joinTopics(["a", "b", "c", "d"])).toBe("a, b and c");
  });

  it("tidies whitespace left by empty slots", () => {
    const out = renderTemplate("{company} does {topics} . Nice", { company: "X", role: "", location: "", topics: [] });
    expect(out).toBe("X does. Nice");
  });
});
