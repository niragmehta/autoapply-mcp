/** A fictional profile with facts carrying figures, for the career API tests. */
export const CAREER_PROFILE = {
  skills: [
    { name: "Python", level: "strong" },
    { name: "Open Policy Agent", aliases: ["OPA"], level: "expert" },
  ],
  facts: [
    {
      id: "guardrails",
      statement: "Built an AI guardrail framework enforcing policy, adopted by 12 product teams.",
      metrics: ["12 product teams"],
      tags: ["ai security", "guardrails", "policy"],
    },
    {
      id: "incident",
      statement: "Led the response to a credential leak and cut time to remediate from 6 hours to 45 minutes.",
      metrics: ["6 hours to 45 minutes"],
      tags: ["incident response", "leadership"],
    },
  ],
};
